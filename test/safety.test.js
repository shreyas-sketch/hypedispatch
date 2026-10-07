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
d.workshops.push({ id: 'w1', programmeId: prog.id, date: '2026-10-10', sendTime: '11:00', active: true, account: 'a1', groups: [{ jid: 'g@g.us', name: 'G' }], firstSendDate: '2026-09-30' });
d.workshops.push({ id: 'w2', programmeId: prog.id, date: '2026-10-10', sendTime: '11:00', active: true, groups: [], firstSendDate: '2026-09-30' });
for (let m = 0; m < 5; m++) { await tick(new Date(`2026-09-30T11:0${m}:00+05:30`)); await new Promise((r) => setTimeout(r, 30)); }
assert.equal(d.log.filter((l) => l.msg.includes('no fact sheet')).length, 1, 'missing fact sheet logged once');
assert.equal(d.log.filter((l) => l.msg.includes('no WhatsApp groups are picked')).length, 1, 'no groups logged once');

// 2b. Every reason for not sending is written to the activity log once, after the send time
{
  const fs_ = { title: 'T' };
  const p2 = d.programmes[1]; p2.factSheet = fs_;
  const base = { programmeId: p2.id, date: '2026-10-10', sendTime: '11:00', active: true, account: 'a1', groups: [{ jid: 'x@g.us', name: 'X' }], firstSendDate: '2026-09-30' };
  d.workshops.push({ ...base, id: 'p1', name: 'Paused one', active: false });
  d.workshops.push({ ...base, id: 'p2', name: 'Later start', firstSendDate: '2026-10-03' });
  d.workshops.push({ ...base, id: 'p3', name: 'Pending move', pendingReschedule: { date: '2026-10-12', sendAt: new Date('2026-09-30T19:00:00+05:30').toISOString() } });
  d.workshops.push({ ...base, id: 'p4', name: 'No number', account: '' });
  await tick(new Date('2026-09-30T10:59:00+05:30'));
  assert.ok(!d.log.some((l) => l.workshopId === 'p1'), 'nothing logged before the send time');
  for (const t of ['11:00', '11:01', '11:02']) await tick(new Date(`2026-09-30T${t}:00+05:30`));
  const why = (id) => d.log.filter((l) => l.workshopId === id && l.kind === 'notsent').map((l) => l.msg);
  assert.deepEqual(why('p1'), ["Paused one: today's daily hype message (11 AM) was NOT sent: the workshop is paused (More settings → Sending)"]);
  assert.ok(why('p2')[0].includes('start sending from 2026-10-03'));
  assert.ok(why('p3')[0].includes('date change to 2026-10-12 is waiting to be announced (at 7 PM)'));
  assert.ok(why('p4')[0].includes('no sending WhatsApp number'));
  for (const id of ['p1', 'p2', 'p3', 'p4']) assert.equal(why(id).length, 1, `${id} logged once`);
  d.workshops = d.workshops.filter((w) => !w.id.startsWith('p'));
}

// 3. Deleted seed programmes stay deleted after a restart
d.programmes = d.programmes.filter((p) => p.name !== 'Deepak Crypto');
d.programmes.find((p) => p.name === 'BO Akshat').name = 'BO Akshat (renamed)';
save();
const reloaded = await import('../src/db.js?restart');
const names = reloaded.db().programmes.map((p) => p.name);
assert.ok(!names.includes('Deepak Crypto'), 'deleted seed not re-added');
assert.ok(!names.includes('BO Akshat'), 'renamed seed not duplicated');
assert.equal(names.length, 9);
assert.equal(reloaded.db().programmes.find((p) => p.name === 'Deepak Crypto' || p.name === 'Aarzoo Personal Finance').signature, '*Team Aarzoo Shah*\nwww.aarzooshah.com', 'seed signature');

// Older data (no signature field) gets the seed signature once; an edited one is kept
{
  const prog = reloaded.db().programmes.find((p) => p.name === 'BO Chirag');
  prog.signature = '*Custom*';
  const other = reloaded.db().programmes.find((p) => p.name === 'Siddharth Ecom');
  delete other.signature;
  reloaded.save();
  const again = await import('../src/db.js?restart2');
  assert.equal(again.db().programmes.find((p) => p.name === 'BO Chirag').signature, '*Custom*');
  assert.equal(again.db().programmes.find((p) => p.name === 'Siddharth Ecom').signature, '*Team Siddharth Kapoor*');
}

// Resync: saved group names are refreshed, and groups the number has left are reported
{
  const { syncWorkshopGroups } = await import('../src/workshop.js');
  d.workshops.push({ id: 'w3', programmeId: prog.id, date: '2026-10-10', account: 'acc1', groups: [{ jid: 'a@g.us', name: 'Old name' }, { jid: 'b@g.us', name: 'Left group' }] });
  d.workshops.push({ id: 'w4', programmeId: prog.id, date: '2026-10-10', account: 'other', groups: [{ jid: 'a@g.us', name: 'Untouched' }] });
  const r = syncWorkshopGroups('acc1', [{ jid: 'a@g.us', name: '4th Oct Consulting' }]);
  assert.equal(r.renamed, 1);
  assert.deepEqual(r.missing.map((m) => m.group), ['Left group']);
  assert.equal(d.workshops.find((w) => w.id === 'w3').groups[0].name, '4th Oct Consulting');
  assert.equal(d.workshops.find((w) => w.id === 'w4').groups[0].name, 'Untouched', 'other numbers not touched');
}

