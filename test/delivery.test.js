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
const { dryRunSent, dryRunOffline, dryRunFailing, dryRunErrors, reportRejected } = await import('../src/wa.js');
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

// 8. WhatsApp refuses a message AFTER it was sent (late error ack)
dryRunSent.length = 0;
d.workshops.push({ id: 'w8', programmeId: prog.id, date: '2026-10-20', startTime: '19:00', sendTime: '11:00', active: true, account: 'a1',
  groups: [{ jid: 'p8@g.us', name: 'Perm8' }, { jid: 't8@g.us', name: 'Temp8' }], firstSendDate: '2026-09-01' });
await tick(new Date('2026-10-12T11:00:00+05:30')); await wait();
const r8 = () => d.sends.find((s) => s.key === 'w8|2026-10-12|hype');
assert.ok(r8().done && r8().results['p8@g.us'].msgId, 'sent and message id recorded');
reportRejected('a1', r8().results['p8@g.us'].msgId, 'p8@g.us', '403');   // not allowed to post: permanent
reportRejected('a1', r8().results['t8@g.us'].msgId, 't8@g.us', '479');   // temporary
assert.equal(r8().results['p8@g.us'].ok, false);
assert.ok(r8().results['p8@g.us'].error.includes("isn't allowed to post"));
assert.ok(d.log.some((l) => l.msg.includes('did NOT reach Perm8')), 'refusal shows in the activity log');
assert.ok(r8().results['t8@g.us'].ok, 'a non-refusal error notice does NOT mark it failed (it usually still arrived)');
// THE duplicate bug: error notices must never cause a resend. Simulate a whole day of them.
const sentBefore = dryRunSent.length;
for (let h = 11; h <= 22; h++) {
  reportRejected('a1', r8().results['t8@g.us'].msgId, 't8@g.us', '479');
  await tick(new Date(`2026-10-12T${String(h).padStart(2, '0')}:05:00+05:30`)); await wait();
}
assert.equal(dryRunSent.length, sentBefore, 'nothing is ever resent after WhatsApp accepted it');
assert.equal(d.log.filter((l) => l.msg.includes('delivery problem (error 479)')).length, 1, 'the warning is logged once');

// 9. A refusal at send time (e.g. "forbidden") is not retried for an hour
d.workshops.push({ id: 'w9', programmeId: prog.id, date: '2026-10-20', startTime: '19:00', sendTime: '11:00', active: true, account: 'a1',
  groups: [{ jid: 'f9@g.us', name: 'Forbidden9' }], firstSendDate: '2026-09-01' });
dryRunErrors.set('f9@g.us', 'forbidden');
await tick(new Date('2026-10-13T11:00:00+05:30')); await wait();
const r9 = d.sends.find((s) => s.key === 'w9|2026-10-13|hype');
assert.ok(r9.done && r9.rounds === 1, 'given up straight away');
assert.ok(d.log.some((l) => l.msg.includes('NOT sent to Forbidden9') && l.msg.includes('not an admin')));

// 10. Two workshops pointing at the same group on the same day: the group gets ONE message of each type
dryRunErrors.clear(); dryRunSent.length = 0;
for (const id of ['w10a', 'w10b']) d.workshops.push({ id, programmeId: prog.id, date: '2026-10-25', startTime: '19:00', sendTime: '11:00', active: true, account: 'a1',
  groups: [{ jid: 'same@g.us', name: 'Same group' }], firstSendDate: '2026-09-01' });
await tick(new Date('2026-10-14T11:00:00+05:30')); await wait(); await wait();
assert.equal(dryRunSent.filter((m) => m.jid === 'same@g.us').length, 1, 'one hype per group per day, even with two workshops');
assert.ok(d.log.some((l) => l.msg.includes('skipped Same group')));

// 11. A send that timed out might have gone out: it's flagged, never resent
d.workshops.push({ id: 'w11', programmeId: prog.id, date: '2026-10-25', startTime: '19:00', sendTime: '11:00', active: true, account: 'a1',
  groups: [{ jid: 'slow@g.us', name: 'Slow' }], firstSendDate: '2026-09-01' });
dryRunErrors.set('slow@g.us', 'Sending timed out after 60s');
await tick(new Date('2026-10-15T11:00:00+05:30')); await wait();
dryRunErrors.clear();
for (const t of ['11:10', '12:00', '15:00']) { await tick(new Date(`2026-10-15T${t}:00+05:30`)); await wait(); }
const r11 = d.sends.find((s) => s.key === 'w11|2026-10-15|hype');
assert.ok(r11.done && r11.results['slow@g.us'].uncertain, 'timed-out send is flagged and finished');
assert.equal(dryRunSent.filter((m) => m.jid === 'slow@g.us').length, 0, 'never resent after a timeout');

// 12. Only one copy of the app can send from the same data
{
  const { holdSchedulerLock } = await import('../src/scheduler.js');
  assert.ok(holdSchedulerLock(), 'first copy gets the lock');
  const fsMod = await import('fs'); const pathMod = await import('path');
  const lf = pathMod.join(process.cwd(), 'data', 'scheduler.lock');
  fsMod.writeFileSync(lf, JSON.stringify({ id: 'other-copy', beat: Date.now() }));
  assert.ok(!holdSchedulerLock(), 'a second copy is blocked while the first is alive');
  fsMod.writeFileSync(lf, JSON.stringify({ id: 'other-copy', beat: Date.now() - 120_000 }));
  assert.ok(holdSchedulerLock(), 'takes over once the other copy has stopped');
}

// 13. Another device on the same number sending our messages is flagged
{
  const { reportForeign } = await import('../src/wa.js');
  reportForeign('a1', 'x@g.us'); reportForeign('a1', 'y@g.us');
  assert.equal(d.log.filter((l) => l.msg.includes('probably also running somewhere else')).length, 1, 'flagged once a day');
}

console.log('Delivery tests passed ✓');
fake.close();
process.exit(0);
