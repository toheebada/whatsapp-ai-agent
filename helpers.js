// helpers.js
// Reads files people send on WhatsApp (PDF, Word, Excel, PowerPoint, text)
// and cleans up replies so they look right on WhatsApp.

const path = require('path');

const MAX_SAVE_CHARS = 400000; // longest file text we keep

// ==========================================
// 1. READING FILES
// ==========================================

function tidy(text) {
    return String(text || '')
        .replace(/\u0000/g, '')
        .replace(/^﻿/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function decodeXml(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}

async function readPdf(buffer) {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text || '')];
    if (pages.join('').trim().length < 30) return ''; // scanned pages have no text layer
    return pages.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n');
}

async function readDocx(buffer) {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
}

function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
        if (v.richText) return v.richText.map((r) => r.text).join('');
        if (v.result !== undefined) return cellText(v.result);
        if (v.text !== undefined) return String(v.text);
        if (v.error) return String(v.error);
        return '';
    }
    return String(v);
}

async function readXlsx(buffer) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const parts = [];
    wb.eachSheet((ws) => {
        const rows = [];
        ws.eachRow((row) => {
            const cells = Array.from(row.values.slice(1), (c) => cellText(c));
            while (cells.length && cells[cells.length - 1].trim() === '') cells.pop(); // drop trailing empty cells
            if (cells.length) rows.push(cells.join(' | '));
        });
        const shown = rows.slice(0, 3000);
        const more = rows.length > shown.length ? `\n(${rows.length - shown.length} more rows not shown)` : '';
        parts.push(`[Sheet: ${ws.name}]\n${shown.join('\n')}${more}`);
    });
    return parts.join('\n\n');
}

async function readPptx(buffer) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const num = (n) => Number(n.match(/slide(\d+)\.xml$/)[1]);
    const names = Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => num(a) - num(b));
    const slides = [];
    for (const n of names) {
        const xml = await zip.file(n).async('string');
        const text = decodeXml(
            xml.replace(/<\/a:p>/g, '\n').replace(/<a:br\s*\/>/g, '\n').replace(/<[^>]+>/g, '')
        );
        slides.push(`[Slide ${num(n)}]\n${text}`);
    }
    return slides.join('\n\n');
}

const TEXT_EXT = new Set([
    'txt', 'md', 'csv', 'tsv', 'json', 'log', 'xml', 'html', 'htm', 'srt', 'vtt', 'yaml', 'yml', 'sql', 'js', 'py', 'rtf',
]);
const OLD_OFFICE = { doc: 'Word', xls: 'Excel', ppt: 'PowerPoint' };

// Returns { text, truncated, totalChars } or { error: "message written for the user" }
async function extractText(buffer, mime = '', filename = '') {
    const ext = path.extname(filename || '').slice(1).toLowerCase();
    const m = String(mime || '').toLowerCase();
    try {
        let text = '';
        if (ext === 'pdf' || m.includes('pdf')) {
            text = await readPdf(buffer);
            if (!text) {
                return { error: "That PDF looks like scanned pages, so there's no text I can read. Send me photos of the pages and I'll read them as images." };
            }
        } else if (ext === 'docx' || m.includes('wordprocessingml')) {
            text = await readDocx(buffer);
        } else if (ext === 'xlsx' || m.includes('spreadsheetml')) {
            text = await readXlsx(buffer);
        } else if (ext === 'pptx' || m.includes('presentationml')) {
            text = await readPptx(buffer);
        } else if (OLD_OFFICE[ext]) {
            return { error: `That's an old ${OLD_OFFICE[ext]} format (.${ext}) that I can't open. Save it as a newer version or a PDF and send it again.` };
        } else if (TEXT_EXT.has(ext) || m.startsWith('text/') || m === 'application/json') {
            text = buffer.toString('utf8');
        } else {
            return { error: `I can't read ${ext ? '.' + ext : 'that kind of'} files yet. I can do PDF, Word, Excel, PowerPoint and plain text files.` };
        }

        text = tidy(text);
        if (!text) return { error: "I opened the file but couldn't find any readable text in it." };
        const totalChars = text.length;
        const truncated = totalChars > MAX_SAVE_CHARS;
        return { text: truncated ? text.slice(0, MAX_SAVE_CHARS) : text, truncated, totalChars };
    } catch (e) {
        console.error(`[FILES] Could not read ${filename || 'file'}:`, e.message);
        return { error: "I couldn't open that file. It may be damaged or password protected." };
    }
}

// ==========================================
// 2. VOICE NOTE FILE NAMES
// ==========================================

function audioFileName(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('mpeg') || m.includes('mp3')) return 'voice.mp3';
    if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'voice.m4a';
    if (m.includes('wav')) return 'voice.wav';
    if (m.includes('webm')) return 'voice.webm';
    return 'voice.ogg'; // WhatsApp voice notes are ogg/opus
}

// ==========================================
// 3. WHATSAPP-FRIENDLY TEXT
// ==========================================

// Turns AI-style markdown into WhatsApp style and removes em dashes.
function toWhatsApp(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/【[^】]*】/g, '')                                        // search citations
        .replace(/^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*\|?[ \t]*\n/gm, '')    // table separator rows and --- lines
        .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, inner) => inner.split('|').map((s) => s.trim()).join(' | ')) // table rows
        .replace(/^#{1,6}\s*(.+)$/gm, (_, t) => `*${t.replace(/\*/g, '').trim()}*`) // headings
        .replace(/^[ \t]*\*[ \t]+/gm, '- ')                               // "* item" bullets
        .replace(/\*\*(.+?)\*\*/g, '*$1*')                                // **bold** to *bold*
        .replace(/^[ \t]*[-•][ \t]+/gm, '- ')                             // bullets
        .replace(/\s*—\s*/g, ', ')                                        // em dashes
        .replace(/,\s*,/g, ',')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Splits long replies into several WhatsApp messages without cutting sentences if possible.
function splitMessage(text, max = 3800) {
    const out = [];
    let rest = String(text || '').trim();
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n\n', max);
        if (cut < max * 0.4) cut = rest.lastIndexOf('\n', max);
        if (cut < max * 0.4) cut = rest.lastIndexOf('. ', max) + 1;
        if (cut < max * 0.4) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
}

module.exports = { extractText, audioFileName, toWhatsApp, splitMessage, MAX_SAVE_CHARS };