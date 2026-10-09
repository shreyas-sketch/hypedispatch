// Checks every minute:
//  1. Reschedules: announced 5 minutes after you save them (so you can still cancel), or right away with "Announce now"
//  2. Daily messages: hype / tomorrow / day-of, sent once per day at each workshop's send time
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db, save, log } from './db.js';
import { dataDir } from './paths.js';
import { nowParts, phaseFor, sendTimeFor, addDays } from './time.js';
import { composeMessage, withLinks, linksFor } from './ai.js';
import { sendText, sleep, isConnected, onSendRejected, describeRejection } from './wa.js';
import { resolve, timeLabelOf, displayName, programmeOf } from './workshop.js';

const running = new Set();
const sending = new Set(); // "date|phase|group" being sent right now, so two workshops can't both send to one group at once
const warned = new Set(); // problems already logged today, so the minute-by-minute check doesn't flood the log
const GAP_MIN = Number(process.env.GROUP_GAP_MIN_MS || 4000);
const GAP_MAX = Number(process.env.GROUP_GAP_MAX_MS || 7000);
// Minutes between saving a reschedule and announcing it
export const RESCHEDULE_DELAY_MIN = () => Number(process.env.RESCHEDULE_DELAY_MIN || 5);
export const sendAtOf = (pr) => pr.sendAt || new Date(Date.parse(pr.enteredAt || 0) + RESCHEDULE_DELAY_MIN() * 60_000).toISOString();

// Retry policy: failed groups are retried every RETRY_EVERY_MIN minutes, up to MAX_ROUNDS attempts.
// While the sending number is disconnected (e.g. during a redeploy) we just wait; that doesn't use up attempts.
const RETRY_EVERY_MIN = 5;
const MAX_ROUNDS = 12; // about an hour of retries
const notYet = (rec, now) => rec?.nextTryAt && now.getTime() < Date.parse(rec.nextTryAt);

// Only one copy of Hype Dispatch may send from the same data at a time (e.g. while a Railway redeploy overlaps)
const INSTANCE = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
const LOCK_STALE_MS = 90_000;
const lockFile = () => path.join(dataDir(), 'scheduler.lock');
function readLock() { try { return JSON.parse(fs.readFileSync(lockFile(), 'utf8')); } catch { return null; } }
export function holdSchedulerLock() {
  const l = readLock();
  if (l && l.id !== INSTANCE && Date.now() - l.beat < LOCK_STALE_MS) return false;
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(lockFile(), JSON.stringify({ id: INSTANCE, beat: Date.now() }));
  return true;
}
function lockedTick() {
  if (!holdSchedulerLock()) {
    warnOnce(`lock|${nowParts().date}|${nowParts().hm.slice(0, 2)}`, 'warn', 'Another copy of Hype Dispatch is running on the same data, so this copy is not sending (it takes over if the other stops for 90 seconds).', { kind: 'system' });
    return Promise.resolve();
  }
  return tick();
}

export function startScheduler() {
  // Sends left unfinished by an older version: stop them rather than risk a duplicate of a manual resend
  let changed = false;
  for (const s of db().sends) if (!s.done && !s.retryVersion) { s.done = true; s.note = 'stopped when Hype Dispatch was updated'; changed = true; }
  if (changed) save();
  setInterval(() => lockedTick().catch((e) => log('error', `Scheduler: ${e.message}`)), 60_000);
  setInterval(() => { if (readLock()?.id === INSTANCE) holdSchedulerLock(); }, 20_000); // heartbeat
  setTimeout(() => lockedTick().catch(() => {}), 15_000); // catch up shortly after boot
}

function warnOnce(key, level, msg, extra = {}) {
  if (warned.has(key)) return;
  warned.add(key);
  log(level, msg, extra);
}

