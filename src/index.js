import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, save, newId, log } from './db.js';
import { startAccount, accountStatus, listGroups, logoutAccount, sendText, resyncAccount } from './wa.js';
import { fetchPageText, extractFacts, composeMessage, withLinks } from './ai.js';
import { startScheduler, RESCHEDULE_DELAY_MIN, lineup } from './scheduler.js';
import { nowParts, phaseFor, prettyTime } from './time.js';
import { resolve, timeLabelOf, displayName, syncWorkshopGroups } from './workshop.js';
import { onRailway, storageIsTemporary, dataDir } from './paths.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Optional password for the dashboard
// Health check for Railway (before the password, and reveals nothing)
app.get('/healthz', (req, res) => res.send('ok'));

// Only this PC by default. On Railway (or with HOST=0.0.0.0) it's reachable by others, so a password is required.
const HOST = process.env.HOST || (onRailway() ? '0.0.0.0' : '127.0.0.1');
const isPublic = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const PASS = process.env.DASHBOARD_PASSWORD;
if (isPublic && !PASS) {
  // Never expose the controls for your WhatsApp numbers without a password
  app.use((req, res) => res.status(503).type('html').send('<h2>Hype Dispatch is locked</h2><p>Set a <code>DASHBOARD_PASSWORD</code> variable (on Railway: your service → Variables), then redeploy. Log in with any username and that password.</p>'));
}
if (PASS) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const creds = Buffer.from(b64 || '', 'base64').toString();
    const pw = creds.slice(creds.indexOf(':') + 1); // passwords may contain ':'
    if (creds.includes(':') && pw === PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="Hype Dispatch"').status(401).send('Password required');
  });
}
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

