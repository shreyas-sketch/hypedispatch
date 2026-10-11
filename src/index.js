import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { db, save, newId, log } from './db.js';
import { startAccount, accountStatus, listGroups, logoutAccount, sendText, resyncAccount } from './wa.js';
import { fetchPageText, extractFacts, composeMessage, withLinks } from './ai.js';
import { startScheduler, RESCHEDULE_DELAY_MIN, lineup } from './scheduler.js';
import { nowParts, phaseFor, prettyTime } from './time.js';
import { resolve, timeLabelOf, displayName, syncWorkshopGroups } from './workshop.js';
import { onRailway, storageIsTemporary, dataDir } from './paths.js';

const app = express();
app.set('trust proxy', 1); // Railway: real client IP and https come from its proxy
app.use(express.json({ limit: '2mb' }));

// ----- login session: a signed cookie, valid for SESSION_DAYS. Changing the password logs everyone out. -----
const SESSION_DAYS = 30;
const sign = (exp) => crypto.createHmac('sha256', `hype-dispatch|${process.env.DASHBOARD_PASSWORD}`).update(String(exp)).digest('base64url');
const makeToken = () => { const exp = Date.now() + SESSION_DAYS * 86400_000; return `${exp}.${sign(exp)}`; };
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
function loggedIn(req) {
  const m = /(?:^|;\s*)hd_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  return Number(exp) > Date.now() && !!sig && safeEqual(sig, sign(exp));
}
const sessionCookie = (req, value, maxAge) => `hd_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

// Health check for Railway (before the password, and reveals nothing)
app.get('/healthz', (req, res) => res.send('ok'));

// Only this PC by default. On Railway (or with HOST=0.0.0.0) it's reachable by others, so a password is required.
const HOST = process.env.HOST || (onRailway() ? '0.0.0.0' : '127.0.0.1');
const isPublic = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const PASS = process.env.DASHBOARD_PASSWORD;
const LOCKED = isPublic && !PASS; // never expose the controls for your WhatsApp numbers without a password
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const page = (file) => (req, res) => res.sendFile(path.join(PUB, file));

// Public pages: the landing page, login and privacy, plus their images
app.use('/assets', express.static(path.join(PUB, 'assets'), { maxAge: '1h' }));
app.get('/', page('landing.html'));
app.get('/privacy', page('privacy.html'));
app.get('/login', (req, res) => (!LOCKED && (!PASS || loggedIn(req)) ? res.redirect('/app') : page('login.html')(req, res)));
app.get('/api/auth', (req, res) => res.json({ locked: LOCKED, needsPassword: !!PASS, loggedIn: !LOCKED && (!PASS || loggedIn(req)) }));

const tries = new Map(); // ip -> { n, until }: slows down password guessing
app.post('/api/login', (req, res) => {
  if (LOCKED) return res.status(503).json({ error: 'Login is switched off until DASHBOARD_PASSWORD is set on the server.' });
  if (!PASS) return res.json({ ok: true });
  const ip = req.ip || 'x';
  const t = tries.get(ip);
  if (t && t.n >= 8 && Date.now() < t.until) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  if (!safeEqual(String(req.body?.password || ''), PASS)) {
    const n = t && Date.now() < t.until ? t.n + 1 : 1;
    tries.set(ip, { n, until: Date.now() + 15 * 60_000 });
    return res.status(401).json({ error: 'That password is not right.' });
  }
  tries.delete(ip);
  res.setHeader('Set-Cookie', sessionCookie(req, makeToken(), SESSION_DAYS * 86400));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', sessionCookie(req, '', 0)); res.json({ ok: true }); });

// Everything below needs a login
app.use((req, res, next) => {
  if (LOCKED) {
    if (req.path.startsWith('/api')) return res.status(503).json({ error: 'Set DASHBOARD_PASSWORD on the server first' });
    return res.redirect('/login');
  }
  if (!PASS || loggedIn(req)) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Please log in again', login: true });
  res.redirect('/login');
});
app.get(['/app', '/app/'], page('app.html'));

// Promise.resolve().then() so synchronous throws also come back as { error } instead of an HTML stack trace
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const findWs = (id) => { const w = db().workshops.find((x) => x.id === id); if (!w) throw new Error('Workshop not found'); return w; };
// Only ids we created are allowed near the file system (auth folders are deleted by id)
const findAcc = (id) => { const a = db().accounts.find((x) => x.id === id); if (!a) throw new Error('WhatsApp number not found'); return a; };
const findProg = (id) => { const p = db().programmes.find((x) => x.id === id); if (!p) throw new Error('Programme not found'); return p; };
// A real calendar date (rejects "tomorrow", "2026-02-30", "")
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

const safe = (fn, fallback) => { try { return fn(); } catch (e) { console.error('state:', e.message); return fallback; } };

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
    lineup: safe(() => lineup(), []),
    programmes: d.programmes.map((p) => ({ ...p, pageText: undefined })),
    accounts: d.accounts.map((a) => ({ ...a, ...accountStatus(a.id) })),
    workshops: d.workshops.map((w) => ({ ...w, displayName: safe(() => displayName(w), 'Workshop'), timeLabelShown: safe(() => timeLabelOf(w), ''), today: safe(() => phaseFor(w, date), {}) })),
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
  const { renamed, missing, wrongKind } = syncWorkshopGroups(acc.id, groups);
  save();
  const message = `${acc.name} resynced: ${groups.length} groups${renamed ? `, ${renamed} renamed` : ''}`
    + (missing.length ? `. No longer in: ${missing.map((m) => `${m.group} (${m.workshop})`).join(', ')}` : '')
    + (wrongKind.length ? `. These workshops have a community itself picked, which can't receive messages; pick its announcements group instead: ${wrongKind.map((m) => `${m.group} (${m.workshop})`).join(', ')}` : '');
  log(missing.length || wrongKind.length ? 'warn' : 'info', message, { kind: 'system' });
  res.json({ status, groups: groups.length, renamed, missing, wrongKind, message });
}));
app.get('/api/accounts/:id/groups', wrap(async (req, res) => res.json(await listGroups(findAcc(req.params.id).id))));

