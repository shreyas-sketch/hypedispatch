// Landing page -> fact sheet (Sonnet) -> daily message (Haiku) -> validator -> fallback.
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { prettyDate } from './time.js';

const FACT_MODEL = process.env.FACT_MODEL || 'claude-sonnet-5-5';
const MSG_MODEL = process.env.MSG_MODEL || 'claude-haiku-4-5-20251001';

let client;
const ai = () => (client ||= new Anthropic()); // reads ANTHROPIC_API_KEY

const textOf = (res) => {
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this request');
  if (res.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing');
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
};

// ---------- 1. Read the landing page ----------
export async function fetchPageText(url) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Add the landing page URL first (starting with https://)');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36' },
  });
  if (!res.ok) throw new Error(`Landing page returned ${res.status}`);
  const $ = cheerio.load(await res.text());
  $('script,style,noscript,svg,iframe,template').remove();
  $('p,div,section,li,tr,br,h1,h2,h3,h4,h5,h6,button,a').after('\n');
  const title = $('title').text().trim();
  const desc = $('meta[name="description"]').attr('content') || '';
  const body = $('body').text()
    .replace(/[ \t ]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l, i, arr) => arr.indexOf(l) === i) // drop repeated lines (menus, footers)
    .join('\n');
  const text = [title, desc, body].filter(Boolean).join('\n');
  if (text.length < 300) {
    throw new Error('Could not read much text from this page (it may load with JavaScript). Paste the page text instead.');
  }
  return text.slice(0, 60000);
}

// ---------- 2. Build the fact sheet ----------
const FACT_SYSTEM = `You extract facts from a workshop landing page for a WhatsApp reminder system.
The same workshop runs again and again on different dates, so specific dates and clock times on the page are often outdated.
Rules:
- Use ONLY what the page text says. Never add, infer, or embellish.
- Copy numbers, prices, names and claims exactly as written. Capture every numeric claim you find in other_key_facts.
- Do NOT record specific calendar dates or clock times. Durations ("3 hours", "2 evenings") are fine.
- If something is not on the page, use null (or [] for lists).
- Reply with JSON only, no commentary.`;

const FACT_SHAPE = `{
  "title": string,
  "tagline": string|null,
  "duration": string|null,
  "host": string|null,
  "host_credentials": string[],      // only what page states
  "who_its_for": string[],
  "what_youll_learn": string[],
  "outcomes": string[],
  "bonuses": string[],
  "price_text": string|null,
  "format": string|null,             // e.g. "Live on Zoom"
  "other_key_facts": string[]        // anything else hype-worthy, verbatim-ish
}`;

export async function extractFacts(pageText, focus = '') {
  const res = await ai().messages.create({
    model: FACT_MODEL,
    max_tokens: 16000, // Sonnet 5.5 thinks by default and that counts against this
    system: FACT_SYSTEM,
    messages: [{
      role: 'user',
      content: `Landing page text:\n<page>\n${pageText}\n</page>\n\n${focus ? `Focus: ${focus}\n\n` : ''}Return JSON in this shape:\n${FACT_SHAPE}`,
    }],
  });
  const raw = textOf(res).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    throw new Error('Claude did not return a readable fact sheet. Try again.');
  }
}

