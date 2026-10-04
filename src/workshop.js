// Joins a dated workshop run with its programme's fact sheet.
import { db } from './db.js';
import { prettyDate, prettyTime } from './time.js';
import { PRICE } from './ai.js';

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

export function timeLabelOf(ws) {
  return ws.timeLabel || (ws.startTime ? `${prettyTime(ws.startTime)} IST` : '');
}

// The fact sheet Claude sees for this run: programme facts + this run's date and time.
// `old` is only passed for the reschedule announcement.
export function resolve(ws, old = null) {
  const prog = programmeOf(ws);
  if (!prog?.factSheet) return null;
  const factSheet = {
    ...withoutPrice(prog.factSheet),
    date_text: prettyDate(ws.date),
    time_text: timeLabelOf(ws),
  };
  if (old) {
    factSheet.old_date_text = prettyDate(old.date);
    factSheet.old_time_text = old.timeLabel || '';
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
