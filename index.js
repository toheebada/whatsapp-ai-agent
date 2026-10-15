require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const { extractText, audioFileName, toWhatsApp, splitMessage } = require('./helpers');

process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e));

// ==========================================
// 0. CONFIG (all secrets come from .env or the host's environment settings)
// ==========================================

const REQUIRED = ['GROQ_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'OWNER_NUMBER'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`Missing settings in .env: ${missing.join(', ')}`);
    process.exit(1);
}

const {
    WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, APP_SECRET,
} = process.env;
const OWNER_NUMBER = process.env.OWNER_NUMBER.replace(/\D/g, '');
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v23.0'}`;
const PORT = process.env.PORT || 3000;

// Optional settings. Change them in Render's Environment tab if you want something different.
const BOT_NAME = process.env.BOT_NAME || 'Ayo';
const OWNER_NAME = process.env.OWNER_NAME || 'Toheeb';
const OWNER_CONTEXT = process.env.OWNER_CONTEXT ||
    'He is a student who is a course rep at a nigeria university who runs AET, an academic support group that holds online class sessions and reminds members about upcoming ones. The files he sends are often lecture notes, timetables, past questions and notices.';

const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'auto'; // set to "auto" to let Whisper guess the language
const WHISPER_PROMPT = process.env.WHISPER_PROMPT || 'Nigerian English. Words that may come up: AET, CBT, CGPA, FUTMinna, naira, WhatsApp.';

const HISTORY_LIMIT = 10;
const MAX_TOOL_ROUNDS = 5;
const MAX_FILE_BYTES = 15 * 1024 * 1024;        // biggest file we will download
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;        // biggest image we send to the vision model
const DOC_INLINE_CHARS = Number(process.env.DOC_INLINE_CHARS) || 12000; // how much of a new file the AI sees at once
const DOC_READ_CHARS = Number(process.env.DOC_READ_CHARS) || 12000;     // how much read_document returns per call

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==========================================
// 1. DATABASE TOOL FUNCTIONS
// ==========================================

async function save_note(title, content) {
    console.log(`[SUPABASE] Saving note: ${title}`);
    const { error } = await supabase.from('notes').upsert({ title, content }, { onConflict: 'title' });
    if (error) return `Database error: ${error.message}`;
    return `Successfully saved "${title}" to Supabase notes table.`;
}

async function read_note(title) {
    console.log(`[SUPABASE] Reading note: ${title}`);
    const { data, error } = await supabase
        .from('notes').select('content').ilike('title', title).limit(1).maybeSingle();
    if (error || !data) return `Note "${title}" not found.`;
    return `Content of "${title}":\n\n${data.content}`;
}

async function list_notes() {
    console.log('[SUPABASE] Fetching all notes...');
    const { data, error } = await supabase
        .from('notes').select('title, created_at').order('created_at', { ascending: false });
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return 'No notes found in Supabase.';
    return `Saved Notes in Database:\n${data.map(n => `- ${n.title}`).join('\n')}`;
}

async function add_task(task_description) {
    console.log(`[SUPABASE] Adding task: ${task_description}`);
    const { error } = await supabase.from('tasks').insert([{ task_description, is_completed: false }]);
    if (error) return `Database error: ${error.message}`;
    return `Added task: "${task_description}" to Supabase.`;
}

async function list_tasks(status = 'pending') {
    console.log('[SUPABASE] Fetching tasks...');
    let q = supabase.from('tasks').select('task_description, is_completed').order('created_at', { ascending: true });
    if (status === 'pending') q = q.eq('is_completed', false);
    if (status === 'done') q = q.eq('is_completed', true);
    const { data, error } = await q;
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return `No ${status === 'all' ? '' : status + ' '}tasks found.`;
    return data.map(t => `[${t.is_completed ? 'X' : ' '}] ${t.task_description}`).join('\n');
}

async function complete_task(task_description) {
    console.log(`[SUPABASE] Completing task: ${task_description}`);
    const { data, error } = await supabase
        .from('tasks').select('id, task_description')
        .eq('is_completed', false).ilike('task_description', `%${task_description}%`).limit(1);
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return `No pending task matching "${task_description}".`;
    const { error: upErr } = await supabase.from('tasks').update({ is_completed: true }).eq('id', data[0].id);
    if (upErr) return `Database error: ${upErr.message}`;
    return `Marked done: "${data[0].task_description}".`;
}

