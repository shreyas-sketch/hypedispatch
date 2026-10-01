// Landing page -> fact sheet (Sonnet) -> daily message (Haiku) -> validator -> fallback.
import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { prettyDate } from './time.js';

const FACT_MODEL = process.env.FACT_MODEL || 'claude-sonnet-5-5';
const MSG_MODEL = process.env.MSG_MODEL || 'claude-haiku-4-5-20251001';

let client;
// reads ANTHROPIC_API_KEY. Short timeout so a slow API can't hold up a scheduled send for long (falls back to the template)
const ai = () => (client ||= new Anthropic({ timeout: 60_000, maxRetries: 2 }));

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
Pick ONE angle from the fact sheet (a specific thing they'll learn, an outcome, the host, a bonus) and make them feel they'd be kicking themselves if they joined and then didn't show up.
Open with a hook line that stops the scroll. Close with a push to block the date and show up live.
Do NOT write a countdown: no "X days left", "X days to go", no day counts at all. Build urgency through what's at stake, not a timer.
Mention the date and time so they can block it.`,
  tomorrow: `The workshop is TOMORROW. Peak "it's happening tomorrow, you're in, now SHOW UP" energy.
Mention it's tomorrow and the time (from the fact sheet). Tease 1-2 specific things they'll get, and make it clear the people who show up live get the most out of it. Tell them to set a reminder right now.`,
  dayof: `The workshop is TODAY. "We go live in a few hours, this is the moment you joined for" energy.
Mention the time (from the fact sheet). Make it feel like an event they can't afford to skip: remind them what they'll walk away with, and push them to join on time because the start matters.`,
  reschedule: `The workshop has been RESCHEDULED from old_date_text/old_time_text to the new date_text/time_text in the fact sheet.
Announce the new date and time clearly in the first line. Brief, warm apology for the change (one short phrase, no reason given, never invent a reason).
Reassure them their spot is safe and nothing else changes. Then turn it into more hype: remind them of one thing they'll get and that the new date is the one not to miss. Tell them to update their calendar right now.`,
};

const MSG_SYSTEM = `You write WhatsApp community messages for a live online workshop.

WHO READS THIS: everyone in this community has ALREADY joined the workshop. They're in and waiting for it.
The ONLY goal is to get them excited enough to actually SHOW UP LIVE on the day. Never sell to them.

Hard rules:
- Never mention price, cost, payment, fees, discounts, money, or whether it's paid or free.
- Never ask them to register, sign up, enrol, buy or book. They already have. Talk to them as people who are in ("you're in", "your spot", "see you there").
- Every fact must come from the FACT SHEET. Do not invent numbers, results, testimonials, bonuses, scarcity, prices, names or claims. If unsure, leave it out.
- Never write URLs or links.
- Only use numbers that appear in the fact sheet.
- 70 to 110 words in total, split into 6-9 SHORT paragraphs with a blank line between them. Each paragraph is ONE punchy line of 1-2 short sentences, never more than 20 words. Think WhatsApp, not email.
- Goal: get as many people as possible to actually show up LIVE. Every message should build hype and a real fear of missing out.
- Tone: HIGH energy. Urgent, bold, exciting and personal, like a host who is genuinely pumped. Short punchy sentences. Fragments are fine. Exclamation marks are fine. Talk to "you". No corporate or bland lines like "join us for an informative session". One or two words in caps for emphasis is fine, never whole sentences.
- FOMO techniques to use (truthfully): paint the "after" picture of what attendees walk away with, contrast people who show up with people who hear about it later, make it feel like a moment you'd regret missing, end with a clear push to block the time and be there live.
- Scarcity, limited seats, "no replay", deadlines or bonuses only for live attendees: use them ONLY if the fact sheet says so (then lean into them hard). Never make them up.
- Use 4-6 emojis that fit the content, spread through the message (e.g. at the start of the opening line and of a few paragraphs).
- Formatting (WhatsApp style): bold with ONE asterisk on each side, *like this* (never **double**, no # headings, no markdown). Bold the important things: the workshop name, the date and time together (e.g. *Sunday, 4 October, 7 PM IST*), and the single biggest benefit. 2-4 bold parts in total, nothing else bold.
- One idea per paragraph, blank line between paragraphs. If you list 2-3 things they'll get, put each on its own line starting with an emoji.
- Do not sign off or add a name at the end: the team signature is added automatically.
- Must be clearly different from the previous messages (different opening, angle and structure).
- Output only the message text.

SHAPE TO AIM FOR (the [brackets] are placeholders; fill them only with facts from the fact sheet, never copy this wording):
🔥 [Scroll-stopping hook about the biggest benefit]

You're in. Now let's make it count.

*[Workshop name]* goes live *[date, time]* ⏰

👉 [specific thing they'll get]
👉 [another specific thing]

[One line on why showing up live matters]

[Short, punchy push to block the time] 🙌`;

