// Checks every minute:
//  1. Reschedules: announced at the daily check time (7 PM IST by default), or right away if you press "Announce now"
//  2. Daily messages: hype / tomorrow / day-of, sent once per day at each workshop's send time
import { db, save, log } from './db.js';
import { nowParts, phaseFor, sendTimeFor } from './time.js';
import { composeMessage, withLinks } from './ai.js';
import { sendText, sleep } from './wa.js';
import { resolve, timeLabelOf, displayName } from './workshop.js';

const running = new Set();
const GAP_MIN = Number(process.env.GROUP_GAP_MIN_MS || 4000);
const GAP_MAX = Number(process.env.GROUP_GAP_MAX_MS || 7000);
export const RESCHEDULE_CHECK = () => process.env.RESCHEDULE_CHECK_TIME || '19:00';

export function startScheduler() {
  setInterval(() => tick().catch((e) => log('error', `Scheduler: ${e.message}`)), 60_000);
  setTimeout(() => tick().catch(() => {}), 15_000); // catch up shortly after boot
}

function launch(key, fn, label) {
  if (running.has(key)) return;
  running.add(key);
  fn().catch((e) => log('error', `${label}: ${e.message}`)).finally(() => running.delete(key));
}

export async function tick(now = new Date()) {
  const { date, hm } = nowParts(now);
  const d = db();
  for (const ws of d.workshops) {
    if (ws.active === false) continue;
    const name = displayName(ws);

    // 1. Pending reschedule: hold everything else for this workshop until it's announced
    const pr = ws.pendingReschedule;
    if (pr) {
      if (pr.sendNow || hm >= RESCHEDULE_CHECK() || date > pr.enteredDate) {
        launch(`${ws.id}|${date}|reschedule`, () => runReschedule(ws, date), name);
      }
      continue;
    }
    // A reschedule went out today: finish delivering it, and skip regular messages today
    const rrec = d.sends.find((s) => s.workshopId === ws.id && s.phase === 'reschedule' && s.date === date);
    if (rrec) {
      if (!rrec.done) launch(rrec.key, () => deliver(ws, rrec), name);
      continue;
    }

    // 2. Regular daily message
    if (ws.firstSendDate && date < ws.firstSendDate) continue;
    const { phase } = phaseFor(ws, date);
    if (!phase) continue;
    if (hm < sendTimeFor(ws, phase)) continue;
    if (phase === 'dayof' && ws.startTime && hm >= ws.startTime) continue; // already started
    const key = `${ws.id}|${date}|${phase}`;
    if (d.sends.find((s) => s.key === key)?.done) continue;
    launch(key, () => runSend(ws, phase, date, key), name);
  }
}

// Draft once per day+phase, then deliver
export async function runSend(ws, phase, date, key) {
  const d = db();
  const name = displayName(ws);
  const r = resolve(ws);
  if (!r) { log('error', `${name}: its programme has no fact sheet yet, skipped the ${phase} message`); return; }
  if (!ws.groups?.length) { log('warn', `${name}: no groups selected`); return; }

  let rec = d.sends.find((s) => s.key === key);
  if (!rec) {
    const previous = d.history[ws.id] || [];
    const out = await composeMessage(r, phase, previous);
    rec = newRecord(ws, key, date, phase, withLinks(out.text, ws, phase), out);
    d.history[ws.id] = [...previous, out.text].slice(-12);
    save();
  }
  await deliver(ws, rec);
}

// Announce a reschedule, then move the workshop to its new date
export async function runReschedule(ws, date) {
  const d = db();
  const pr = ws.pendingReschedule;
  if (!pr) return;
  const name = displayName(ws);
  const old = { date: ws.date, startTime: ws.startTime, timeLabel: timeLabelOf(ws) };
  const next = {
    ...ws,
    date: pr.date,
    startTime: pr.startTime || ws.startTime,
    timeLabel: pr.timeLabel || (pr.startTime ? '' : ws.timeLabel), // blank = derived from startTime
  };
  const r = resolve(next, old);
  if (!r) { log('error', `${name}: its programme has no fact sheet yet, can't announce the reschedule`); return; }

  const out = await composeMessage(r, 'reschedule', d.history[ws.id] || []);

  // Apply the change and create the send record together, so a crash can't lose it
  if (!ws.pendingReschedule) return;
  Object.assign(ws, { date: next.date, startTime: next.startTime, timeLabel: next.timeLabel });
  ws.reschedules = [...(ws.reschedules || []), { from: old.date, to: next.date, at: new Date().toISOString() }];
  delete ws.pendingReschedule;
  const rec = newRecord(ws, `${ws.id}|${date}|reschedule`, date, 'reschedule', out.text, out);
  rec.fromDate = old.date;
  d.history[ws.id] = [...(d.history[ws.id] || []), out.text].slice(-12);
  save();
  log('info', `${name}: moved from ${old.date} to ${next.date}, announcing to ${ws.groups?.length || 0} groups`);
  if (ws.groups?.length) await deliver(ws, rec);
  else { rec.done = true; save(); }
}

function newRecord(ws, key, date, phase, text, out) {
  const d = db();
  const rec = {
    key, workshopId: ws.id, workshop: displayName(ws), date, phase,
    text, source: out.source, note: out.error || null,
    results: {}, done: false, createdAt: new Date().toISOString(),
  };
  d.sends = d.sends.filter((s) => s.key !== key);
  d.sends.unshift(rec);
  d.sends = d.sends.slice(0, 400);
  if (out.source === 'fallback') log('warn', `${rec.workshop}: used safe template (${out.error})`);
  return rec;
}

// Send to each group; skips groups already done, so it resumes after crashes
export async function deliver(ws, rec) {
  for (const g of ws.groups || []) {
    if (rec.results[g.jid]?.ok) continue;
    try {
      await sendText(ws.account, g.jid, rec.text);
      rec.results[g.jid] = { ok: true, name: g.name, at: new Date().toISOString() };
    } catch (e) {
      rec.results[g.jid] = { ok: false, name: g.name, error: e.message };
    }
    save();
    await sleep(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
  }
  const failed = Object.values(rec.results).filter((r) => !r.ok);
  rec.rounds = (rec.rounds || 0) + 1;
  rec.done = failed.length === 0 || rec.rounds >= 3; // failed groups retried next minute, max 3 rounds
  save();
  const total = ws.groups?.length || 0;
  log(failed.length ? 'warn' : 'info',
    `${rec.workshop}: ${rec.phase} message sent to ${total - failed.length}/${total} groups`
    + (failed.length ? ` (failed: ${failed.map((f) => f.name).join(', ')})` : ''));
}
