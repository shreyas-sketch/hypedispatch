// Joins a dated workshop run with its programme's fact sheet.
import { db } from './db.js';
import { prettyDate, prettyTime } from './time.js';

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
    ...prog.factSheet,
    date_text: prettyDate(ws.date),
    time_text: timeLabelOf(ws),
  };
  if (old) {
    factSheet.old_date_text = prettyDate(old.date);
    factSheet.old_time_text = old.timeLabel || '';
  }
  return { ...ws, name: ws.name || prog.name, signature: prog.signature || '', factSheet };
}

export function displayName(ws) {
  const prog = programmeOf(ws);
  return ws.name || `${prog?.name || 'Workshop'} · ${ws.date}`;
}