// ----- programmes (one per landing page) -----
app.post('/api/programmes', wrap((req, res) => {
  const p = { id: newId(), name: req.body.name || 'New programme', landingUrl: req.body.landingUrl || '', focus: req.body.focus || '', title: req.body.title || '', host: req.body.host || '', signature: req.body.signature || '', factSheet: null };
  db().programmes.push(p); save(); res.json(p);
}));
app.put('/api/programmes/:id', wrap((req, res) => {
  const p = findProg(req.params.id);
  if ('factSheet' in req.body && req.body.factSheet !== null && (typeof req.body.factSheet !== 'object' || Array.isArray(req.body.factSheet))) throw new Error('The fact sheet must be JSON like { "title": "…" }');
  for (const k of ['name', 'title', 'host', 'landingUrl', 'focus', 'signature']) if (k in req.body && typeof req.body[k] !== 'string') throw new Error(`${k} must be text`);
  for (const k of ['name', 'title', 'host', 'landingUrl', 'focus', 'signature', 'factSheet']) if (k in req.body) p[k] = req.body[k];
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
  delete p.pageText;
  p.pageChars = pageText.length;
  p.factSheet = await extractFacts(pageText, p.focus);
  p.factsAt = new Date().toISOString();
  save();
  log('info', `${p.name}: fact sheet built from landing page`, { kind: 'change' });
  res.json(p.factSheet);
}));

// ----- workshops (a dated run of a programme, sent to its communities) -----
const FIELDS = ['name', 'programmeId', 'date', 'startTime', 'timeLabel', 'sendTime', 'dayOf', 'dayOfTime',
  'account', 'groups', 'zoomLink', 'formLink', 'active', 'firstSendDate'];
// Check everything on a copy first, so a bad request can never leave a half-changed workshop behind
function applyFields(ws, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Bad request');
  const next = { ...ws };
  for (const k of FIELDS) if (k in body) next[k] = body[k];
  const str = (k) => { if (next[k] == null) next[k] = ''; if (typeof next[k] !== 'string') throw new Error(`${k} must be text`); next[k] = next[k].trim(); };
  ['name', 'programmeId', 'date', 'startTime', 'timeLabel', 'sendTime', 'dayOfTime', 'account', 'zoomLink', 'formLink', 'firstSendDate'].forEach(str);
  if (!isDate(next.date)) throw new Error('Pick the workshop date');
  if (!next.programmeId) throw new Error('Pick which programme (landing page) this is');
  if (next.programmeId !== ws.programmeId && !db().programmes.some((p) => p.id === next.programmeId)) throw new Error('That programme no longer exists');
  // only check the number when it's being changed, so a workshop whose number was removed can still be paused/edited
  if (next.account && next.account !== ws.account && !db().accounts.some((a) => a.id === next.account)) throw new Error('That WhatsApp number no longer exists');
  for (const k of ['startTime', 'sendTime', 'dayOfTime']) if (next[k] && !isTime(next[k])) throw new Error(`${k === 'startTime' ? 'Start time' : 'Message time'} must look like 19:00`);
  if (next.firstSendDate && !isDate(next.firstSendDate)) throw new Error('"Start sending from" must be a date');
  for (const k of ['zoomLink', 'formLink']) if (next[k] && !/^https?:\/\/\S+$/i.test(next[k])) throw new Error(`The ${k === 'zoomLink' ? 'Zoom' : 'bonus form'} link must start with https://`);
  for (const k of ['active', 'dayOf']) if (k in body) next[k] = body[k] !== false && body[k] !== 'false';
  if (!Array.isArray(next.groups)) throw new Error('groups must be a list');
  next.groups = next.groups.filter((g) => g && typeof g.jid === 'string' && g.jid).map((g) => ({ jid: g.jid, name: String(g.name || g.jid) }));
  Object.assign(ws, next);
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
  if (startTime && !isTime(startTime)) throw new Error('The new start time must look like 19:00');
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
  if (!['hype', 'tomorrow', 'dayof', 'reschedule'].includes(phase)) throw new Error('Unknown message type');
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
  const group = (Array.isArray(ws.groups) ? ws.groups : []).find((g) => g.jid === req.body.jid)?.name || req.body.jid;
  log('info', `${displayName(ws)}: preview sent by hand to ${group}`, { kind: 'sent', workshopId: ws.id, manualText: req.body.text });
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Bad JSON bodies etc.: short JSON error, never a stack trace
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' }));

const PORT = Number(process.env.PORT || 4321);
app.listen(PORT, HOST, async () => {
  console.log(`Hype Dispatch running → http://localhost:${PORT}`);
  console.log(`Data folder: ${dataDir()}`);
  if (LOCKED) console.warn('Dashboard is reachable by others but DASHBOARD_PASSWORD is not set, so it is locked. Set it to unlock.');
  if (storageIsTemporary()) console.warn('No Railway volume attached: workshops and WhatsApp logins will be lost on every redeploy. Attach a volume to this service.');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY is missing in .env, AI drafting will fail.');
  log('info', 'Hype Dispatch started', { kind: 'system' });
  for (const a of db().accounts) await startAccount(a.id).catch((e) => log('error', `Start ${a.name}: ${e.message}`, { kind: 'system' }));
  startScheduler();
});