// ---------- 3. Write today's message ----------
const PHASE_BRIEF = {
  hype: `A hype-building, FOMO-inducing message for a workshop that is still a few days away.
Pick ONE angle from the fact sheet (a specific thing they'll learn, an outcome, who it's for, the host, a bonus) and make people feel they'd be missing out big if they weren't there.
Open with a hook line that stops the scroll. Close with a push to lock in the date and show up live.
Do NOT write a countdown: no "X days left", "X days to go", no day counts at all. Build urgency through what's at stake, not a timer.
Mention the date and time so they can block it.`,
  tomorrow: `The workshop is TOMORROW. Peak "it's dropping tomorrow, don't miss this" energy.
Mention it's tomorrow and the time (from the fact sheet). Tease 1-2 specific things they'll get, and make it clear that the people who show up live tomorrow get the most out of it. Tell them to set a reminder now.`,
  dayof: `The workshop is TODAY. "We go live in a few hours, this is it" energy.
Mention the time (from the fact sheet). Make it feel like an event they can't afford to skip: remind them what they'll walk away with, and push them to join on time because the start matters.`,
  reschedule: `The workshop has been RESCHEDULED from old_date_text/old_time_text to the new date_text/time_text in the fact sheet.
Announce the new date and time clearly in the first line. Brief, warm apology for the change (one short phrase, no reason given, never invent a reason).
Then turn it into more hype: remind them of one thing they'll get and that the new date is the one not to miss. Tell them to update their calendar right now.`,
};

const MSG_SYSTEM = `You write WhatsApp community messages for a live online workshop.

Hard rules:
- Every fact must come from the FACT SHEET. Do not invent numbers, results, testimonials, bonuses, scarcity, prices, names or claims. If unsure, leave it out.
- Never write URLs or links.
- Only use numbers that appear in the fact sheet.
- 70 to 110 words, in 3-5 short paragraphs (blank line between them) so it reads easily on a phone.
- Goal: get as many people as possible to actually show up LIVE. Every message should build hype and a real fear of missing out.
- Tone: high-energy, urgent, exciting and personal, like a host who can't wait for this. Short punchy lines. Not corporate, no ALL CAPS shouting.
- FOMO techniques to use (truthfully): paint the "after" picture of what attendees walk away with, contrast people who show up with people who hear about it later, make it feel like a moment you'd regret missing, end with a clear push to block the time and be there live.
- Scarcity, limited seats, "no replay", deadlines or bonuses only for live attendees: use them ONLY if the fact sheet says so (then lean into them hard). Never make them up.
- Use 3-5 emojis that fit the content, spread through the message (e.g. at the start of the opening line and of a paragraph or two).
- Formatting (WhatsApp style): bold with ONE asterisk on each side, *like this* (never **double**, no # headings, no markdown). Bold the important things: the workshop name, the date and time together (e.g. *Sunday, 4 October, 7 PM IST*), and the single biggest benefit. 2-4 bold parts in total, nothing else bold.
- One idea per paragraph, blank line between paragraphs. If you list 2-3 things they'll get, put each on its own line starting with an emoji.
- Do not sign off or add a name at the end: the team signature is added automatically.
- Must be clearly different from the previous messages (different opening, angle and structure).
- Output only the message text.`;

