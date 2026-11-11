// Joins a dated workshop run with its programme's fact sheet.
import { db } from './db.js';
import { prettyDate, prettyTime, addDays, daysBetween } from './time.js';
import { PRICE, lengthsIn, LENGTH_RE } from './ai.js';

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
// The run's own setting; if it was never set (runs saved before lengths existed), the best guess
// from the programme name, the landing-page facts, then what this run's earlier messages said
export const lengthOf = (ws) => lengthInfo(ws).n;
export function lengthInfo(ws) {
  const n = Number(ws?.days);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return { n, source: 'set' };
  const prog = programmeOf(ws || {});
  const f = prog?.factSheet || {};
  for (const [text, source] of [[prog?.title, 'name'], [f.title, 'name'], [f.duration, 'facts']]) {
    const k = lengthsIn(text)[0];
    if (k) return { n: k, source };
  }
  const mostCommon = (texts) => {
    const count = {};
    for (const k of texts.flatMap((t) => lengthsIn(t))) count[k] = (count[k] || 0) + 1;
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : 0;
  };
  const said = mostCommon(db().history?.[ws?.id] || []);
  if (said) return { n: said, source: 'messages' };
  const facts = mostCommon(Object.entries(f).filter(([k]) => k !== 'price_text').flatMap(([, v]) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string'));
  if (facts) return { n: facts, source: 'facts' };
  return { n: 1, source: 'default' };
}

// Every day of the run: day 1 is ws.date; later days are ws.moreDates (they don't have to be back to back),
// or the following days if those weren't given
export function datesOf(ws) {
  const n = lengthOf(ws);
  const more = Array.isArray(ws?.moreDates) ? ws.moreDates : [];
  return [ws.date, ...Array.from({ length: n - 1 }, (_, i) => more[i] || addDays(ws.date, i + 1))];
}

// "2-Day Business Owners Workshop" -> "1-Day Business Owners Workshop" for a 1-day run
// Keeps the style: "2-Day" -> "1-Day", "2-Days" -> "1-Day", "1 day" -> "2 days"
export const titleForLength = (title, n) => String(title || '').replace(new RegExp(LENGTH_RE().source, 'i'), (m) => {
  const sep = m.match(/[-\s]/)[0], plural = /s$/i.test(m) && n > 1;
  return `${n}${sep}${/D/.test(m) ? 'Day' : 'day'}${plural ? 's' : ''}`;
});
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
// The run as it is now (for "earlier it was ..." in a reschedule announcement)
export const snapshotOf = (ws) => ({ programmeId: ws.programmeId, date: ws.date, days: lengthOf(ws), moreDates: datesOf(ws).slice(1), startTime: ws.startTime, timeLabel: timeLabelOf(ws) });

// The run after a reschedule: new day 1, length, later days and time. If the later days weren't given,
// they move with day 1 and keep the same gaps (e.g. "two Saturdays in a row" stays that way).
export function rescheduledTo(ws, pr) {
  const days = Number(pr.days) || lengthOf(ws);
  let more = Array.isArray(pr.moreDates) && pr.moreDates.length ? pr.moreDates.slice(0, days - 1) : [];
  if (!more.length) {
    const shift = daysBetween(ws.date, pr.date);
    more = datesOf(ws).slice(1, days).map((d) => addDays(d, shift));
  }
  while (more.length < days - 1) more.push(addDays(more[more.length - 1] || pr.date, 1));
  return {
    ...ws, date: pr.date, days, moreDates: more,
    startTime: pr.startTime || ws.startTime,
    timeLabel: pr.timeLabel || (pr.startTime ? '' : ws.timeLabel), // blank = derived from startTime
  };
}

// "Saturday, 21 November and Saturday, 28 November", or "A, B and C"
const datesText = (ws) => {
  const all = datesOf(ws).map(prettyDate);
  return all.length === 1 ? all[0] : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
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
    date_text: datesText(ws), // every day of the workshop
    time_text: timeLabelOf(ws),
  };
  if (old) {
    const was = lengthOf(old);
    factSheet.old_date_text = datesText(old);
    factSheet.old_time_text = old.timeLabel || '';
    if (was !== n) factSheet.old_length_text = lengthText(was);
    // what exactly changed, so the announcement says the right thing
    const changed = [];
    if (old.date !== ws.date) changed.push('start date');
    else if (was === n && datesText(old) !== datesText(ws)) changed.push('dates of the later days');
    if ((old.timeLabel || '') !== timeLabelOf(ws)) changed.push('time');
    if (was !== n) changed.push('length');
    factSheet.what_changed = changed.join(', ') || 'details';
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