// ---------- Reminders (sent to the owner only) ----------
async function set_reminder(message, remind_at) {
    const when = new Date(remind_at);
    if (isNaN(when)) return 'Invalid time. Use ISO format like 2026-10-14T09:00:00+01:00.';
    if (when.getTime() < Date.now() - 60000) return 'That time is already in the past.';
    console.log(`[SUPABASE] Setting reminder for ${when.toISOString()}: ${message}`);
    const { error } = await supabase
        .from('reminders').insert([{ phone_number: OWNER_NUMBER, message, remind_at: when.toISOString() }]);
    if (error) return `Database error: ${error.message}`;
    const shown = when.toLocaleString('en-GB', {
        timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    return `Reminder set for ${shown} (Lagos time): "${message}".`;
}

async function list_reminders() {
    const { data, error } = await supabase
        .from('reminders').select('id, message, remind_at').eq('sent', false).order('remind_at', { ascending: true });
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return 'No upcoming reminders.';
    return data.map(r => {
        const shown = new Date(r.remind_at).toLocaleString('en-GB', {
            timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });
        return `#${r.id} | ${shown} | ${r.message}`;
    }).join('\n');
}

async function cancel_reminder(id) {
    const { data, error } = await supabase
        .from('reminders').delete().eq('id', id).eq('sent', false).select();
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return `No upcoming reminder with id ${id}.`;
    return `Cancelled reminder #${id}.`;
}

// ---------- Expenses ----------
function lagosToday() {
    return new Date(Date.now() + 3600000).toISOString().slice(0, 10); // YYYY-MM-DD in Lagos
}

function periodStart(period) {
    const today = lagosToday();
    if (period === 'today') return today;
    if (period === 'week') { // the last 7 days including today
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 6);
        return d.toISOString().slice(0, 10);
    }
    if (period === 'month') return today.slice(0, 8) + '01';
    return null; // 'all'
}

const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

async function log_expense(amount, category, description, date) {
    const value = Number(amount);
    if (!isFinite(value) || value <= 0) return 'Invalid amount. It must be a positive number.';
    const spent_at = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : lagosToday();
    console.log(`[SUPABASE] Logging expense: ${value} - ${category}`);
    const { data, error } = await supabase
        .from('expenses')
        .insert([{ amount: value, category: String(category).toLowerCase().trim(), description: description || '', spent_at }])
        .select('id').single();
    if (error) return `Database error: ${error.message}`;
    return `Logged ${naira(value)} for ${category} on ${spent_at} (expense #${data.id}).`;
}

async function expense_summary(period = 'month', category) {
    let q = supabase.from('expenses').select('amount, category');
    const start = periodStart(period);
    if (start) q = q.gte('spent_at', start);
    if (category) q = q.ilike('category', category.trim());
    const { data, error } = await q;
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return `No expenses logged for ${period}${category ? ` in ${category}` : ''}.`;

    const byCat = {};
    let total = 0;
    for (const e of data) {
        const amt = Number(e.amount);
        total += amt;
        byCat[e.category] = (byCat[e.category] || 0) + amt;
    }
    const lines = Object.entries(byCat)
        .sort((a, b) => b[1] - a[1])
        .map(([c, v]) => `- ${c}: ${naira(v)}`);
    const label = { today: 'today', week: 'the last 7 days', month: 'this month', all: 'all time' }[period] || period;
    return `Spending for ${label}: ${naira(total)} across ${data.length} entries.\n${lines.join('\n')}`;
}

async function list_expenses(limit = 10) {
    const { data, error } = await supabase
        .from('expenses').select('id, amount, category, description, spent_at')
        .order('spent_at', { ascending: false }).order('id', { ascending: false }).limit(Math.min(Number(limit) || 10, 30));
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return 'No expenses logged yet.';
    return data.map(e => `#${e.id} | ${e.spent_at} | ${naira(e.amount)} | ${e.category}${e.description ? ' | ' + e.description : ''}`).join('\n');
}

async function delete_expense(id) {
    const { data, error } = await supabase.from('expenses').delete().eq('id', id).select();
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return `No expense with id ${id}.`;
    return `Deleted expense #${id}.`;
}

// ---------- Files he sends (PDF, Word, Excel, slides, text) ----------
async function saveDocument(name, mime, content) {
    const { data, error } = await supabase
        .from('documents')
        .insert([{ name, mime_type: mime || '', content, char_count: content.length }])
        .select('id').single();
    if (error) throw new Error(error.message);
    return data.id;
}

async function list_documents(limit = 10) {
    const { data, error } = await supabase
        .from('documents').select('id, name, char_count, created_at')
        .order('created_at', { ascending: false }).limit(Math.min(Number(limit) || 10, 30));
    if (error) return `Database error: ${error.message}`;
    if (!data || data.length === 0) return 'No files saved yet.';
    return data.map(d => {
        const day = new Date(d.created_at).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short' });
        return `#${d.id} | ${d.name} | ${d.char_count} characters | ${day}`;
    }).join('\n');
}

async function read_document(doc, start = 0) {
    const key = String(doc ?? '').trim().replace(/^#/, '');
    let q = supabase.from('documents').select('id, name, content, char_count');
    q = /^\d+$/.test(key)
        ? q.eq('id', Number(key))
        : q.ilike('name', `%${key}%`).order('created_at', { ascending: false });
    const { data, error } = await q.limit(1).maybeSingle();
    if (error) return `Database error: ${error.message}`;
    if (!data) return `No saved file matches "${doc}". Use list_documents to see what is saved.`;
    const from = Math.max(0, Number(start) || 0);
    const slice = data.content.slice(from, from + DOC_READ_CHARS);
    const end = from + slice.length;
    const more = end < data.char_count
        ? `\n[More available. Call read_document again with doc "${data.id}" and start ${end}.]`
        : '\n[End of file.]';
    return `File #${data.id} "${data.name}", characters ${from} to ${end} of ${data.char_count}:\n\n${slice}${more}`;
}

// ---------- Web research (Groq built-in browser search, gpt-oss models only) ----------
async function research(question) {
    console.log(`[RESEARCH] ${question}`);
    try {
        const res = await groq.chat.completions.create({
            model: process.env.GROQ_RESEARCH_MODEL || 'openai/gpt-oss-120b',
            messages: [
                {
                    role: 'system',
                    content: 'You are a careful research assistant. Search the web and cross-check at least two sources when possible. Write like a smart friend explaining it on WhatsApp: the conclusion first, then the key points in short paragraphs, then one line naming your sources by site name. Under 250 words, plain text, no tables, no headings, no em dashes. Say clearly what is uncertain or disputed. Never invent facts. Today is ' +
                        new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric' }) + '.',
                },
                { role: 'user', content: question },
            ],
            tools: [{ type: 'browser_search' }],
            tool_choice: 'required',
            reasoning_effort: 'medium',
            temperature: 0.3,
            max_completion_tokens: 3000,
        });
        const text = toWhatsApp(res.choices[0].message.content || '');
        return text || 'Research returned nothing. Try rephrasing.';
    } catch (e) {
        console.error('[RESEARCH] Failed:', e.message);
        return `Research failed: ${e.message}`;
    }
}

// ---------- Permanent chat memory ----------
async function saveMessageToHistory(phone_number, role, message) {
    const { error } = await supabase.from('chat_history').insert([{ phone_number, role, message }]);
    if (error) console.error('[SUPABASE] History save failed:', error.message);
}

async function fetchRecentHistory(phone_number, limit = HISTORY_LIMIT) {
    const { data, error } = await supabase
        .from('chat_history').select('role, message')
        .eq('phone_number', phone_number)
        .order('created_at', { ascending: false }).limit(limit);
    if (error || !data) return [];
    return data.reverse().map(h => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: h.message,
    }));
}

