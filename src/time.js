// All scheduling happens in one timezone (IST by default), regardless of the PC clock.
export const TZ = process.env.TIMEZONE || 'Asia/Kolkata';

export function nowParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${hour}:${p.minute}` };
}

// Whole calendar days from a -> b (both 'YYYY-MM-DD')
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// Which message a workshop needs on a given day
//   2+ days out  -> hype
//   1 day out    -> tomorrow  (form + zoom links)
//   same day     -> dayof     (zoom link), if enabled
export function phaseFor(ws, today) {
  const d = daysBetween(today, ws.date);
  if (d >= 2) return { phase: 'hype', daysLeft: d };
  if (d === 1) return { phase: 'tomorrow', daysLeft: 1 };
  if (d === 0 && ws.dayOf !== false) return { phase: 'dayof', daysLeft: 0 };
  return { phase: null, daysLeft: d };
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function sendTimeFor(ws, phase) {
  return phase === 'dayof' ? (ws.dayOfTime || ws.sendTime || '10:00') : (ws.sendTime || '11:00');
}

export function prettyDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

export function prettyTime(hm) {
  if (!hm) return '';
  let [h, m] = hm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`;
}