const PHASE_NAME = { hype: 'daily hype message', tomorrow: '"it\'s tomorrow" reminder', dayof: 'workshop-day message', reschedule: 'date-change announcement' };
const clock = (hm) => { if (!hm) return ''; let [h, m] = hm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}${m ? ':' + String(m).padStart(2, '0') : ''} ${ap}`; };

// WhatsApp refused a message after it was sent: mark that group failed, retry only if it could help
onSendRejected((accountId, msgId, jid, code) => {
  const d = db();
  const rec = d.sends.find((s) => Object.entries(s.results || {}).some(([j, r]) => j === jid && r.msgId === msgId));
  if (!rec) { // e.g. a preview sent by hand
    if (warned.has(`rej|${msgId}`)) return;
    warned.add(`rej|${msgId}`);
    log('warn', `WhatsApp refused a message to ${jid}. ${describeRejection(code).text}`, { kind: 'notsent' });
    return;
  }
  // WhatsApp accepted this message, then sent an error notice. That notice can mean a single member's device
  // couldn't show it while everyone else got it, so we NEVER resend automatically (that caused duplicates).
  // A clear refusal (not allowed to post etc.) is shown as not sent; anything else as a warning to check.
  const r = rec.results[jid];
  const why = describeRejection(code);
  if (why.permanent) rec.results[jid] = { ...r, ok: false, permanent: true, error: why.text };
  else rec.results[jid] = { ...r, warning: `WhatsApp reported error ${code || 'unknown'} for this message; it may not have reached everyone` };
  save();
  if (why.permanent) log('error', `${rec.workshop}: ${PHASE_NAME[rec.phase]} did NOT reach ${r.name}. ${why.text}`, { kind: 'notsent', workshopId: rec.workshopId, key: rec.key });
  else warnOnce(`${rec.key}|${jid}|ackerr`, 'warn', `${rec.workshop}: WhatsApp reported a delivery problem (error ${code || 'unknown'}) for the ${PHASE_NAME[rec.phase]} in ${r.name}. It usually still reached the group; it will NOT be resent automatically. Check the group if in doubt.`, { kind: 'notsent', workshopId: rec.workshopId, key: rec.key });
});

function launch(key, fn, label) {
  if (running.has(key)) return;
  running.add(key);
  fn().catch((e) => log('error', `${label}: ${e.message}`)).finally(() => running.delete(key));
}

let warnedDate = '';
// No automatic daily messages late at night (e.g. after the server was down all day, or a workshop added in the evening)
export const LATEST_SEND_TIME = () => process.env.LATEST_SEND_TIME || '22:00';

export async function tick(now = new Date()) {
  const { date, hm } = nowParts(now);
  if (date !== warnedDate) { warned.clear(); warnedDate = date; }
  const d = db();
  for (const ws of d.workshops) {
    try { tickOne(ws, now, date, hm, d); } catch (e) { warnOnce(`${ws.id}|${date}|crash`, 'error', `Workshop ${ws.id} could not be checked (${e.message}). Open it and save it again.`, { kind: 'notsent', workshopId: ws.id }); }
  }
}

function tickOne(ws, now, date, hm, d) {
  {
    const name = displayName(ws);
    // Once today's send time has passed, any reason for NOT sending is written to the activity log (once a day)
    const slot = phaseFor(ws, date).phase;
    const slotDue = slot && hm >= sendTimeFor(ws, slot);
    const why = (reason, level = 'warn') => slotDue && warnOnce(`${ws.id}|${date}|why`, level,
      `${name}: today's ${PHASE_NAME[slot]} (${clock(sendTimeFor(ws, slot))}) was NOT sent: ${reason}`, { kind: 'notsent', workshopId: ws.id });
    if (ws.active === false) { why('the workshop is paused (More settings → Sending)', 'info'); return; }

    // 1. Pending reschedule: hold everything else for this workshop until it's announced
    const pr = ws.pendingReschedule;
    if (pr) {
      if (pr.sendNow || now.getTime() >= Date.parse(sendAtOf(pr))) {
        launch(`${ws.id}|${date}|reschedule`, () => runReschedule(ws, date, now), name);
      } else why(`a date change to ${pr.date} is waiting to be announced (at ${clock(nowParts(new Date(sendAtOf(pr))).hm)}); regular messages pause until then`);
      return;
    }
    // A reschedule went out today: finish delivering it. It replaces today's daily hype, but the
    // day-before and workshop-day messages still go out (they carry the Zoom link).
    const rrec = d.sends.find((s) => s.workshopId === ws.id && s.phase === 'reschedule' && s.date === date);
    if (rrec) {
      if (!rrec.done && !notYet(rrec, now)) launch(rrec.key, () => deliver(ws, rrec, now), name);
      if (slot === 'hype' || !slot) { why('the date-change announcement went out today instead', 'info'); return; }
      if (!rrec.done) return; // send the announcement first
    }

    // 2. Regular daily message
    if (ws.firstSendDate && date < ws.firstSendDate) { why(`it's set to start sending from ${ws.firstSendDate} (More settings → Start sending from)`); return; }
    const phase = slot;
    if (!phase || !slotDue) return;
    const key = `${ws.id}|${date}|${phase}`;
    const rec = d.sends.find((s) => s.key === key);
    if (phase === 'dayof' && ws.startTime && hm >= ws.startTime && !rec?.done) {
      if (rec) { rec.done = true; rec.note = 'stopped: the workshop had started'; save(); }
      why(`the workshop had already started (${clock(ws.startTime)}) before it could go out`);
      return;
    }
    if (!ws.groups?.length) { why('no WhatsApp groups are picked for it'); return; }
    if (!ws.account) { why('no sending WhatsApp number is picked for it'); return; }
    if (rec?.done || notYet(rec, now)) return;
    if (hm >= LATEST_SEND_TIME() && !rec) { why(`it was already past ${clock(LATEST_SEND_TIME())}, too late in the night to message the groups (it was probably down, or added in the evening)`); return; }
    launch(key, () => runSend(ws, phase, date, key, now), name);
  }
}