// ==========================================
// 2. TOOL DESCRIPTIONS FOR GROQ
// ==========================================

const fn = (name, description, properties = {}, required = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
});

const tools = [
    fn('save_note', 'Saves a note directly into the cloud database.',
        { title: { type: 'string' }, content: { type: 'string' } }, ['title', 'content']),
    fn('read_note', 'Reads a saved note from the database by title.',
        { title: { type: 'string' } }, ['title']),
    fn('list_notes', 'Lists all saved notes from the cloud database.'),
    fn('add_task', 'Adds a task item to the cloud task manager.',
        { task_description: { type: 'string' } }, ['task_description']),
    fn('list_tasks', 'Retrieves tasks. Defaults to pending tasks only.',
        { status: { type: 'string', enum: ['pending', 'done', 'all'] } }),
    fn('complete_task', 'Marks a pending task as done. Pass words from the task description.',
        { task_description: { type: 'string' } }, ['task_description']),
    fn('set_reminder', 'Sets a WhatsApp reminder that will be sent to the user at a future time. Work out remind_at from the current time in the system prompt.',
        {
            message: { type: 'string', description: 'What to remind the user about' },
            remind_at: { type: 'string', description: 'ISO 8601 time with the Lagos offset, e.g. 2026-10-14T09:00:00+01:00' },
        }, ['message', 'remind_at']),
    fn('list_reminders', 'Lists upcoming reminders that have not been sent yet.'),
    fn('cancel_reminder', 'Cancels an upcoming reminder by its id from list_reminders.',
        { id: { type: 'integer' } }, ['id']),
    fn('log_expense', 'Logs a spending entry in naira. Use a short lowercase category such as transport, food, data, airtime, school, other.',
        {
            amount: { type: 'number', description: 'Amount in naira' },
            category: { type: 'string' },
            description: { type: 'string', description: 'What it was for' },
            date: { type: 'string', description: 'YYYY-MM-DD, only if the user names a day other than today' },
        }, ['amount', 'category']),
    fn('expense_summary', 'Totals spending for a period, with a breakdown by category. Optionally filter by one category.',
        {
            period: { type: 'string', enum: ['today', 'week', 'month', 'all'], description: 'week means the last 7 days' },
            category: { type: 'string' },
        }),
    fn('list_expenses', 'Lists the most recent expense entries with their ids.',
        { limit: { type: 'integer' } }),
    fn('delete_expense', 'Deletes one expense entry by id, for example to fix a mistake.',
        { id: { type: 'integer' } }, ['id']),
    fn('research', 'Searches the live web and returns a sourced answer. Use it for anything current, factual, comparative or that needs checking: news, prices, rules, people, events, how-to research. Pass the full question with any context.',
        { question: { type: 'string', description: 'The complete research question' } }, ['question']),
    fn('list_documents', 'Lists files the user sent earlier (PDF, Word, Excel, slides, text) that were saved, newest first, with their ids.',
        { limit: { type: 'integer' } }),
    fn('read_document', 'Reads the text of a saved file. Pass its id as a string like "7", or part of its file name. Long files come in pages: pass start to continue where the last page ended.',
        {
            doc: { type: 'string', description: 'Document id or part of the file name' },
            start: { type: 'integer', description: 'Character position to start from, default 0' },
        }, ['doc']),
];

