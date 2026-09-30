// Run: node test/safety.test.js  (no WhatsApp or API key needed)
// Checks the fixes for: account-id path escape, log flooding, and deleted seed programmes coming back.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.HYPE_DRY_RUN = '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hype-safety-'));
process.chdir(dir);

const { logoutAccount } = await import('../src/wa.js');
const { db, save } = await import('../src/db.js');
const { tick } = await import('../src/scheduler.js');

// 1. An account id can never reach outside data/auth
const canary = path.join(dir, 'canary');
fs.mkdirSync(canary);
await assert.rejects(() => logoutAccount('../../canary'), /Bad account id/);
await assert.rejects(() => logoutAccount('..'), /Bad account id/);
assert.ok(fs.existsSync(canary), 'folder outside data/auth survives');

// 2. A workshop that can't send logs the problem once, not every minute
const d = db();
const prog = d.programmes[0];
d.workshops.push({ id: 'w1', programmeId: prog.id, date: '2026-10-10', sendTime: '11:00', active: true, groups: [{ jid: 'g@g.us', name: 'G' }], firstSendDate: '2026-09-30' });
d.workshops.push({ id: 'w2', programmeId: prog.id, date: '2026-10-10', sendTime: '11:00', active: true, groups: [], firstSendDate: '2026-09-30' });
for (let m = 0; m < 5; m++) { await tick(new Date(`2026-09-30T11:0${m}:00+05:30`)); await new Promise((r) => setTimeout(r, 30)); }
assert.equal(d.log.filter((l) => l.msg.includes('no fact sheet')).length, 1, 'missing fact sheet logged once');
assert.equal(d.log.filter((l) => l.msg.includes('no groups')).length, 1, 'no groups logged once');

// 3. Deleted seed programmes stay deleted after a restart
d.programmes = d.programmes.filter((p) => p.name !== 'Deepak Crypto');
d.programmes.find((p) => p.name === 'BO Akshat').name = 'BO Akshat (renamed)';
save();
const reloaded = await import('../src/db.js?restart');
const names = reloaded.db().programmes.map((p) => p.name);
assert.ok(!names.includes('Deepak Crypto'), 'deleted seed not re-added');
assert.ok(!names.includes('BO Akshat'), 'renamed seed not duplicated');
assert.equal(names.length, 9);

console.log('Safety tests passed ✓');
process.exit(0);
