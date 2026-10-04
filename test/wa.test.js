// Run: node --experimental-test-module-mocks test/wa.test.js
// Drives src/wa.js with a FAKE WhatsApp library, to test the connection lifecycle without a phone.
import assert from 'assert';
import { mock } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'hype-wa-')));
const sockets = [];
let creds = {};
const fakeSocket = () => {
  const handlers = {};
  const sock = { ev: { on: (n, fn) => { (handlers[n] ||= []).push(fn); } }, emit: (n, v) => (handlers[n] || []).forEach((fn) => fn(v)),
    user: undefined, end: () => {}, logout: async () => {}, sendMessage: async () => ({ key: { id: 'MSG1' }, message: { conversation: 'x' } }) };
  sockets.push(sock);
  return sock;
};
const real = await import('@whiskeysockets/baileys');
const { default: _ignored, ...realNamed } = real;
mock.module('@whiskeysockets/baileys', {
  defaultExport: fakeSocket,
  namedExports: {
    ...realNamed, useMultiFileAuthState: async () => ({ state: { creds }, saveCreds: () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
  },
});
const wa = await import('../src/wa.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const close = (sock, code) => sock.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });

// 1. QR shown, never scanned, expires (408): stop, don't loop asking WhatsApp for new QRs
await wa.startAccount('acc1');
sockets[0].emit('connection.update', { qr: 'qr-data' }); await wait(50);
assert.equal(wa.accountStatus('acc1').status, 'scan-qr');
close(sockets[0], 408); await wait(3500);
assert.equal(wa.accountStatus('acc1').status, 'qr-expired');
assert.equal(sockets.length, 1, 'no reconnect loop after the QR expired');
// "Show QR" starts again
await wa.startAccount('acc1');
assert.equal(sockets.length, 2, 'Show QR opens a fresh connection');

// 2. A linked number that drops (e.g. network) reconnects by itself
creds = { me: { id: '919999999999:1@s.whatsapp.net' } };
await wa.startAccount('acc2');
const s2 = sockets.at(-1); s2.user = creds.me; s2.emit('connection.update', { connection: 'open' }); await wait(20);
assert.equal(wa.accountStatus('acc2').status, 'connected');
close(s2, 428); await wait(3500);
assert.equal(sockets.length, 4, 'linked number reconnects after a drop');

// 3. Right after scanning, WhatsApp asks for a restart (515): must reconnect, not stop
creds = {};
await wa.startAccount('acc3');
const s3 = sockets.at(-1); s3.emit('connection.update', { qr: 'q' }); await wait(20);
creds.me = { id: '91888:1@s.whatsapp.net' }; // pairing succeeded
close(s3, 515); await wait(3500);
assert.equal(sockets.length, 6, 'restart after pairing reconnects');

// 4. Another copy took over the login (440): stop, don't fight
const s4 = sockets.at(-1); s4.user = creds.me; s4.emit('connection.update', { connection: 'open' }); await wait(20);
close(s4, 440); await wait(3500);
assert.equal(wa.accountStatus('acc3').status, 'offline');
assert.equal(sockets.length, 6, 'no reconnect fight with another copy');

// 5. Sending returns the message id, and a later refusal is reported
const got = [];
wa.onSendRejected((acc, id, jid, code) => got.push([acc, id, jid, code]));
sockets[3].user = { id: '919999999999:1@s.whatsapp.net' }; sockets[3].emit('connection.update', { connection: 'open' }); await wait(20); // acc2's reconnected socket
const msgId = await wa.sendText('acc2', 'g@g.us', 'hello');
assert.equal(msgId, 'MSG1');
sockets[3].emit('messages.update', [{ key: { id: 'MSG1', fromMe: true, remoteJid: 'g@g.us' }, update: { status: real.WAMessageStatus.ERROR, messageStubParameters: ['403'] } }]);
assert.deepEqual(got, [['acc2', 'MSG1', 'g@g.us', '403']]);

console.log('WhatsApp connection tests passed ✓');
process.exit(0);