async function runTool(name, args) {
    switch (name) {
        case 'save_note': return save_note(args.title, args.content);
        case 'read_note': return read_note(args.title);
        case 'list_notes': return list_notes();
        case 'add_task': return add_task(args.task_description);
        case 'list_tasks': return list_tasks(args.status);
        case 'complete_task': return complete_task(args.task_description);
        case 'set_reminder': return set_reminder(args.message, args.remind_at);
        case 'list_reminders': return list_reminders();
        case 'cancel_reminder': return cancel_reminder(Number(args.id));
        case 'log_expense': return log_expense(args.amount, args.category, args.description, args.date);
        case 'expense_summary': return expense_summary(args.period, args.category);
        case 'list_expenses': return list_expenses(args.limit);
        case 'delete_expense': return delete_expense(Number(args.id));
        case 'research': return research(args.question);
        case 'list_documents': return list_documents(args.limit);
        case 'read_document': return read_document(args.doc, args.start);
        default: return 'Unknown database tool.';
    }
}

// ==========================================
// 3. GROQ BRAIN
// ==========================================

function systemPrompt() {
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const iso = new Date(Date.now() + 3600000).toISOString().slice(0, 19) + '+01:00';
    return `You are ${BOT_NAME}, ${OWNER_NAME}'s personal assistant. You text with him on WhatsApp, like a sharp, warm friend who works for him. ${OWNER_CONTEXT}

HOW YOU SOUND
- Natural and human. Short messages, plain words, contractions. Not corporate, not robotic.
- Match his mood and language. If he writes casually or in Pidgin, be casual. If he is stressed or focused, stay calm and direct.
- Lead with the answer or the result, then add detail only if it helps. Most replies are one to four short lines.
- Never say "As an AI", "I'd be happy to help", "Certainly" or "Great question". No stacked disclaimers.
- Confirm finished actions the way a person would ("Done, I'll remind you at 3pm", "Saved, that's ₦1,500 on transport"). Include the key detail (time, amount, id) and skip the recap.
- Be warm but honest. If a plan has a hole, a deadline is tight, or he keeps pushing something off, say so plainly and kindly, then help him fix it.
- Use an emoji now and then when it fits, not in every message.
- WhatsApp formatting only: *bold* with single asterisks, _italic_ with underscores. No headings, no tables, no ** and no #. A short list only when you are listing real items.
- Never use em dashes. Use a comma, a full stop or "and".

HOW YOU WORK
- Current date and time in Lagos: ${now} (ISO: ${iso}). Times are Lagos time. Money is in naira.
- Use your tools to save and read notes, manage tasks, set, list and cancel reminders, log and total expenses, research the web, and read files he sent. Reminders only go to him.
- Never claim a tool worked unless it returned a result. Never invent notes, tasks or file contents. If a tool fails, say what happened in one line.
- Messages starting with [Voice note] are what he said out loud, transcribed. Transcription can slip on names, numbers and times. If an amount, time or name that matters sounds doubtful, check it with him before saving, and repeat the key detail when you confirm.
- Messages starting with [File: ...] carry the start of a document he sent. It is saved with an id. If the text says it was cut short, use read_document with start to read further before answering about later parts. For older files, use list_documents and read_document.
- Photos arrive with the message. Describe or read them as he asks. If a photo or file has dates, deadlines or things to do, offer to save them as reminders or tasks.
- When research returns, give him the answer in your own voice: conclusion first, key reasons, then the source names in one line.`;
}

