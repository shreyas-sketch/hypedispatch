// End-to-end run of the scheduler through a full week with a reschedule.
// Uses a fake Claude API and dry-run WhatsApp, so nothing is really sent.
// Run: node test/scheduler.test.js
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Fake Claude: writes a valid message from whatever fact sheet it's given
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body);
    const user = j.messages[0].content;
    const fs_ = JSON.parse(user.match(/FACT SHEET:\n([\s\S]*?)\n\n(?:The workshop|TASK)/)[1]);
    const text = user.includes('RESCHEDULED')
      ? `📅 Quick change, friends! *${fs_.title}* is moving to *${fs_.date_text}, ${fs_.time_text}* (it was ${fs_.old_date_text}). Sorry for the shuffle.\n\n🙏 Please update your calendar, because everything we planned is still coming your way and it's going to be worth every minute you spend with us.\n\nSame energy, same content, same excitement, just a new slot on the calendar. We really can't wait to see you all there ✨`
      : `🔥 Getting so excited for *${fs_.title}* on *${fs_.date_text} at ${fs_.time_text}*! We're going deep on real, practical stuff you can actually use the very next day.\n\n💡 Bring your questions, bring your curiosity, and bring that one problem you have been stuck on for a while now.\n\nLet's make it a great session together, one where you walk away with clarity and a plan you can start on straight away ✨`;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(0);

process.env.ANTHROPIC_API_KEY = 'test';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.HYPE_DRY_RUN = '1';
process.env.GROUP_GAP_MIN_MS = '1';
process.env.GROUP_GAP_MAX_MS = '2';
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'hype-')));

const { db, save } = await import('../src/db.js');
const { tick, lineup } = await import('../src/scheduler.js');
const { dryRunSent } = await import('../src/wa.js');
const wait = () => new Promise((r) => setTimeout(r, 300));
const at = async (isoIST) => { await tick(new Date(isoIST + '+05:30')); await wait(); };

const d = db();
assert.equal(d.programmes.length, 10, 'seeded 10 programmes');
const prog = d.programmes.find((p) => p.name === 'Akshat Consulting');
prog.factSheet = { title: 'High Value Consulting Workshop', host: 'Akshat', what_youll_learn: ['Package your expertise'] };
d.workshops.push({
  id: 'w1', programmeId: prog.id, date: '2026-10-04', startTime: '19:00', sendTime: '11:00', dayOf: true, dayOfTime: '10:00',
  active: true, account: 'a1', groups: [{ jid: 'g1@g.us', name: '4th Oct Consulting' }, { jid: 'g2@g.us', name: '4th Oct Consulting 2' }],
  zoomLink: 'https://zoom.us/j/1', formLink: 'https://forms.gle/x', firstSendDate: '2026-09-30',
});
save();

await at('2026-09-30T10:00:00'); assert.equal(dryRunSent.length, 0, 'nothing before send time');
await at('2026-09-30T11:01:00'); assert.equal(dryRunSent.length, 2, 'hype to both groups');
assert.ok(dryRunSent[0].text.includes('https://forms.gle/x') && !dryRunSent[0].text.includes('zoom.us') && dryRunSent[0].text.includes('Sunday, 4 October'), 'hype has form link, no Zoom');
await at('2026-09-30T11:30:00'); assert.equal(dryRunSent.length, 2, 'no duplicate same day');

// Lined-up messages before anything changes: today's hype is sent, so next is Oct 1 hype
{
  const l = lineup(new Date('2026-09-30T12:00:00+05:30'));
  assert.deepEqual(l.slice(0, 3).map((m) => `${m.date} ${m.time} ${m.phase}`), ['2026-10-01 11:00 hype', '2026-10-02 11:00 hype', '2026-10-03 11:00 tomorrow']);
  assert.deepEqual(l[2].links, ['form', 'Zoom link']);
  assert.equal(l.find((m) => m.phase === 'dayof').time, '10:00');
}

