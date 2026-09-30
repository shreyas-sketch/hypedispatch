import 'dotenv/config';
import express from 'express';
import path from 'path';
import { db, save, newId, log } from './db.js';
import { startAccount, accountStatus, listGroups, logoutAccount, sendText } from './wa.js';
import { fetchPageText, extractFacts, composeMessage, withLinks } from './ai.js';
import { startScheduler, RESCHEDULE_CHECK } from './scheduler.js';
import { nowParts, phaseFor, prettyTime } from './time.js';
import { resolve, timeLabelOf, displayName } from './workshop.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Optional password for the dashboard
const PASS = process.env.DASHBOARD_PASSWORD;
if (PASS) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const [, pw] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (pw === PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="Hype Dispatch"').status(401).send('Password required');
  });
}
app.use(express.static(path.resolve('public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const findWs = (id) => { const w = db().workshops.find((x) => x.id === id); if (!w) throw new Error('Workshop not found'); return w; };
const findProg = (id) => { const p = db().programmes.find((x) => x.id === id); if (!p) throw new Error('Programme not found'); return p; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// ----- state -----
app.get('/api/state', (req, res) => {
  const d = db();
  const { date, hm } = nowParts();
  res.json({
    now: { date, hm },
    aiReady: !!process.env.ANTHROPIC_API_KEY,
    rescheduleCheck: RESCHEDULE_CHECK(),
    programmes: d.programmes.map((p) => ({ ...p, pageText: undefined })),
    accounts: d.accounts.map((a) => ({ ...a, ...accountStatus(a.id) })),
    workshops: d.workshops.map((w) => ({ ...w, displayName: displayName(w), timeLabelShown: timeLabelOf(w), today: phaseFor(w, date) })),
    sends: d.sends.slice(0, 60),
    log: (d.log || []).slice(0, 80),
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
app.post('/api/accounts/:id/connect', wrap(async (req, res) => { await startAccount(req.params.id); res.json({ ok: true }); }));
app.delete('/api/accounts/:id', wrap(async (req, res) => {
  await logoutAccount(req.params.id);
  db().accounts = db().accounts.filter((a) => a.id !== req.params.id); save();
  res.json({ ok: true });
}));
app.get('/api/accounts/:id/groups', wrap(async (req, res) => res.json(await listGroups(req.params.id))));

// ----- programmes (one per landing page) -----
app.post('/api/programmes', wrap((req, res) => {
  const p = { id: newId(), name: req.body.name || 'New programme', landingUrl: req.body.landingUrl || '', focus: req.body.focus || '', factSheet: null };
  db().programmes.push(p); save(); res.json(p);
}));
app.put('/api/programmes/:id', wrap((req, res) => {
  const p = findProg(req.params.id);
  for (const k of ['name', 'landingUrl', 'focus', 'factSheet']) if (k in req.body) p[k] = req.body[k];
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
  log('info', `${p.name}: fact sheet built from landing page`);
  res.json(p.factSheet);
}));

// ----- workshops (a dated run of a programme, sent to its communities) -----
const FIELDS = ['name', 'programmeId', 'date', 'startTime', 'timeLabel', 'sendTime', 'dayOf', 'dayOfTime',
  'account', 'groups', 'zoomLink', 'formLink', 'active', 'firstSendDate'];
function applyFields(ws, body) {
  for (const k of FIELDS) if (k in body) ws[k] = body[k];
  if (!isDate(ws.date)) throw new Error('Workshop date is required');
  if (!ws.programmeId) throw new Error('Pick which programme (landing page) this is');
  return ws;
}
app.post('/api/workshops', wrap((req, res) => {
  const ws = applyFields({
    id: newId(), sendTime: '11:00', dayOf: true, dayOfTime: '10:00', groups: [], active: true,
    firstSendDate: nowParts().date,
  }, req.body);
  db().workshops.push(ws); save();
  log('info', `${displayName(ws)}: created${ws.groups.length ? `, ${ws.groups.length} groups, auto-send on` : ''}`);
  res.json(ws);
}));
app.put('/api/workshops/:id', wrap((req, res) => { const ws = applyFields(findWs(req.params.id), req.body); save(); res.json(ws); }));
app.delete('/api/workshops/:id', wrap((req, res) => {
  db().workshops = db().workshops.filter((w) => w.id !== req.params.id); save(); res.json({ ok: true });
}));

// Reschedule: saved now, announced at the daily check (7 PM) or immediately with sendNow
app.post('/api/workshops/:id/reschedule', wrap((req, res) => {
  const ws = findWs(req.params.id);
  const { date, startTime, timeLabel, sendNow } = req.body;
  if (!isDate(date)) throw new Error('Pick the new date');
  if (date === ws.date && (!startTime || startTime === ws.startTime)) throw new Error('That is the same date and time');
  ws.pendingReschedule = { date, startTime: startTime || '', timeLabel: timeLabel || '', sendNow: !!sendNow, enteredDate: nowParts().date, enteredAt: new Date().toISOString() };
  save();
  log('info', `${displayName(ws)}: reschedule to ${date} saved, ${sendNow ? 'announcing now' : `announcing at ${RESCHEDULE_CHECK()}`}`);
  res.json(ws.pendingReschedule);
}));
app.delete('/api/workshops/:id/reschedule', wrap((req, res) => {
  const ws = findWs(req.params.id); delete ws.pendingReschedule; save();
  log('info', `${displayName(ws)}: pending reschedule cancelled`);
  res.json({ ok: true });
}));

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
  res.json({ ...out, text: withLinks(out.text, ws, phase) });
}));

// Send a preview to one chat (e.g. your own test group) to see it in WhatsApp
app.post('/api/workshops/:id/test', wrap(async (req, res) => {
  const ws = findWs(req.params.id);
  await sendText(ws.account, req.body.jid, req.body.text);
  res.json({ ok: true });
}));

const PORT = Number(process.env.PORT || 4321);
app.listen(PORT, async () => {
  console.log(`Hype Dispatch running → http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is missing in .env, AI drafting will fail.');
  for (const a of db().accounts) await startAccount(a.id).catch((e) => log('error', `Start ${a.name}: ${e.message}`));
  startScheduler();
});