function friendlyError(e) {
    if (e?.code === 'TOO_BIG') return "That file is bigger than I can handle (15 MB max). Send a smaller one, or just the pages that matter.";
    if (e?.status === 429) return "I'm hitting my AI provider's rate limit right now. Give me a minute and send that again.";
    if (e?.status === 413) return "That's too much for me to take in at once. Try a smaller file, or ask about one part of it.";
    return "Something broke on my side while handling that. Send it again in a minute. If it keeps happening, check the logs.";
}

// Turns a voice note into text with Groq's Whisper
async function transcribe(buffer, mime) {
    const file = new File([buffer], audioFileName(mime), { type: String(mime || 'audio/ogg').split(';')[0] });
    const res = await groq.audio.transcriptions.create({
        file,
        model: WHISPER_MODEL,
        temperature: 0,
        prompt: WHISPER_PROMPT,
        ...(WHISPER_LANGUAGE !== 'auto' ? { language: WHISPER_LANGUAGE } : {}),
    });
    return String(res.text || '').trim();
}

// historyText is what gets remembered for next time (the full file text is not stored in chat history)
async function askAI(chatId, prompt, image, historyText) {
    const history = await fetchRecentHistory(chatId);
    const userContent = image
        ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${image.mimetype};base64,${image.data}` } },
        ]
        : prompt;

    const messages = [{ role: 'system', content: systemPrompt() }, ...history, { role: 'user', content: userContent }];
    const model = image ? VISION_MODEL : TEXT_MODEL;
    const effort = prompt.startsWith('[File:') ? 'medium' : 'low';
    let reply = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let res;
        try {
            res = await groq.chat.completions.create({
                model, messages, tools, tool_choice: 'auto', temperature: 0.6, max_tokens: 3000,
                ...(image ? {} : { reasoning_effort: effort }),
            });
        } catch (err) {
            if (err?.error?.error?.code === 'tool_use_failed' && round < MAX_TOOL_ROUNDS - 1) continue;
            throw err;
        }

        const msg = res.choices[0].message;
        messages.push(msg);

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
            reply = msg.content || 'Done.';
            break;
        }

        for (const call of msg.tool_calls) {
            console.log(`[AI TOOL EXECUTED]: ${call.function.name}`);
            let result;
            try {
                const args = JSON.parse(call.function.arguments || '{}');
                result = await runTool(call.function.name, args);
            } catch (e) {
                result = `Tool error: ${e.message}`;
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
        }
    }

    if (!reply) reply = 'I hit my tool limit on that one. Try rephrasing.';
    reply = toWhatsApp(reply); // keep memory clean so the style stays consistent

    await saveMessageToHistory(chatId, 'user', historyText || prompt);
    await saveMessageToHistory(chatId, 'assistant', reply);
    return reply;
}

// ==========================================
// 4. META WHATSAPP CLOUD API
// ==========================================

async function sendText(to, body) {
    const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: String(body).slice(0, 4000) },
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        console.error('[WHATSAPP] Send failed:', res.status, err);
        if (err.includes('131047')) {
            console.error('[WHATSAPP] The 24-hour window is closed. Text the bot first, then try again.');
        }
        return false;
    }
    console.log('[REPLY SENT]');
    return true;
}

// Cleans up the text and sends it as one or more WhatsApp messages
async function sendReply(to, text) {
    let ok = true;
    for (const part of splitMessage(toWhatsApp(text))) {
        ok = (await sendText(to, part)) && ok;
    }
    return ok;
}

// Sends an approved template. Works even when the 24-hour window is closed.
// Template variables cannot contain line breaks, so they are flattened here.
async function sendTemplate(to, name, params = []) {
    const clean = (t) => String(t).replace(/\s*[\r\n\t]+\s*/g, ' | ').replace(/ {2,}/g, ' ').trim().slice(0, 900) || '-';
    const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
                name,
                language: { code: 'en' },
                components: params.length
                    ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: clean(t) })) }]
                    : [],
            },
        }),
    });
    if (!res.ok) {
        console.error('[WHATSAPP] Template send failed:', res.status, await res.text());
        return false;
    }
    console.log(`[WHATSAPP] Template "${name}" sent.`);
    return true;
}

function tooBig() {
    const e = new Error('File too big');
    e.code = 'TOO_BIG';
    return e;
}

async function downloadMedia(mediaId, maxBytes = MAX_FILE_BYTES) {
    const auth = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, { headers: auth });
    const meta = await metaRes.json();
    if (!metaRes.ok || !meta.url) throw new Error(`Media lookup failed: ${JSON.stringify(meta).slice(0, 200)}`);
    if (meta.file_size && Number(meta.file_size) > maxBytes) throw tooBig();
    const file = await fetch(meta.url, { headers: auth });
    if (!file.ok) throw new Error(`Media download failed: ${file.status}`);
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > maxBytes) throw tooBig();
    return { buffer, mimetype: meta.mime_type };
}

// Shows "typing..." and blue ticks while the AI works. Purely cosmetic, so failures are ignored.
function keepTyping(messageId) {
    let stopped = false;
    let warned = false;
    const ping = async () => {
        if (stopped) return;
        try {
            const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    status: 'read',
                    message_id: messageId,
                    typing_indicator: { type: 'text' },
                }),
            });
            if (!res.ok && !warned) {
                warned = true;
                console.warn('[WHATSAPP] Typing indicator failed:', res.status);
            }
        } catch (_) { /* ignore */ }
    };
    ping();
    const timer = setInterval(ping, 20000); // the indicator fades after about 25 seconds
    return () => { stopped = true; clearInterval(timer); };
}

const DEFAULT_IMAGE_PROMPT = 'I sent you this image with no message. Work out what it is and help me with it. If it has text, read it. If it has dates, deadlines or things to do, point them out and offer to save them.';
const DEFAULT_FILE_PROMPT = 'I sent you this file with no message. Tell me briefly what it is and what matters in it. If it has dates, deadlines or things to do, point them out and offer to save them as reminders or tasks.';

async function imageInput(buffer, mimetype, caption) {
    if (buffer.length > MAX_IMAGE_BYTES) {
        return { reply: "That image is too big for me to look at. Send it as a normal photo instead of a file, or crop it a bit." };
    }
    return {
        prompt: caption || DEFAULT_IMAGE_PROMPT,
        image: { mimetype, data: buffer.toString('base64') },
        history: `[Image] ${caption}`.trim(),
    };
}

async function audioInput(buffer, mimetype) {
    let text;
    try {
        text = await transcribe(buffer, mimetype);
    } catch (e) {
        console.error('[VOICE] Transcription failed:', e.message);
        if (e?.status === 429) throw e;
        return { reply: "I couldn't make sense of that voice note. Try sending it again, or type it out." };
    }
    console.log(`[VOICE] Heard: ${text.slice(0, 200)}`);
    if (!text) return { reply: "I couldn't hear anything in that voice note. Try recording it again?" };
    return { prompt: `[Voice note] ${text}`, history: `[Voice note] ${text}` };
}

async function fileInput(doc) {
    const name = doc.filename || 'file';
    const mime = String(doc.mime_type || '').split(';')[0];
    const caption = doc.caption || '';

    const media = await downloadMedia(doc.id);
    // A photo or voice note sent "as a file" still gets treated as a photo or voice note
    if (mime.startsWith('image/')) return imageInput(media.buffer, mime, caption);
    if (mime.startsWith('audio/')) return audioInput(media.buffer, mime);

    const out = await extractText(media.buffer, mime, name);
    if (out.error) return { reply: out.error };

    let id = null;
    try {
        id = await saveDocument(name, mime, out.text);
    } catch (e) {
        console.error('[DOCS] Could not save the file. Did you run documents.sql in Supabase?', e.message);
    }

    const shown = out.text.slice(0, DOC_INLINE_CHARS);
    const cut = shown.length < out.text.length;
    const label = id ? `document #${id}` : 'not saved for later';
    const notes = [];
    if (cut && id) notes.push(`(Cut short here. To read more, call read_document with doc "${id}" and start ${shown.length}.)`);
    if (cut && !id) notes.push('(Cut short here and it could not be saved, so the rest is not available.)');
    if (out.truncated) notes.push(`(The file is very long, so only its first ${out.text.length} of ${out.totalChars} characters were kept.)`);

    const prompt = `[File: ${name}, ${label}, ${out.text.length} characters]
${notes.length ? notes.join('\n') + '\n' : ''}
${shown}
[End of the text shown]

${caption || DEFAULT_FILE_PROMPT}`;
    return { prompt, history: `[File: ${name}, ${label}] ${caption}`.trim() };
}