// Everything lined up to go out in the next few days (shown on the dashboard, no approval needed)
export function lineup(now = new Date(), days = 7) {
  const { date: today, hm } = nowParts(now);
  const d = db();
  const out = [];
  for (const orig of d.workshops) {
    try { lineupOne(orig, now, today, hm, d, days, out); } catch (e) { console.error('lineup:', orig.id, e.message); }
  }
  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

function lineupOne(orig, now, today, hm, d, days, out) {
  {
    const base = { workshopId: orig.id, workshop: displayName(orig), groups: orig.groups?.length || 0 };
    const blocked = orig.active === false ? 'Paused'
      : !programmeOf(orig)?.factSheet ? 'Fact sheet missing'
      : !orig.groups?.length ? 'No groups picked'
      : !orig.account ? 'No sending number picked'
      : !isConnected(orig.account) ? 'WhatsApp number not connected' : '';
    let ws = orig;
    let skipToday = d.sends.some((s) => s.workshopId === orig.id && s.phase === 'reschedule' && s.date === today); // replaces today's hype only
    const pr = orig.pendingReschedule;
    if (pr) {
      const at = nowParts(new Date(Math.max(Date.parse(sendAtOf(pr)), now.getTime())));
      out.push({ ...base, phase: 'reschedule', date: at.date, time: pr.sendNow ? hm : at.hm, newDate: pr.date, links: linksFor(orig, 'reschedule').map((l) => l.kind), blocked, due: pr.sendNow || now.getTime() >= Date.parse(sendAtOf(pr)) });
      // After the announcement, the daily messages continue toward the new date
      ws = { ...orig, date: pr.date, startTime: pr.startTime || orig.startTime };
      if (at.date === today) skipToday = true;
    }
    for (let i = 0; i < days; i++) {
      const day = addDays(today, i);
      if (i === 0 && skipToday && phaseFor(ws, day).phase === 'hype') continue;
      if (ws.firstSendDate && day < ws.firstSendDate) continue;
      const { phase } = phaseFor(ws, day);
      if (!phase) continue;
      const time = sendTimeFor(ws, phase);
      const rec = d.sends.find((s) => s.key === `${ws.id}|${day}|${phase}`);
      if (rec?.done) continue; // already sent
      if (i === 0 && phase === 'dayof' && ws.startTime && hm >= ws.startTime) continue; // workshop already started
      if (i === 0 && !rec && hm >= LATEST_SEND_TIME()) continue; // too late tonight
      // every group already got this type of message today from another workshop
      if (i === 0 && ws.groups?.length && ws.groups.every((g) => d.sends.some((s) => s.workshopId !== ws.id && s.date === day && s.phase === phase && s.results?.[g.jid]?.ok))) continue;
      const cur = new Set((ws.groups || []).map((g) => g.jid));
      const failedNow = rec ? Object.entries(rec.results || {}).filter(([jid, r]) => !r.ok && cur.has(jid)).map(([, r]) => r) : [];
      const retry = rec?.waiting ? `${rec.waiting}, will send as soon as it reconnects`
        : failedNow.length ? `${failedNow.length} group${failedNow.length > 1 ? 's' : ''} failed (${failedNow[0].error}), retrying${rec.nextTryAt ? ` at ${nowParts(new Date(rec.nextTryAt)).hm}` : ''}` : '';
      out.push({ ...base, phase, date: day, time, links: linksFor(ws, phase).map((l) => l.kind), blocked, retry, due: i === 0 && hm >= time });
    }
  }
}

// Draft once per day+phase, then deliver
export async function runSend(ws, phase, date, key, now = new Date()) {
  const d = db();
  const name = displayName(ws);
  const r = resolve(ws);
  if (!r) { warnOnce(`${ws.id}|${date}|why`, 'error', `${name}: today's ${PHASE_NAME[phase]} was NOT sent: its programme has no fact sheet yet (Programmes → Build)`, { kind: 'notsent', workshopId: ws.id }); return; }
  if (!ws.groups?.length) return;

  let rec = d.sends.find((s) => s.key === key);
  if (!rec) {
    const previous = d.history[ws.id] || [];
    const out = await composeMessage(r, phase, previous);
    rec = newRecord(ws, key, date, phase, withLinks(out.text, r, phase), out);
    d.history[ws.id] = [...previous, out.text].slice(-12);
    save();
    logWritten(rec, out);
  }
  await deliver(ws, rec, now);
}

// Announce a reschedule, then move the workshop to its new date
export async function runReschedule(ws, date, now = new Date()) {
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
  if (!r) { warnOnce(`${ws.id}|${date}|reschedule|nofacts`, 'error', `${name}: the date change could NOT be announced: its programme has no fact sheet yet`, { kind: 'notsent', workshopId: ws.id }); return; }

  const out = await composeMessage(r, 'reschedule', d.history[ws.id] || []);

  // Apply the change and create the send record together, so a crash can't lose it.
  // Stop if it was cancelled, changed (the next check announces the new one) or the workshop deleted while writing.
  if (ws.pendingReschedule !== pr || !db().workshops.includes(ws)) return;
  Object.assign(ws, { date: next.date, startTime: next.startTime, timeLabel: next.timeLabel });
  ws.reschedules = [...(ws.reschedules || []), { from: old.date, to: next.date, at: new Date().toISOString() }];
  delete ws.pendingReschedule;
  const rec = newRecord(ws, `${ws.id}|${date}|reschedule`, date, 'reschedule', withLinks(out.text, r, 'reschedule'), out);
  rec.fromDate = old.date;
  d.history[ws.id] = [...(d.history[ws.id] || []), out.text].slice(-12);
  save();
  log('info', `${name}: moved from ${old.date} to ${next.date}, announcing to ${ws.groups?.length || 0} groups`, { kind: 'change', workshopId: ws.id });
  logWritten(rec, out);
  if (ws.groups?.length) await deliver(ws, rec, now);
  else { rec.done = true; save(); }
}

function newRecord(ws, key, date, phase, text, out) {
  const d = db();
  const rec = {
    key, workshopId: ws.id, workshop: displayName(ws), date, phase,
    text, source: out.source, note: out.error || null,
    results: {}, done: false, createdAt: new Date().toISOString(), retryVersion: 2,
  };
  d.sends = d.sends.filter((s) => s.key !== key);
  d.sends.unshift(rec);
  d.sends = d.sends.slice(0, 400);
  return rec;
}

function logWritten(rec, out) {
  const how = out.source === 'ai' ? `written by Claude${out.attempts > 1 ? ` (attempt ${out.attempts})` : ''}` : `written from the safe template, because ${out.error}`;
  log(out.source === 'ai' ? 'info' : 'warn', `${rec.workshop}: ${PHASE_NAME[rec.phase]} ${how}`, { kind: 'info', workshopId: rec.workshopId, key: rec.key });
}

// Send to each group; skips groups already done, so it resumes after crashes
export async function deliver(ws, rec, now = new Date()) {
  if (!isConnected(ws.account)) {
    // Don't burn attempts while WhatsApp is (re)connecting: check again next minute
    rec.waiting = 'WhatsApp number not connected';
    rec.nextTryAt = new Date(now.getTime() + 60_000).toISOString();
    save();
    warnOnce(`${rec.key}|offline`, 'warn', `${rec.workshop}: ${PHASE_NAME[rec.phase]} is waiting: the sending WhatsApp number isn't connected. It goes out as soon as it reconnects.`, { kind: 'notsent', workshopId: rec.workshopId, key: rec.key });
    return;
  }
  delete rec.waiting;
  for (const g of ws.groups || []) {
    // Paused or deleted meanwhile (e.g. while the message was being written): stop here
    if (ws.active === false || !db().workshops.includes(ws)) { rec.done = true; rec.note = ws.active === false ? 'stopped: the workshop was paused' : 'stopped: the workshop was deleted'; save(); return; }
    const prev = rec.results[g.jid];
    if (prev?.ok || prev?.permanent || prev?.uncertain) continue; // done, never accepted, or might already be there
    // Never send the same kind of message to a group twice in one day, whichever workshop it comes from
    const slotKey = `${rec.date}|${rec.phase}|${g.jid}`;
    const already = db().sends.find((s) => s !== rec && s.date === rec.date && s.phase === rec.phase && s.results?.[g.jid]?.ok)
      || (sending.has(slotKey) && { workshop: 'another workshop (sending right now)' });
    if (already) {
      rec.results[g.jid] = { ok: true, skipped: true, name: g.name, note: `already got today's ${PHASE_NAME[rec.phase]} from ${already.workshop}` };
      log('warn', `${rec.workshop}: skipped ${g.name}, it already got today's ${PHASE_NAME[rec.phase]} from ${already.workshop} (two workshops send to this group?)`, { kind: 'notsent', workshopId: rec.workshopId, key: rec.key });
      save();
      continue;
    }
    sending.add(slotKey);
    try {
      const msgId = await sendText(ws.account, g.jid, rec.text);
      rec.results[g.jid] = { ok: true, name: g.name, at: new Date().toISOString(), msgId };
    } catch (e) {
      const code = e.output?.statusCode || e.data?.attrs?.code || e.message;
      const why = /^(401|403|404|406|forbidden|not-authorized|item-not-found|not-acceptable)$/.test(String(code)) ? describeRejection(code) : null;
      // A timeout means we don't know if it went out: don't risk a duplicate, flag it instead
      const uncertain = /timed out/i.test(e.message);
      rec.results[g.jid] = { ok: false, name: g.name, error: why ? why.text : uncertain ? 'Sending took too long; it may or may not have gone out. Not resent, to avoid a duplicate. Check the group.' : e.message, permanent: !!why?.permanent, uncertain };
    } finally { sending.delete(slotKey); }
    save();
    await sleep(GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
  }
  const current = new Set((ws.groups || []).map((g) => g.jid));
  const failed = Object.entries(rec.results).filter(([jid, r]) => !r.ok && current.has(jid)).map(([, r]) => r);
  const retryable = failed.filter((r) => !r.permanent && !r.uncertain);
  rec.rounds = (rec.rounds || 0) + 1;
  rec.done = retryable.length === 0 || rec.rounds >= MAX_ROUNDS;
  rec.nextTryAt = rec.done ? null : new Date(now.getTime() + RETRY_EVERY_MIN * 60_000).toISOString();
  save();
  const total = ws.groups?.length || 0;
  const failedNames = failed.map((f) => f.name).join(', ');
  const tag = { workshopId: rec.workshopId, key: rec.key };
  const okNames = Object.values(rec.results).filter((r) => r.ok).map((r) => r.name).join(', ');
  if (!failed.length) log('info', `${rec.workshop}: ${PHASE_NAME[rec.phase]} sent to ${total}/${total} groups (${okNames})`, { ...tag, kind: 'sent' });
  else if (rec.done && !retryable.length) log('error', `${rec.workshop}: ${PHASE_NAME[rec.phase]} sent to ${total - failed.length}/${total} groups. NOT sent to ${failedNames}: ${failed[0].error}`, { ...tag, kind: 'notsent' });
  else if (rec.done) log('error', `${rec.workshop}: gave up on ${failedNames} after ${rec.rounds} tries (${failed[0].error}). Send to them manually.`, { ...tag, kind: 'notsent' });
  else log('warn', `${rec.workshop}: ${PHASE_NAME[rec.phase]} sent to ${total - failed.length}/${total} groups. Retrying ${failedNames} in ${RETRY_EVERY_MIN} min (${failed[0].error})`, { ...tag, kind: 'notsent' });
}
