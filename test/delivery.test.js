// Delivery robustness: waiting while WhatsApp is disconnected, and retrying failed groups.
// Run: node test/delivery.test.js  (fake Claude, dry-run WhatsApp)
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body);
    const text = '🔥 *Big Workshop* is almost here!\n\nYou are in. Now let us make it count.\n\nIt goes live *Sunday, 4 October, 7 PM IST* ⏰\n\n💡 Real, practical stuff you can use the very next day.\n\nBring your questions and your curiosity.\n\nThe people who show up live get the most out of it.\n\nBlock the time and be there ✨';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(0);

process.env.ANTHROPIC_API_KEY = 'test';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.HYPE_DRY_RUN = '1';
process.env.GROUP_GAP_MIN_MS = '1';
process.env.GROUP_GAP_MAX_MS = '2';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'hype-delivery-')));

const { db, save } = await import('../src/db.js');
const { tick, lineup } = await import('../src/scheduler.js');
const { dryRunSent, dryRunOffline, dryRunFailing } = await import('../src/wa.js');
const wait = () => new Promise((r) => setTimeout(r, 300));
const at = async (t) => { await tick(new Date(`2026-09-30T${t}:00+05:30`)); await wait(); };

const d = db();
const prog = d.programmes.find((p) => p.name === 'Akshat Consulting');
prog.factSheet = { title: 'Big Workshop' };
d.workshops.push({ id: 'w1', programmeId: prog.id, date: '2026-10-04', startTime: '19:00', sendTime: '11:00', active: true, account: 'a1',
  groups: [{ jid: 'g1@g.us', name: 'Group 1' }, { jid: 'g2@g.us', name: 'Group 2' }], firstSendDate: '2026-09-30' });
save();
const rec = () => d.sends.find((s) => s.key === 'w1|2026-09-30|hype');

// 1. WhatsApp disconnected at 11:00 (e.g. a redeploy): nothing sent, no attempts used up, shown on the dashboard
dryRunOffline.add('a1');
for (const t of ['11:00', '11:01', '11:02', '11:03', '11:04', '11:05']) await at(t);
assert.equal(dryRunSent.length, 0);
assert.equal(rec().rounds || 0, 0, 'waiting does not use up attempts');
assert.ok(!rec().done);
const l = lineup(new Date('2026-09-30T11:05:30+05:30'));
assert.equal(l[0].blocked, 'WhatsApp number not connected');
assert.ok(l[0].retry.includes('reconnects'), l[0].retry);
assert.equal(d.log.filter((x) => x.msg.includes("isn't connected")).length, 1, 'logged once, not every minute');

// 2. Reconnects at 11:20: goes out straight away. Group 2 fails this time.
dryRunOffline.delete('a1');
dryRunFailing.add('g2@g.us');
await at('11:20');
assert.deepEqual(dryRunSent.map((m) => m.jid), ['g1@g.us']);
assert.equal(rec().rounds, 1);
assert.ok(lineup(new Date('2026-09-30T11:21:00+05:30'))[0].retry.includes('retrying at 11:25'));

// 3. Retried every 5 minutes, only the failed group, until it works
await at('11:21'); assert.equal(dryRunSent.length, 1, 'not before 5 minutes');
dryRunFailing.delete('g2@g.us');
await at('11:25');
assert.deepEqual(dryRunSent.map((m) => m.jid), ['g1@g.us', 'g2@g.us'], 'only the failed group is retried');
assert.ok(rec().done);
await at('11:30'); assert.equal(dryRunSent.length, 2, 'no duplicates after success');

// 4. A group that keeps failing is given up on after about an hour, with a clear error
d.workshops[0].groups.push({ jid: 'g3@g.us', name: 'Group 3' });
d.sends = d.sends.filter((s) => s.key !== 'w1|2026-09-30|hype');
dryRunFailing.add('g3@g.us');
for (let m = 0; m <= 70; m += 5) await tick(new Date(Date.parse('2026-09-30T12:00:00+05:30') + m * 60000)).then(wait);
assert.ok(rec().done);
assert.equal(rec().rounds, 12);
assert.ok(d.log.some((x) => x.level === 'error' && x.msg.includes('gave up on Group 3')));

// 5. Removing a failing group from the workshop stops its retries
dryRunFailing.clear(); dryRunSent.length = 0;
d.workshops.push({ id: 'w5', programmeId: prog.id, date: '2026-10-09', startTime: '19:00', sendTime: '11:00', active: true, account: 'a1',
  groups: [{ jid: 'ok@g.us', name: 'OK' }, { jid: 'bad@g.us', name: 'BAD' }], firstSendDate: '2026-09-01' });
dryRunFailing.add('bad@g.us');
await tick(new Date('2026-10-01T11:00:00+05:30')); await wait();
d.workshops.find((w) => w.id === 'w5').groups = [{ jid: 'ok@g.us', name: 'OK' }];
await tick(new Date('2026-10-01T11:05:00+05:30')); await wait();
assert.ok(d.sends.find((s) => s.key === 'w5|2026-10-01|hype').done, 'removed group no longer retried');

// 6. A workshop-day message held up by a disconnect is never sent after the workshop has started
d.workshops.push({ id: 'w6', programmeId: prog.id, date: '2026-10-02', startTime: '19:00', sendTime: '11:00', dayOf: true, dayOfTime: '10:00', active: true, account: 'a6',
  groups: [{ jid: 'w6@g.us', name: 'W6' }], firstSendDate: '2026-09-01' });
dryRunOffline.add('a6');
await tick(new Date('2026-10-02T10:00:00+05:30')); await wait();
dryRunOffline.delete('a6');
await tick(new Date('2026-10-02T20:30:00+05:30')); await wait();
assert.ok(!dryRunSent.some((m) => m.jid === 'w6@g.us'), 'no late "we are live today" message');
assert.ok(d.log.some((l) => l.workshopId === 'w6' && l.msg.includes('already started')));

// 7. Rescheduled to TOMORROW: the date-change goes out, and the day-before reminder (with Zoom link) still goes out today
d.workshops.push({ id: 'w7', programmeId: prog.id, date: '2026-10-08', startTime: '19:00', sendTime: '11:00', active: true, account: 'a1', zoomLink: 'https://zoom.us/j/7',
  groups: [{ jid: 'w7@g.us', name: 'W7' }], firstSendDate: '2026-09-01',
  pendingReschedule: { date: '2026-10-04', sendNow: true, enteredDate: '2026-10-03' } });
await tick(new Date('2026-10-03T15:00:00+05:30')); await wait();
await tick(new Date('2026-10-03T15:01:00+05:30')); await wait();
const w7 = dryRunSent.filter((m) => m.jid === 'w7@g.us');
assert.equal(w7.length, 2, 'announcement + day-before reminder');
assert.ok(!w7[0].text.includes('zoom.us') && w7[1].text.includes('https://zoom.us/j/7'), 'announcement first, then the reminder with the Zoom link');

console.log('Delivery tests passed ✓');
fake.close();
process.exit(0);