export async function draftMessage(ws, phase, previous = [], feedback = '') {
  const res = await ai().messages.create({
    model: MSG_MODEL,
    max_tokens: 400,
    // Newer Sonnet/Opus models reject custom temperature; only send it to Haiku
    ...(/haiku/i.test(MSG_MODEL) ? { temperature: 0.9 } : {}),
    system: MSG_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        `FACT SHEET:\n${JSON.stringify(ws.factSheet, null, 2)}`,
        `The workshop date and time are ONLY what the fact sheet's date_text and time_text say.`,
        `TASK:\n${PHASE_BRIEF[phase]}`,
        linkBrief(ws, phase),
        previous.length ? `PREVIOUS MESSAGES (do not repeat these):\n${previous.slice(-6).map((m, i) => `${i + 1}. ${m}`).join('\n\n')}\n(Any date in these may be outdated. Never copy dates from them.)` : '',
        feedback ? `Your last draft was rejected: ${feedback}. Fix that.` : '',
      ].filter(Boolean).join('\n\n'),
    }],
  });
  return toWhatsApp(textOf(res).replace(/^["']|["']$/g, '').trim());
}

// Turn stray markdown into WhatsApp formatting: **bold** -> *bold*, no # headings, [text](url) -> text
export function toWhatsApp(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n');
}

// ---------- 4. Check it against the landing page ----------
const WORD_NUM = '(?:one|two|three|four|five|six|seven|eight|nine|ten)';
const COUNTDOWN = new RegExp(`\\b(?:\\d+|${WORD_NUM})\\s+(?:more\\s+)?days?\\s+(?:left|to go|remaining|away)\\b|\\bdays? (?:left|remaining)\\b|\\bcountdown\\b`, 'i');

export function sourceText(ws) {
  // Only the fact sheet (with this run's date/time) counts, never the raw page, whose dates are often stale
  const out = [];
  const walk = (v) => { if (v == null) return; if (typeof v === 'object') Object.values(v).forEach(walk); else out.push(String(v)); };
  walk(ws.factSheet || {});
  return out.join('\n').toLowerCase();
}

// Whole numbers as written ("1,999" and "1999" count as the same). Keycap emoji like 1️⃣ are ignored.
const numbersIn = (s) => (s.replace(/[0-9]\uFE0F?\u20E3/g, '').match(/\d+(?:[.,:]\d+)*/g) || []).map((n) => n.replace(/,/g, ''));

export function validate(msg, ws, phase) {
  const issues = [];
  if (!msg) return ['empty message'];
  if (/https?:\/\/|www\.|\.com\b|\.in\b|zoom\.us/i.test(msg)) issues.push('it contains a link');
  const words = msg.split(/\s+/).length;
  if (words < 55) issues.push(`too short (${words} words, aim for 70-110)`);
  if (words > 140) issues.push(`too long (${words} words, aim for 70-110)`);
  const emojis = (msg.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojis < 2) issues.push('use 3-5 emojis');
  if (emojis > 7) issues.push('too many emojis, use 3-5');
  const bold = (msg.match(/\*[^*\n]+\*/g) || []).length;
  if (bold < 2) issues.push('bold the workshop name and the date and time with single asterisks, *like this*');
  if (bold > 6) issues.push('too much bold, keep it to 2-4 important parts');
  if (phase === 'hype' && COUNTDOWN.test(msg)) issues.push('it reads like a countdown');

  const src = sourceText(ws);
  // Whole-number match, so "10" isn't accepted just because the fact sheet says "100"
  const srcNums = new Set(numbersIn(src));
  for (const n of new Set(numbersIn(msg))) {
    if (!srcNums.has(n)) issues.push(`the number "${n}" is not on the landing page`);
  }
  // Day and month names must also match (catches "Saturday" when it's a Sunday)
  const CAL = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;
  for (const w of new Set((msg.match(CAL) || []).map((x) => x.toLowerCase()))) {
    if (w === 'may' ) continue; // too common as a verb
    if (!src.includes(w)) issues.push(`"${w}" doesn't match the workshop date`);
  }
  return issues;
}

// ---------- 5. Safe fixed template if AI can't produce a clean one ----------
// Which links go under each message:
//   form link (helps us tailor the workshop; filling it unlocks a surprise bonus): every message except on the workshop day
//   Zoom link: the day before and the workshop day
export function linksFor(ws, phase) {
  const out = [];
  if (phase !== 'dayof' && ws.formLink) out.push({ kind: 'form', label: '🎁 *Unlock your surprise bonus:*', url: ws.formLink });
  if ((phase === 'tomorrow' || phase === 'dayof') && ws.zoomLink) out.push({ kind: 'Zoom link', label: '🎥 *Zoom link:*', url: ws.zoomLink });
  return out;
}

function linkBrief(ws, phase) {
  const kinds = linksFor(ws, phase).map((l) => l.kind);
  if (!kinds.length) return 'Do not mention any form or link.';
  const form = kinds.includes('form')
    ? `\nABOUT THE FORM: it is NOT a registration form. It's a short form that helps us tailor the workshop to what each person wants, and everyone who fills it gets a surprise bonus. Make them curious and eager to fill it (tailored workshop + surprise bonus). Never say or guess what the bonus is.`
    : '';
  return `End with a short line saying the ${kinds.join(' and ')} ${kinds.length > 1 ? 'are' : 'is'} below (added automatically, do not write any link).${form}`;
}

function linkLine(ws, phase) {
  const kinds = linksFor(ws, phase).map((l) => l.kind);
  if (!kinds.length) return '';
  const text = kinds.length > 1 ? '🎁 Fill in the short form below to unlock your *surprise bonus*, and save the Zoom link'
    : kinds[0] === 'form' ? '🎁 Fill in the short form below so we can tailor the workshop to you, and unlock your *surprise bonus*'
    : 'Zoom link below';
  return `\n\n${text} 👇`;
}

export function fallback(ws, phase) {
  const f = ws.factSheet || {};
  const title = f.title || ws.name;
  const when = f.time_text || '';
  const day = f.date_text || prettyDate(ws.date);
  const at = `${day}${when ? `, ${when}` : ''}`;
  // Only facts from the fact sheet, never anything made up
  const points = [...(f.what_youll_learn || []), ...(f.outcomes || [])].filter(Boolean).slice(0, 2);
  const list = points.length ? `\n\n${points.map((x) => `👉 ${x}`).join('\n')}` : '';
  const forWho = f.who_its_for?.[0] ? `\n\n🙌 Made for: ${f.who_its_for[0]}` : '';
  const host = f.host ? ` with *${f.host}*` : '';
  if (phase === 'tomorrow') {
    return `🔥 It's dropping *tomorrow*!\n\n*${title}*${host} goes live *${at}*.${list ? ` Here's a taste of what's coming:${list}` : ''}\n\nSet a reminder right now ⏰ The people who show up live get the most out of it, don't be the one who hears about it later!${linkLine(ws, phase)}`;
  }
  if (phase === 'reschedule') {
    return `📅 *Change of date*\n\n*${title}* is now on *${at}*${f.old_date_text ? ` (earlier ${f.old_date_text}${f.old_time_text ? `, ${f.old_time_text}` : ''})` : ''}. Sorry for the shuffle! 🙏\n\nPlease update your calendar. Everything else stays exactly the same${list ? `:${list}` : '.'}\n\nLock in the new date now, this is still the one not to miss ✨${linkLine(ws, phase)}`;
  }
  if (phase === 'dayof') {
    return `🚀 *Today's the day!*\n\n*${title}*${host} is live${when ? ` *today at ${when}*` : ' *today*'}.${list ? ` Here's what we're getting into:${list}` : ''}\n\nThis is the one you don't want to hear about secondhand. Grab a notebook, find a quiet spot and join on time so you don't miss the start ⏰${linkLine(ws, phase)}`;
  }
  return `🔥 You do NOT want to miss *${title}*${host}!${points.length ? '\n\nHere\'s a little of what we\'ll dive into:' : ''}${list}${forWho}\n\nBlock *${at}* 📅 and be there live. You'll want to say you were in the room for this one!${linkLine(ws, phase)}`;
}

// Links are always added by code, never written by the AI
export function withLinks(msg, ws, phase) {
  return [msg.trim(), ...linksFor(ws, phase).map((l) => `${l.label}\n${l.url}`), ws.signature?.trim()].filter(Boolean).join('\n\n');
}

// Full pipeline: up to 3 AI attempts, then fallback
export async function composeMessage(ws, phase, previous) {
  let feedback = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const draft = await draftMessage(ws, phase, previous, feedback);
      const issues = validate(draft, ws, phase);
      if (!issues.length) return { text: draft, source: 'ai', attempts: attempt };
      feedback = issues.join('; ');
    } catch (e) {
      feedback = '';
      if (attempt === 3) return { text: fallback(ws, phase), source: 'fallback', error: e.message };
    }
  }
  return { text: fallback(ws, phase), source: 'fallback', error: `AI drafts failed checks: ${feedback}` };
}