// Works out what the AI should see for each kind of WhatsApp message
async function buildInput(msg) {
    switch (msg.type) {
        case 'text':
            return { prompt: msg.text.body, history: msg.text.body };
        case 'image': {
            const media = await downloadMedia(msg.image.id);
            return imageInput(media.buffer, [msg.image.mime_type, media.mimetype].find((m) => /^image\//.test(m || '')) || 'image/jpeg', msg.image.caption || '');
        }
        case 'audio': {
            const media = await downloadMedia(msg.audio.id);
            return audioInput(media.buffer, media.mimetype || msg.audio.mime_type);
        }
        case 'document':
            return fileInput(msg.document);
        case 'video':
            return { reply: "I can't watch videos yet. If the audio is what matters, send it as a voice note, or tell me what's in it." };
        case 'reaction':
        case 'sticker':
        case 'unsupported':
            return null; // nothing to answer
        default:
            return { reply: "I can read text, voice notes, photos and files (PDF, Word, Excel, PowerPoint, text). That one is outside what I can do for now." };
    }
}

const seen = new Set(); // Meta retries webhooks, so we skip message ids we already handled

async function processMessage(msg) {
    if (!msg || seen.has(msg.id)) return;
    seen.add(msg.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);

    if (msg.from !== OWNER_NUMBER) {
        console.log('[SECURITY] Ignored a message from a number that is not the owner.');
        return;
    }

    const stopTyping = keepTyping(msg.id);
    try {
        let input;
        try {
            input = await buildInput(msg);
        } catch (e) {
            console.error('[INPUT] Could not read the message:', e.message);
            await sendReply(msg.from, friendlyError(e));
            return;
        }
        if (!input) return;
        if (input.reply) {
            await sendReply(msg.from, input.reply);
            return;
        }

        console.log(`[USER (${msg.from})]: ${input.history.slice(0, 200)}`);

        let reply;
        try {
            // "@c.us" keeps your old chat memory from the whatsapp-web.js days
            reply = await askAI(`${msg.from}@c.us`, input.prompt, input.image, input.history);
        } catch (e) {
            console.error('AI Error:', e);
            reply = friendlyError(e);
        }
        await sendReply(msg.from, reply);
    } finally {
        stopTyping();
    }
}

async function handleWebhook(body) {
    for (const entry of body?.entry || []) {
        for (const change of entry?.changes || []) {
            for (const msg of change?.value?.messages || []) {
                await processMessage(msg).catch((e) => console.error('Message error:', e));
            }
        }
    }
}

// ==========================================
// 5. EXPRESS SERVER
// ==========================================

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send('Assistant is running.'));

// Meta calls this once when you save the webhook in their dashboard
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
});