export async function draftMessage(ws, phase, previous = [], feedback = '') {
  const res = await ai().messages.create({
    model: MSG_MODEL,
    max_tokens: 4000, // room for newer models that think before writing
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

// They've already paid to join: messages never mention the workshop's price or ask them to sign up.
// Careful: words like "fees", "pricing", "paid ads", "costs" are normal workshop CONTENT, so only an
// actual amount of money in a price context (or the 99 itself) counts as a price.
const CURRENCY = /₹\s?\d|\brs\.?\s?\d|\binr\s?\d|\$\s?\d|\d\s?(?:\/-|rs\b|inr\b|rupees?\b)/i;
const PRICE_CONTEXT = /\b(price|pricing|priced|fee|fees|pay|paid|payment|only|just|offer|discount|worth|ticket|register|registration|enrol|enroll|seat|access|entry|join|joined|joining)\b/i;
export function mentionsPrice(s) {
  if (/(?:₹|\brs\.?|\binr)\s?99\b|\b99\s?(?:\/-|rs\b|rupees?\b)/i.test(s)) return true;
  if (/\b(?:workshop|ticket|entry|registration|joining|enrol?ment) (?:fee|price|cost)s?\b|\bfor free\b|\bfree of cost\b|\bfor just\s+(?:₹|rs)/i.test(s)) return true;
  return s.split(/[.!?\n]/).some((x) => CURRENCY.test(x) && PRICE_CONTEXT.test(x));
}
export const PRICE = { test: mentionsPrice }; // used by withoutPrice()
const SELLING = /\b(register (?:now|here|today|for)|registration (?:link|form)|sign ?up (?:now|here|today|for)|enrol+ (?:now|here|today)|buy (?:now|your|a) (?:seat|ticket|spot|pass)|(?:book|grab|reserve|secure) your (?:seat|spot))\b/i;

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
  if (emojis > 9) issues.push('too many emojis, use 4-6');
  const longest = Math.max(...msg.split(/\n\s*\n/).map((p) => p.split(/\s+/).filter(Boolean).length));
  if (longest > 30) issues.push(`a paragraph is ${longest} words, keep every paragraph to one short line (max 20 words)`);
  if (PRICE.test(msg)) issues.push('it mentions price or payment, never mention money');
  if (SELLING.test(msg)) issues.push('it asks them to register/sign up/buy, but they have already joined');
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
  const what = points.length ? `\n\nHere's what's waiting for you:\n${points.map((x) => `👉 ${x}`).join('\n')}` : '';
  if (phase === 'tomorrow') {
    return `⏰ *Tomorrow is the day!*\n\n*${title}*${host}\n📅 *${at}*\n\nYou're in. Now make sure you're actually there 🔥${what}\n\nSet a reminder right now. Seriously, do it now!${linkLine(ws, phase)}`;
  }
  if (phase === 'reschedule') {
    return `📅 *New date alert!*\n\n*${title}* is now on *${at}*${f.old_date_text ? ` (earlier ${f.old_date_text}${f.old_time_text ? `, ${f.old_time_text}` : ''})` : ''}.\n\nSorry for the shuffle 🙏 Your spot is safe and nothing else changes ✅${what}\n\nUpdate your calendar right now. This is still the one not to miss 🔥${linkLine(ws, phase)}`;
  }
  if (phase === 'dayof') {
    return `🚀 *It's TODAY!*\n\n*${title}*${host} goes live *today at ${when || 'the scheduled time'}*.\n\nThis is the moment you joined for 💪${what}\n\nGrab a notebook. Join on time. The first few minutes set the tone ⏰${linkLine(ws, phase)}`;
  }
  return `🔥 *${title}* is coming, and you're already in!${host ? `\n\nLive${host}.` : ''}\n\n📅 *${at}*\nBlock it. Protect it. Show up.${what}${forWho}\n\nThe real magic happens live. Don't be the one catching up later ⚡${linkLine(ws, phase)}`;
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
