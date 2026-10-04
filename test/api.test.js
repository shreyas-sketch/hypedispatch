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
  assert.equal(await snap(), before, 'rejected requests changed nothing');
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.ok((await call('GET', '/api/nope')).json.error, 'unknown API routes answer in JSON');

  // valid edits still work, including on a workshop whose number was removed
  assert.equal((await call('PUT', '/api/workshops/ok', { active: false })).status, 200);
  await call('DELETE', '/api/accounts/a1');
  assert.equal((await call('PUT', '/api/workshops/ok', { active: true })).status, 200, 'still editable after its number was removed');
  console.log('API tests passed ✓');
} finally { srv.kill(); }