// Meta calls this for every incoming message
app.post('/webhook', (req, res) => {
    console.log('[WEBHOOK] Meta knocked on the door.');
    if (APP_SECRET) {
        const sig = req.get('x-hub-signature-256') || '';
        const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
        const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
        if (!ok) {
            console.error('[SECURITY] Signature check failed. APP_SECRET in Render is probably wrong.');
            return res.sendStatus(401);
        }
    }
    res.sendStatus(200); // answer Meta immediately, then do the slow AI work
    handleWebhook(req.body).catch((e) => console.error('Webhook error:', e));
});

// ==========================================
// 6. PROACTIVE MESSAGES
// ==========================================

async function sendMorningBriefing() {
    const tasks = await list_tasks('pending');
    const date = new Date().toLocaleDateString('en-GB', {
        timeZone: 'Africa/Lagos', weekday: 'long', day: 'numeric', month: 'long',
    });
    const hello = `Good morning ${OWNER_NAME} ☀️\n${date}.`;
    let body;
    if (tasks.startsWith('Database error')) {
        body = `${hello}\n\nI couldn't read your tasks this morning: ${tasks}`;
    } else if (tasks.startsWith('No ')) {
        body = `${hello}\n\nNothing pending right now. Clean slate, so decide what today is for.`;
    } else {
        body = `${hello}\n\nOn your list:\n${tasks}\n\nPick the one that moves things most and start there.`;
    }
    console.log('[CRON] Sending morning briefing...');
    const sent = await sendText(OWNER_NUMBER, body);
    if (!sent) {
        console.log('[CRON] Free text failed, trying the approved template...');
        const summary = tasks.startsWith('No ') ? 'none, clean slate'
            : tasks.startsWith('Database error') ? 'could not read tasks'
            : tasks;
        await sendTemplate(OWNER_NUMBER, 'morning_briefing', [summary]);
    }
}