// Sent messages are kept so "please resend" requests (the "Waiting for this message" fix) can be answered
{
  const { rememberSent, findSent, forgetAccount } = await import('../src/sentStore.js');
  const { proto } = await import('@whiskeysockets/baileys');
  const message = proto.Message.fromObject({ extendedTextMessage: { text: '🔥 *Workshop* tomorrow\n\nhttps://forms.gle/x' } });
  rememberSent('acc1', { key: { id: 'MSG1', remoteJid: 'g@g.us', fromMe: true }, message });
  assert.equal(findSent('acc1', 'MSG1').extendedTextMessage.text, '🔥 *Workshop* tomorrow\n\nhttps://forms.gle/x');
  assert.equal(findSent('acc1', 'nope'), undefined);
  assert.equal(findSent('acc2', 'MSG1'), undefined, 'kept per number');
  // survives a restart (fresh module = fresh memory, reads the file)
  const fresh = await import('../src/sentStore.js?restart');
  assert.equal(fresh.findSent('acc1', 'MSG1').extendedTextMessage.text.startsWith('🔥'), true, 'kept on disk');
  forgetAccount('acc1');
  const fresh2 = await import('../src/sentStore.js?restart2');
  assert.equal(fresh2.findSent('acc1', 'MSG1'), undefined, 'removed with the number');
}

// Group picker: community itself vs its announcements group; admin detection by phone number or LID (Baileys 7)
{
  const { toGroupList } = await import('../src/wa.js');
  const all = {
    'c@g.us': { id: 'c@g.us', subject: '4th Oct Consulting', isCommunity: true, participants: [] },
    'a@g.us': { id: 'a@g.us', subject: '4th Oct Consulting', isCommunityAnnounce: true, linkedParent: 'c@g.us', announce: true,
      participants: [{ id: '123456@lid', phoneNumber: '919999999999@s.whatsapp.net', admin: 'admin' }] },
    'b@g.us': { id: 'b@g.us', subject: 'Other announcements', isCommunityAnnounce: true, announce: true,
      participants: [{ id: '777@lid', admin: null }, { id: '123456@lid', admin: null }] },
    's@g.us': { id: 's@g.us', subject: 'Q&A group', linkedParent: 'c@g.us', participants: [] },
    'n@g.us': { id: 'n@g.us', participants: [] }, // no name: must not crash
  };
  const list = toGroupList(all, ['919999999999:12@s.whatsapp.net', '123456:12@lid']);
  const by = Object.fromEntries(list.map((g) => [g.jid, g]));
  assert.equal(by['c@g.us'].kind, 'community'); assert.equal(by['c@g.us'].canPost, false, 'community itself is not postable');
  assert.equal(by['a@g.us'].kind, 'announcements'); assert.equal(by['a@g.us'].canPost, true, 'admin found via LID');
  assert.equal(by['b@g.us'].canPost, false, 'admin-only and we are not admin');
  assert.equal(by['s@g.us'].kind, 'community-group'); assert.equal(by['s@g.us'].parentName, '4th Oct Consulting');
  assert.equal(by['n@g.us'].name, '(no name)');
  // resync flags workshops that picked the community itself
  const { syncWorkshopGroups } = await import('../src/workshop.js');
  d.workshops.push({ id: 'wc', programmeId: prog.id, date: '2026-10-10', account: 'accC', groups: [{ jid: 'c@g.us', name: '4th Oct Consulting' }] });
  assert.equal(syncWorkshopGroups('accC', list).wrongKind.length, 1);
}

// Official workshop name + host: pre-filled once for existing data, and they override the fact sheet in messages
{
  const fresh = await import('../src/db.js?names');
  const progs = fresh.db().programmes;
  const sid = progs.find((p) => p.name === 'Siddharth Ecom');
  assert.equal(sid.title, 'Launch Method Workshop'); assert.equal(sid.host, 'Siddharth Kapoor');
  assert.equal(progs.find((p) => p.name === 'BO Chirag').host, 'Chirag Jhumkhawala');
  const { resolve } = await import('../src/workshop.js');
  const p = d.programmes.find((x) => x.name === 'Aarzoo Leadership');
  p.factSheet = { title: 'The Leadership Blueprint Masterclass (old name)', host: 'Aarzoo' };
  p.title = 'Leadership Code Masterclass'; p.host = 'Aarzoo Shah';
  const r = resolve({ id: 'x', programmeId: p.id, date: '2026-10-20', groups: [] });
  assert.equal(r.factSheet.title, 'Leadership Code Masterclass'); assert.equal(r.factSheet.host, 'Aarzoo Shah');
  p.title = ''; p.host = '';
  assert.equal(resolve({ id: 'x', programmeId: p.id, date: '2026-10-20', groups: [] }).factSheet.title, 'The Leadership Blueprint Masterclass (old name)', 'blank = use the landing page name');
}

console.log('Safety tests passed ✓');
process.exit(0);
