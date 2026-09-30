// Landing page -> fact sheet (Sonnet) -> daily message (Haiku) -> validator -> fallback.
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { prettyDate } from './time.js';

const FACT_MODEL = process.env.FACT_MODEL || 'claude-sonnet-5-5';
const MSG_MODEL = process.env.MSG_MODEL || 'claude-haiku-4-5-20251001';

let client;
const ai = () => (client ||= new Anthropic()); // reads ANTHROPIC_API_KEY

const textOf = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

// ---------- 1. Read the landing page ----------
export async function fetchPageText(url) {
  const res = await fetch(url, {
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
    max_tokens: 2000,
    system: FACT_SYSTEM,
    messages: [{
      role: 'user',
      content: `Landing page text:\n<page>\n${pageText}\n</page>\n\n${focus ? `Focus: ${focus}\n\n` : ''}Return JSON in this shape:\n${FACT_SHAPE}`,
    }],
  });
  const raw = textOf(res).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
}

// ---------- 3. Write today's message ----------
const PHASE_BRIEF = {
  hype: `A hype-building message for a workshop that is still a few days away.
Pick ONE angle from the fact sheet (a specific thing they'll learn, an outcome, who it's for, the host, a bonus) and make people excited about it.
Do NOT write a countdown: no "X days left", "X days to go", no day counts at all. It must feel like genuine excitement, not a timer.
You may mention the date/time casually if it fits.`,
  tomorrow: `The workshop is TOMORROW. "It's dropping tomorrow" energy.
Mention it's tomorrow and the time (from the fact sheet). Tease 1-2 things they'll get.
End with a short line telling them the form and Zoom link are below (the links are added automatically, do not write any link).`,
  dayof: `The workshop is TODAY. "We're live today" energy.
Mention the time (from the fact sheet). Remind them to show up on time and be ready.
End with a short line saying the Zoom link is below (added automatically, do not write any link).`,
  reschedule: `The workshop has been RESCHEDULED from old_date_text/old_time_text to the new date_text/time_text in the fact sheet.
Announce the new date and time clearly in the first line. Brief, warm apology for the change (one short phrase, no reason given, never invent a reason).
Keep the excitement: remind them of one thing they'll get. Tell them to update their calendar.`,
};

const MSG_SYSTEM = `You write WhatsApp community messages for a live online workshop.

Hard rules:
- Every fact must come from the FACT SHEET. Do not invent numbers, results, testimonials, bonuses, scarcity, prices, names or claims. If unsure, leave it out.
- Never write URLs or links.
- Only use numbers that appear in the fact sheet.
- 40 to 90 words. 2-4 short lines/paragraphs.
- Tone: exciting, warm, a bit casual, like a friendly host. Not corporate, not salesy, no ALL CAPS shouting.
- 1-3 emojis max. WhatsApp *bold* allowed once or twice.
- Must be clearly different from the previous messages (different opening, angle and structure).
- Output only the message text.`;

export async function draftMessage(ws, phase, previous = [], feedback = '') {
  const res = await ai().messages.create({
    model: MSG_MODEL,
    max_tokens: 400,
    temperature: 0.9,
    system: MSG_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        `FACT SHEET:\n${JSON.stringify(ws.factSheet, null, 2)}`,
        `The workshop date and time are ONLY what the fact sheet's date_text and time_text say.`,
        `TASK:\n${PHASE_BRIEF[phase]}`,
        previous.length ? `PREVIOUS MESSAGES (do not repeat these):\n${previous.slice(-6).map((m, i) => `${i + 1}. ${m}`).join('\n\n')}\n(Any date in these may be outdated. Never copy dates from them.)` : '',
        feedback ? `Your last draft was rejected: ${feedback}. Fix that.` : '',
      ].filter(Boolean).join('\n\n'),
    }],
  });
  return textOf(res).replace(/^["']|["']$/g, '').trim();
}

// ---------- 4. Check it against the landing page ----------
const WORD_NUM = '(?:one|two|three|four|five|six|seven|eight|nine|ten)';
const COUNTDOWN = new RegExp(`\\b(?:\\d+|${WORD_NUM})\\s+(?:more\\s+)?days?\\s+(?:left|to go|remaining|away)\\b|\\bdays? (?:left|remaining)\\b|\\bcountdown\\b`, 'i');

export function sourceText(ws) {
  // Only the fact sheet (with this run's date/time) counts, never the raw page, whose dates are often stale
  return JSON.stringify(ws.factSheet || {}).toLowerCase();
}

export function validate(msg, ws, phase) {
  const issues = [];
  if (!msg) return ['empty message'];
  if (/https?:\/\/|www\.|\.com\b|\.in\b|zoom\.us/i.test(msg)) issues.push('it contains a link');
  const words = msg.split(/\s+/).length;
  if (words < 25) issues.push('too short');
  if (words > 130) issues.push('too long');
  if (phase === 'hype' && COUNTDOWN.test(msg)) issues.push('it reads like a countdown');

  const src = sourceText(ws);
  const nums = (msg.replace(/[0-9]️?⃣/g, '').match(/\d+(?:[.,:]\d+)*/g)) || [];
  for (const n of new Set(nums)) {
    if (!src.includes(n)) issues.push(`the number "${n}" is not on the landing page`);
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
export function fallback(ws, phase) {
  const f = ws.factSheet || {};
  const title = f.title || ws.name;
  const when = f.time_text || '';
  const day = f.date_text || prettyDate(ws.date);
  const learn = f.what_youll_learn?.[0] || f.outcomes?.[0];
  if (phase === 'tomorrow') {
    return `🔥 It's dropping *tomorrow*!\n\n*${title}* goes live ${day}${when ? `, ${when}` : ''}. Block your calendar now.\n\nForm and Zoom link below 👇`;
  }
  if (phase === 'reschedule') {
    return `📅 *Change of date*\n\n*${title}* is now on *${day}${when ? `, ${when}` : ''}* (earlier ${f.old_date_text}${f.old_time_text ? `, ${f.old_time_text}` : ''}). Sorry for the shuffle!\n\nPlease update your calendar. Everything else stays the same, and we can't wait to see you there.`;
  }
  if (phase === 'dayof') {
    return `🚀 *Today's the day!*\n\n*${title}* is live${when ? ` at ${when}` : ' today'}. Grab a notebook and join on time.\n\nZoom link below 👇`;
  }
  return `✨ Getting ready for *${title}*!${learn ? `\n\nOne thing we'll dive into: ${learn}.` : ''}\n\nSee you on ${day}${when ? `, ${when}` : ''}. It's going to be a good one.`;
}

// Links are always added by code, never written by the AI
export function withLinks(msg, ws, phase) {
  const lines = [msg.trim()];
  if (phase === 'tomorrow') {
    if (ws.formLink) lines.push(`📝 Form: ${ws.formLink}`);
    if (ws.zoomLink) lines.push(`🎥 Zoom: ${ws.zoomLink}`);
  }
  if (phase === 'dayof' && ws.zoomLink) lines.push(`🎥 Join here: ${ws.zoomLink}`);
  return lines.join('\n\n');
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