// Every day at 8:00 AM Lagos time
cron.schedule('0 8 * * *', () => {
    sendMorningBriefing().catch((e) => console.error('[CRON] Briefing failed:', e));
}, { timezone: 'Africa/Lagos' });

// Every minute: send any reminder that is due. If sending fails (for example the
// 24-hour window is closed) it stays unsent and is retried on the next minute.
let checkingReminders = false;
cron.schedule('* * * * *', async () => {
    if (checkingReminders) return;
    checkingReminders = true;
    try {
        const { data } = await supabase
            .from('reminders').select('id, message')
            .eq('sent', false).lte('remind_at', new Date().toISOString())
            .order('remind_at', { ascending: true }).limit(20);
        for (const r of data || []) {
            const ok = await sendText(OWNER_NUMBER, `⏰ Reminder: ${r.message}`);
            if (ok) await supabase.from('reminders').update({ sent: true }).eq('id', r.id);
        }
    } catch (e) {
        console.error('[CRON] Reminder check failed:', e);
    } finally {
        checkingReminders = false;
    }
}, { timezone: 'Africa/Lagos' });

// Manual trigger for testing. Needs CRON_SECRET set in the environment.
app.get('/cron/briefing', async (req, res) => {
    if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) return res.sendStatus(403);
    await sendMorningBriefing().catch((e) => console.error('[CRON] Briefing failed:', e));
    res.send('Briefing triggered.');
});

app.listen(PORT, () => console.log(`Assistant listening on port ${PORT}`));