// Oct 1, 10:58: word comes in that it's moving to Oct 6, 8 PM. Announced 5 minutes later (11:03).
d.workshops[0].pendingReschedule = { date: '2026-10-06', startTime: '20:00', timeLabel: '', sendNow: false, enteredDate: '2026-10-01',
  enteredAt: new Date('2026-10-01T10:58:00+05:30').toISOString(), sendAt: new Date('2026-10-01T11:03:00+05:30').toISOString() };
save();
{
  const l = lineup(new Date('2026-10-01T10:59:00+05:30'));
  assert.equal(`${l[0].phase} ${l[0].date} ${l[0].time}`, 'reschedule 2026-10-01 11:03', 'announcement is first in line');
  assert.ok(!l.some((m) => m.date === '2026-10-01' && m.phase !== 'reschedule'), 'no regular message on the announcement day');
  assert.equal(l.find((m) => m.phase === 'tomorrow').date, '2026-10-05', 'daily messages already follow the new date');
}
await at('2026-10-01T11:01:00'); assert.equal(dryRunSent.length, 2, 'regular hype held while reschedule pending');
await at('2026-10-01T11:02:00'); assert.equal(dryRunSent.length, 2, 'not before the 5 minutes are up');
await at('2026-10-01T11:03:00'); assert.equal(dryRunSent.length, 4, 'reschedule announced 5 minutes after saving');
const ann = dryRunSent[2].text;
assert.ok(ann.includes('https://forms.gle/x') && !ann.includes('zoom.us'), 'reschedule has form link, no Zoom');
assert.ok(ann.endsWith('*Team Akshat Dani*'), 'signature last');
assert.ok(ann.includes('*High Value Consulting Workshop* is moving to *Tuesday, 6 October, 8 PM IST*'), 'bold kept intact');
assert.ok(d.sends.every((s) => s.source === 'ai'), 'fake Claude drafts pass the checks');
assert.ok(ann.includes('Tuesday, 6 October') && ann.includes('8 PM IST') && ann.includes('Sunday, 4 October'), ann);
assert.equal(d.workshops[0].date, '2026-10-06');
assert.ok(!d.workshops[0].pendingReschedule);
await at('2026-10-01T19:30:00'); assert.equal(dryRunSent.length, 4, 'no extra hype on reschedule day');

await at('2026-10-02T11:00:00'); assert.equal(dryRunSent.length, 6, 'hype resumes toward new date');
assert.ok(dryRunSent[4].text.includes('Tuesday, 6 October') && !dryRunSent[4].text.includes('Sunday'));
await at('2026-10-04T11:00:00'); assert.equal(dryRunSent.length, 8, 'old date is just another hype day now');
await at('2026-10-05T11:00:00'); assert.equal(dryRunSent.length, 10, 'day before');
assert.ok(dryRunSent[8].text.includes('https://forms.gle/x') && dryRunSent[8].text.includes('https://zoom.us/j/1'));
await at('2026-10-06T10:00:00'); assert.equal(dryRunSent.length, 12, 'day of');
assert.ok(dryRunSent[10].text.includes('https://zoom.us/j/1') && !dryRunSent[10].text.includes('forms.gle'));
await at('2026-10-07T11:00:00'); assert.equal(dryRunSent.length, 12, 'stops after the workshop');

// "Announce now" skips the 5-minute wait
d.workshops[0].date = '2026-10-10';
d.workshops[0].pendingReschedule = { date: '2026-10-12', startTime: '', timeLabel: '', sendNow: true, enteredDate: '2026-10-08' };
save();
await at('2026-10-08T09:00:00'); assert.equal(dryRunSent.length, 14, 'announce now');
assert.ok(dryRunSent[12].text.includes('Monday, 12 October') && dryRunSent[12].text.includes('8 PM IST'), 'keeps old time when only date changes');

console.log(`Scheduler test passed ✓  (${dryRunSent.length} messages across the week)\n\nReschedule announcement:\n${ann}`);
fake.close();
process.exit(0);