// Promise.resolve().then() so synchronous throws also come back as { error } instead of an HTML stack trace
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const findWs = (id) => { const w = db().workshops.find((x) => x.id === id); if (!w) throw new Error('Workshop not found'); return w; };
// Only ids we created are allowed near the file system (auth folders are deleted by id)
const findAcc = (id) => { const a = db().accounts.find((x) => x.id === id); if (!a) throw new Error('WhatsApp number not found'); return a; };
const findProg = (id) => { const p = db().programmes.find((x) => x.id === id); if (!p) throw new Error('Programme not found'); return p; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// ----- state -----
app.get('/api/state', (req, res) => {
  const d = db();
  const { date, hm } = nowParts();
  res.json({
    now: { date, hm },
    aiReady: !!process.env.ANTHROPIC_API_KEY,
    storageWarning: storageIsTemporary(),
    nowMs: Date.now(),
    tz: process.env.TIMEZONE || 'Asia/Kolkata',
    rescheduleDelay: RESCHEDULE_DELAY_MIN(),
    lineup: lineup(),
    programmes: d.programmes.map((p) => ({ ...p, pageText: undefined })),
    accounts: d.accounts.map((a) => ({ ...a, ...accountStatus(a.id) })),
    workshops: d.workshops.map((w) => ({ ...w, displayName: displayName(w), timeLabelShown: timeLabelOf(w), today: phaseFor(w, date) })),
    sends: d.sends.slice(0, 60),
    log: (d.log || []).slice(0, 200),
  });
});

// ----- WhatsApp numbers -----
app.post('/api/accounts', wrap(async (req, res) => {
  const name = (req.body.name || '').trim() || `Number ${db().accounts.length + 1}`;
  const acc = { id: newId(), name };
  db().accounts.push(acc); save();
  await startAccount(acc.id);
  res.json(acc);
}));
app.post('/api/accounts/:id/connect', wrap(async (req, res) => { await startAccount(findAcc(req.params.id).id); res.json({ ok: true }); }));
app.delete('/api/accounts/:id', wrap(async (req, res) => {
  await logoutAccount(findAcc(req.params.id).id);
  db().accounts = db().accounts.filter((a) => a.id !== req.params.id); save();
  res.json({ ok: true });
}));
app.post('/api/accounts/:id/resync', wrap(async (req, res) => {
  const acc = findAcc(req.params.id);
  const status = await resyncAccount(acc.id);
  if (status === 'scan-qr') return res.json({ status, message: `${acc.name} needs to be linked again: scan the new QR` });
  if (status !== 'connected') throw new Error(`${acc.name} couldn't reconnect (${status}). Check that the phone is online and this server has internet, then try again.`);
  const groups = await listGroups(acc.id);
  const { renamed, missing } = syncWorkshopGroups(acc.id, groups);
  save();
  const message = `${acc.name} resynced: ${groups.length} groups${renamed ? `, ${renamed} renamed` : ''}`
    + (missing.length ? `. No longer in: ${missing.map((m) => `${m.group} (${m.workshop})`).join(', ')}` : '');
  log(missing.length ? 'warn' : 'info', message, { kind: 'system' });
  res.json({ status, groups: groups.length, renamed, missing, message });
}));
app.get('/api/accounts/:id/groups', wrap(async (req, res) => res.json(await listGroups(findAcc(req.params.id).id))));

// ----- programmes (one per landing page) -----
app.post('/api/programmes', wrap((req, res) => {
  const p = { id: newId(), name: req.body.name || 'New programme', landingUrl: req.body.landingUrl || '', focus: req.body.focus || '', signature: req.body.signature || '', factSheet: null };
  db().programmes.push(p); save(); res.json(p);
}));
app.put('/api/programmes/:id', wrap((req, res) => {
  const p = findProg(req.params.id);
  for (const k of ['name', 'landingUrl', 'focus', 'signature', 'factSheet']) if (k in req.body) p[k] = req.body[k];
  save(); res.json({ ...p, pageText: undefined });
}));
app.delete('/api/programmes/:id', wrap((req, res) => {
  if (db().workshops.some((w) => w.programmeId === req.params.id)) throw new Error('Some workshops still use this programme');
  db().programmes = db().programmes.filter((p) => p.id !== req.params.id); save(); res.json({ ok: true });
}));
// Read landing page (or pasted text) -> fact sheet
app.post('/api/programmes/:id/facts', wrap(async (req, res) => {
  const p = findProg(req.params.id);
  const pageText = req.body.pastedText?.trim() || await fetchPageText(p.landingUrl);
  p.pageText = pageText;
  p.factSheet = await extractFacts(pageText, p.focus);
  p.factsAt = new Date().toISOString();
  save();
  log('info', `${p.name}: fact sheet built from landing page`, { kind: 'change' });
  res.json(p.factSheet);
}));

// ----- workshops (a dated run of a programme, sent to its communities) -----
const FIELDS = ['name', 'programmeId', 'date', 'startTime', 'timeLabel', 'sendTime', 'dayOf', 'dayOfTime',
  'account', 'groups', 'zoomLink', 'formLink', 'active', 'firstSendDate'];
function applyFields(ws, body) {
  for (const k of FIELDS) if (k in body) ws[k] = body[k];
  if (!isDate(ws.date)) throw new Error('Workshop date is required');
  if (!ws.programmeId) throw new Error('Pick which programme (landing page) this is');
  if (!Array.isArray(ws.groups)) ws.groups = [];
  return ws;
}
app.post('/api/workshops', wrap((req, res) => {
  const ws = applyFields({
    id: newId(), sendTime: '11:00', dayOf: true, dayOfTime: '10:00', groups: [], active: true,
    firstSendDate: nowParts().date,
  }, req.body);
  db().workshops.push(ws); save();
  log('info', `${displayName(ws)}: created${ws.groups.length ? `, ${ws.groups.length} groups, auto-send on` : ''}`, { kind: 'change', workshopId: ws.id });
  res.json(ws);
}));
const LABELS = { date: 'workshop date', startTime: 'start time', sendTime: 'daily message time', dayOf: 'workshop-day message', dayOfTime: 'workshop-day message time',
  active: 'sending', firstSendDate: 'start sending from', formLink: 'bonus form link', zoomLink: 'Zoom link', account: 'sending number', programmeId: 'programme', name: 'name', timeLabel: 'time wording' };
const shown = (k, v) => k === 'active' ? (v === false ? 'paused' : 'on') : k === 'dayOf' ? (v === false ? 'off' : 'on') : (v || '(blank)');
app.put('/api/workshops/:id', wrap((req, res) => {
  const ws = findWs(req.params.id);
  const before = structuredClone(ws);
  applyFields(ws, req.body);
  save();
  const changes = Object.keys(LABELS).filter((k) => k in req.body && JSON.stringify(before[k] ?? '') !== JSON.stringify(ws[k] ?? ''))
    .map((k) => ['formLink', 'zoomLink', 'account', 'programmeId', 'name', 'timeLabel'].includes(k) ? `${LABELS[k]} changed` : `${LABELS[k]} ${shown(k, before[k])} → ${shown(k, ws[k])}`);
  const g = (x) => (x.groups || []).map((y) => y.jid).sort().join();
  if (g(before) !== g(ws)) changes.push(`groups: ${ws.groups.length} picked (${ws.groups.map((y) => y.name).join(', ') || 'none'})`);
  if (changes.length) log('info', `${displayName(ws)}: ${changes.join('; ')}`, { kind: 'change', workshopId: ws.id });
  res.json(ws);
}));
app.delete('/api/workshops/:id', wrap((req, res) => {
  const ws = findWs(req.params.id);
  db().workshops = db().workshops.filter((w) => w.id !== req.params.id); save();
  log('info', `${displayName(ws)}: deleted`, { kind: 'change', workshopId: ws.id });
  res.json({ ok: true });
}));

// Reschedule: saved now, announced a few minutes later (so it can still be cancelled) or immediately with sendNow
app.post('/api/workshops/:id/reschedule', wrap((req, res) => {
  const ws = findWs(req.params.id);
  const { date, startTime, timeLabel, sendNow } = req.body;
  if (!isDate(date)) throw new Error('Pick the new date');
  if (date < nowParts().date) throw new Error('The new date is in the past');
  if (date === ws.date && (!startTime || startTime === ws.startTime)) throw new Error('That is the same date and time');
  const sendAt = new Date(Date.now() + (sendNow ? 0 : RESCHEDULE_DELAY_MIN() * 60_000)).toISOString();
  ws.pendingReschedule = { date, startTime: startTime || '', timeLabel: timeLabel || '', sendNow: !!sendNow, enteredDate: nowParts().date, enteredAt: new Date().toISOString(), sendAt };
  save();
  log('info', `${displayName(ws)}: reschedule to ${date} saved, ${sendNow ? 'announcing now' : `announcing in ${RESCHEDULE_DELAY_MIN()} min`}`, { kind: 'change', workshopId: ws.id });
  res.json(ws.pendingReschedule);
}));
app.delete('/api/workshops/:id/reschedule', wrap((req, res) => {
  const ws = findWs(req.params.id); delete ws.pendingReschedule; save();
  log('info', `${displayName(ws)}: pending reschedule cancelled`, { kind: 'change', workshopId: ws.id });
  res.json({ ok: true });
}));

// Full activity history (fetched when the Activity tab is open)
app.get('/api/activity', (req, res) => {
  const d = db();
  res.json({ log: d.log || [], sends: d.sends });
});

// Preview a message for any phase (nothing is sent, nothing is saved)
app.post('/api/workshops/:id/preview', wrap(async (req, res) => {
  const ws = findWs(req.params.id);
  const phase = req.body.phase || 'hype';
  let r;
  if (phase === 'reschedule') {
    const pr = ws.pendingReschedule || req.body;
    if (!isDate(pr.date)) throw new Error('Enter the new date first');
    const next = { ...ws, date: pr.date, startTime: pr.startTime || ws.startTime,
      timeLabel: pr.timeLabel || (pr.startTime ? '' : ws.timeLabel) };
    r = resolve(next, { date: ws.date, timeLabel: timeLabelOf(ws) });
  } else r = resolve(ws);
  if (!r) throw new Error("This programme's fact sheet isn't built yet");
  const out = await composeMessage(r, phase, db().history[ws.id] || []);
  res.json({ ...out, text: withLinks(out.text, r, phase) });
}));

// Send a preview to one chat (e.g. your own test group) to see it in WhatsApp
app.post('/api/workshops/:id/test', wrap(async (req, res) => {
  const ws = findWs(req.params.id);
  if (!req.body.jid || !req.body.text) throw new Error('Pick a group and write a preview first');
  await sendText(ws.account, req.body.jid, req.body.text);
  const group = ws.groups?.find((g) => g.jid === req.body.jid)?.name || req.body.jid;
  log('info', `${displayName(ws)}: preview sent by hand to ${group}`, { kind: 'sent', workshopId: ws.id, manualText: req.body.text });
  res.json({ ok: true });
}));

// Bad JSON bodies etc.: short JSON error, never a stack trace
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' }));

const PORT = Number(process.env.PORT || 4321);
app.listen(PORT, HOST, async () => {
  console.log(`Hype Dispatch running → http://localhost:${PORT}`);
  console.log(`Data folder: ${dataDir()}`);
  if (isPublic && !PASS) console.warn('Dashboard is reachable by others but DASHBOARD_PASSWORD is not set, so it is locked. Set it to unlock.');
  if (storageIsTemporary()) console.warn('No Railway volume attached: workshops and WhatsApp logins will be lost on every redeploy. Attach a volume to this service.');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is missing in .env, AI drafting will fail.');
  log('info', 'Hype Dispatch started', { kind: 'system' });
  for (const a of db().accounts) await startAccount(a.id).catch((e) => log('error', `Start ${a.name}: ${e.message}`, { kind: 'system' }));
  startScheduler();
});
