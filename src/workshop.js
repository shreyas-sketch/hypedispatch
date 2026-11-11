// Joins a dated workshop run with its programme's fact sheet.
import { db } from './db.js';
import { prettyDate, prettyTime, addDays } from './time.js';
import { PRICE, lengthsIn } from './ai.js';

// Members have already paid, so price never goes into the messages: drop it from the facts Claude sees
export function withoutPrice(facts) {
  const out = { ...facts, price_text: undefined };
  // e.g. "AI Workshop @ ₹99" -> "AI Workshop"
  if (typeof out.title === 'string') out.title = out.title.replace(/\s*(?:[-–|@:]|\bat\b|\bfor\b)?\s*(?:just|only)?\s*(?:₹|rs\.?|inr)\s?\d[\d,]*(?:\/-)?(?:\s*only)?/gi, '').trim() || out.title;
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v)) out[k] = v.filter((x) => !(typeof x === 'string' && (PRICE.test(x) || /\b99\b/.test(x))));
    else if (typeof v === 'string' && k !== 'title' && PRICE.test(v)) out[k] = undefined;
  }
  return out;
}

export const programmeOf = (ws) => db().programmes.find((p) => p.id === ws.programmeId);

// ----- Workshop length (1-day, 2-day, ...). A programme can run as 2 days one time and 1 day the next. -----
export const lengthText = (n) => (n === 1 ? '1 day' : `${n} days`);
// The run's own setting, else what the programme's name says ("2-Day ..."), else 1 day
export function lengthOf(ws) {
  const n = Number(ws?.days);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  const prog = programmeOf(ws || {});
  return lengthsIn(prog?.title || prog?.factSheet?.title)[0] || 1;
}
// "2-Day Business Owners Workshop" -> "1-Day Business Owners Workshop" for a 1-day run
export const titleForLength = (title, n) => String(title || '').replace(/\b([1-5]|one|two|three|four|five)[-\s]day\b/i, (m) => `${n}${m.match(/[-\s]/)[0]}${/D/.test(m) ? 'Day' : 'day'}`);
// Facts that state a different length ("over 2 days") would contradict this run: leave them out
function withoutOtherLengths(facts, n) {
  const clashes = (x) => typeof x === 'string' && lengthsIn(x).some((k) => k !== n);
  const out = { ...facts };
  for (const [k, v] of Object.entries(out)) {
    if (k === 'title') continue;
    if (Array.isArray(v)) out[k] = v.filter((x) => !clashes(x));
    else if (clashes(v)) out[k] = undefined;
  }
  return out;
}
const datesText = (ws, n) => {
  if (n === 1) return prettyDate(ws.date);
  const last = addDays(ws.date, n - 1);
  return n === 2 ? `${prettyDate(ws.date)} and ${prettyDate(last)}` : `${prettyDate(ws.date)} to ${prettyDate(last)}`;
};

export function timeLabelOf(ws) {
  return ws.timeLabel || (ws.startTime ? `${prettyTime(ws.startTime)} IST` : '');
}

// The fact sheet Claude sees for this run: programme facts + this run's date and time.
// `old` is only passed for the reschedule announcement.
export function resolve(ws, old = null) {
  const prog = programmeOf(ws);
  if (!prog?.factSheet) return null;
  const n = lengthOf(ws);
  const facts = withoutOtherLengths(withoutPrice(prog.factSheet), n);
  const factSheet = {
    ...facts,
    // The official name and host (set per programme) always win over what was read off the landing page.
    // The name follows this run's length ("2-Day ..." becomes "1-Day ..." for a 1-day run).
    title: titleForLength(prog.title?.trim() || facts.title, n),
    host: prog.host?.trim() || facts.host,
    length_text: lengthText(n),
    date_text: datesText(ws, n), // every day of the workshop
    time_text: timeLabelOf(ws),
  };
  if (old) {
    const was = lengthOf(old);
    factSheet.old_date_text = datesText(old, was);
    factSheet.old_time_text = old.timeLabel || '';
    if (was !== n) factSheet.old_length_text = lengthText(was);
  }
  return { ...ws, name: ws.name || prog.name, signature: prog.signature || '', factSheet };
}

// After a resync: refresh saved group names for workshops on this number, and list groups it's no longer in
export function syncWorkshopGroups(accountId, groups) {
  const byJid = new Map(groups.map((g) => [g.jid, g]));
  let renamed = 0;
  const missing = [];
  const wrongKind = []; // the community itself was picked instead of its announcements group
  for (const ws of db().workshops.filter((w) => w.account === accountId)) {
    for (const g of ws.groups || []) {
      const now = byJid.get(g.jid);
      if (!now) missing.push({ workshop: displayName(ws), group: g.name });
      else {
        if (now.name && now.name !== g.name) { g.name = now.name; renamed++; }
        if (now.kind === 'community') wrongKind.push({ workshop: displayName(ws), group: g.name });
      }
    }
  }
  return { renamed, missing, wrongKind };
}

// "Akshat Consulting · Tue, 6 Oct" (readable everywhere: dashboard, logs, activity)
export const shortDate = (iso) => (iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

export function displayName(ws) {
  const prog = programmeOf(ws);
  return ws.name || `${prog?.name || 'Workshop'} · ${shortDate(ws.date)}`;
}
