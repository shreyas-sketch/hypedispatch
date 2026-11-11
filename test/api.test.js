// Run: node test/api.test.js
// Starts the real server (test mode) and checks bad input is rejected WITHOUT changing anything,
// and that one damaged workshop can't take the dashboard down.
import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hype-api-'));
// a database with one damaged workshop (as an older version could have saved it)
fs.mkdirSync(path.join(dir, 'data'));
fs.writeFileSync(path.join(dir, 'data', 'db.json'), JSON.stringify({
  programmes: [{ id: 'p1', name: 'Prog', factSheet: { title: 'T' } }], accounts: [{ id: 'a1', name: 'N1' }],
  workshops: [
    { id: 'bad', programmeId: 'p1', date: 'tomorrow', groups: 'abc', active: 'false' },
    { id: 'ok', programmeId: 'p1', date: '2026-12-01', startTime: '19:00', sendTime: '11:00', active: true, account: 'a1', groups: [{ jid: 'g@g.us', name: 'G' }] },
  ], sends: [], history: {}, seeded: ['Akshat Consulting', 'Siddharth Ecom', 'Siddharth Consulting', 'Siddharth Algo Trading', 'Aarzoo Personal Finance', 'Aarzoo Leadership', 'Aarzoo Communication', 'Deepak Crypto', 'BO Akshat', 'BO Chirag'],
}));
const port = 4600 + Math.floor(Math.random() * 300);
const srv = spawn(process.execPath, [path.join(root, 'src', 'index.js')], { cwd: dir, env: { ...process.env, PORT: String(port), HYPE_DRY_RUN: '1', HOST: '127.0.0.1', DASHBOARD_PASSWORD: '' }, stdio: 'ignore' });
const B = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { await fetch(B + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const call = async (method, url, body) => { const r = await fetch(B + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
try {
  // the dashboard still loads, and the damaged workshop was repaired on load
  const st = await call('GET', '/api/state');
  assert.equal(st.status, 200, 'state works despite a damaged workshop');
  const bad = st.json.workshops.find((w) => w.id === 'bad');
  assert.deepEqual(bad.groups, []); assert.equal(bad.active, false);

  const snap = async () => JSON.stringify((await call('GET', '/api/state')).json.workshops.find((w) => w.id === 'ok'));
  const before = await snap();
  const bads = [
    ['PUT', '/api/workshops/ok', { date: 'tomorrow' }], ['PUT', '/api/workshops/ok', { date: '2026-02-30' }], ['PUT', '/api/workshops/ok', { date: '' }],
    ['PUT', '/api/workshops/ok', { groups: 'abc' }], ['PUT', '/api/workshops/ok', { sendTime: 'banana' }], ['PUT', '/api/workshops/ok', { programmeId: 'nope' }],
    ['PUT', '/api/workshops/ok', { programmeId: '' }], ['PUT', '/api/workshops/ok', { zoomLink: 'zoom meeting' }], ['PUT', '/api/workshops/ok', { account: 'ghost' }],
    ['POST', '/api/workshops', []], ['POST', '/api/workshops/ok/reschedule', { date: '2026-12-05', startTime: 'xx' }],
    ['POST', '/api/workshops/ok/preview', { phase: 'bogus' }], ['PUT', '/api/programmes/p1', { factSheet: 'oops' }],
  ];
  for (const [m, u, b] of bads) {
    const r = await call(m, u, b);
    assert.equal(r.status, 400, `${m} ${u} ${JSON.stringify(b)} should be rejected`);
    assert.ok(r.json?.error, 'with a readable error');
  }
  for (const days of [0, 6, 1.5, 'two']) assert.equal((await call('PUT', '/api/workshops/ok', { days })).status, 400, `length ${days} rejected`);
  assert.equal(await snap(), before, 'rejected requests changed nothing');
  // length: saved, shown, and changeable by a reschedule without moving the date
  assert.equal((await call('PUT', '/api/workshops/ok', { days: 2 })).json.days, 2);
  assert.equal((await call('GET', '/api/state')).json.workshops.find((w) => w.id === 'ok').daysShown, 2);
  assert.equal((await call('POST', '/api/workshops/ok/reschedule', { days: 2 })).status, 400, 'nothing changed: refused');
  const rs = await call('POST', '/api/workshops/ok/reschedule', { days: 1 });
  assert.equal(rs.status, 200); assert.equal(rs.json.date, '2026-12-01'); assert.equal(rs.json.days, 1);
  await call('DELETE', '/api/workshops/ok/reschedule');
  // Day 2 on its own date
  for (const moreDates of [['2026-11-30'], ['2026-12-01'], ['nope'], []]) assert.equal((await call('PUT', '/api/workshops/ok', { days: 2, moreDates })).status, 400, `bad day 2 ${moreDates}`);
  const two = await call('PUT', '/api/workshops/ok', { days: 2, moreDates: ['2026-12-08'] });
  assert.equal(two.status, 200); assert.deepEqual(two.json.moreDates, ['2026-12-08']);
  const st2 = (await call('GET', '/api/state')).json.workshops.find((w) => w.id === 'ok');
  assert.deepEqual(st2.datesShown, ['2026-12-01', '2026-12-08']); assert.equal(st2.daysSource, 'set');
  const rs2 = await call('POST', '/api/workshops/ok/reschedule', { date: '2026-12-02' });
  assert.deepEqual(rs2.json.moreDates, ['2026-12-09'], 'day 2 moves with day 1');
  await call('DELETE', '/api/workshops/ok/reschedule');
  const rs3 = await call('POST', '/api/workshops/ok/reschedule', { moreDates: ['2026-12-10'] });
  assert.equal(rs3.status, 200, 'only day 2 moves'); assert.equal(rs3.json.date, '2026-12-01');
  await call('DELETE', '/api/workshops/ok/reschedule');
  assert.equal((await call('POST', '/api/workshops/ok/reschedule', { moreDates: ['2026-12-08'] })).status, 400, 'nothing changed');
  assert.equal((await call('PUT', '/api/workshops/ok', { days: 1 })).json.moreDates, undefined, 'back to 1 day: no day 2');
  assert.equal((await call('PUT', '/api/workshops/ok', { days: '' })).json.days, undefined, 'blank = follow the programme');
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.ok((await call('GET', '/api/nope')).json.error, 'unknown API routes answer in JSON');

  // valid edits still work, including on a workshop whose number was removed
  assert.equal((await call('PUT', '/api/workshops/ok', { active: false })).status, 200);
  await call('DELETE', '/api/accounts/a1');
  assert.equal((await call('PUT', '/api/workshops/ok', { active: true })).status, 200, 'still editable after its number was removed');
} finally { srv.kill(); }

// Login: the landing page is public, the dashboard and API need the password
{
  const port2 = port + 1;
  const srv2 = spawn(process.execPath, [path.join(root, 'src', 'index.js')], { cwd: dir, env: { ...process.env, PORT: String(port2), HYPE_DRY_RUN: '1', HOST: '127.0.0.1', DASHBOARD_PASSWORD: 'pa:ss' }, stdio: 'ignore' });
  const B2 = `http://127.0.0.1:${port2}`;
  for (let i = 0; i < 50; i++) { try { await fetch(B2 + '/healthz'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const get = (u, cookie) => fetch(B2 + u, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const login = (password) => fetch(B2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  try {
    for (const u of ['/', '/login', '/privacy', '/assets/site.css']) assert.equal((await get(u)).status, 200, `${u} is public`);
    assert.equal((await get('/app')).status, 302, 'dashboard redirects to login');
    assert.equal((await get('/app.html')).status, 302, 'dashboard file is not served directly');
    assert.equal((await get('/api/state')).status, 401);
    assert.equal((await login('wrong')).status, 401);
    const ok = await login('pa:ss');
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.ok(/HttpOnly/i.test(ok.headers.get('set-cookie')));
    assert.equal((await get('/app', cookie)).status, 200, 'logged in: dashboard opens');
    assert.equal((await get('/api/state', cookie)).status, 200);
    assert.equal((await get('/api/state', cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).status, 401, 'a tampered cookie is refused');
    assert.equal((await get('/api/state', 'hd_session=9999999999999.x')).status, 401, 'a forged cookie is refused');
    for (let i = 0; i < 8; i++) await login('guess' + i);
    assert.equal((await login('pa:ss')).status, 429, 'password guessing is slowed down');
  } finally { srv2.kill(); }
}
console.log('API tests passed ✓');
