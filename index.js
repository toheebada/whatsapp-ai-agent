require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

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

const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
const HISTORY_LIMIT = 10;
const MAX_TOOL_ROUNDS = 5;

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
        default: return 'Unknown database tool.';
    }
}

// ==========================================
// 3. GROQ BRAIN
// ==========================================

function systemPrompt() {
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const iso = new Date(Date.now() + 3600000).toISOString().slice(0, 19) + '+01:00';
    return `You are a personal AI employee for your boss. Be sharp, direct and brief. Replies are read on WhatsApp.
Current date and time in Lagos: ${now} (ISO: ${iso}).
Use your tools when asked to save, read or list notes, to add, list or complete tasks, to set, list or cancel reminders, or to log, total, list or delete expenses (amounts are in naira). Reminders only go to the boss himself. Never claim a tool succeeded unless it returned a result. Never invent notes or tasks.`;
}

async function askAI(chatId, prompt, image) {
    const history = await fetchRecentHistory(chatId);
    const userContent = image
        ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${image.mimetype};base64,${image.data}` } },
        ]
        : prompt;

    const messages = [{ role: 'system', content: systemPrompt() }, ...history, { role: 'user', content: userContent }];
    const model = image ? VISION_MODEL : TEXT_MODEL;
    let reply = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let res;
        try {
            res = await groq.chat.completions.create({
                model, messages, tools, tool_choice: 'auto', temperature: 0.3, max_tokens: 2048,
                ...(image ? {} : { reasoning_effort: 'low' }),
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

    await saveMessageToHistory(chatId, 'user', image ? `${prompt} [image attached]` : prompt);
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

async function downloadMedia(mediaId) {
    const auth = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
    const meta = await (await fetch(`${GRAPH}/${mediaId}`, { headers: auth })).json();
    const file = await fetch(meta.url, { headers: auth });
    const buf = Buffer.from(await file.arrayBuffer());
    return { mimetype: meta.mime_type, data: buf.toString('base64') };
}

const seen = new Set(); // Meta retries webhooks, so we skip message ids we already handled

async function handleWebhook(body) {
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return; // delivery and read receipts land here, ignore them

    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);

    const from = msg.from;
    if (from !== OWNER_NUMBER) {
        console.log('[SECURITY] Ignored a message from a number that is not the owner.');
        return;
    }

    let prompt = '';
    let image = null;
    if (msg.type === 'text') {
        prompt = msg.text.body;
    } else if (msg.type === 'image') {
        prompt = msg.image.caption || 'Describe this image.';
        image = await downloadMedia(msg.image.id);
    } else {
        await sendText(from, 'I can read text and images for now.');
        return;
    }

    console.log(`[USER (${from})]: ${prompt}`);

    let reply;
    try {
        // "@c.us" keeps your old chat memory from the whatsapp-web.js days
        reply = await askAI(`${from}@c.us`, prompt, image);
    } catch (e) {
        console.error('AI Error:', e);
        reply = 'Something went wrong on my side. Try again in a moment.';
    }
    await sendText(from, reply);
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
// 6. PROACTIVE MESSAGES (Phase 5)
// ==========================================

async function sendMorningBriefing() {
    const tasks = await list_tasks('pending');
    const date = new Date().toLocaleDateString('en-GB', {
        timeZone: 'Africa/Lagos', weekday: 'long', day: 'numeric', month: 'long',
    });
    let body;
    if (tasks.startsWith('Database error')) {
        body = `Good morning. ${date}.\nI could not read your tasks: ${tasks}`;
    } else if (tasks.startsWith('No ')) {
        body = `Good morning. ${date}.\nNo pending tasks. Clean slate, so decide what today is for.`;
    } else {
        body = `Good morning. ${date}.\nPending tasks:\n${tasks}\n\nPick the one that moves things most and do it first.`;
    }
    console.log('[CRON] Sending morning briefing...');
    await sendText(OWNER_NUMBER, body);
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
            const ok = await sendText(OWNER_NUMBER, `Reminder: ${r.message}`);
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