// Copies of recently sent WhatsApp messages, per sending number.
// When a phone can't decrypt a message ("Waiting for this message"), it asks the sender to
// send it again. Baileys can only do that if it can look the message up here (getMessage).
// Kept on disk so retries still work after a restart or redeploy.
import fs from 'fs';
import path from 'path';
import { proto, BufferJSON } from '@whiskeysockets/baileys';
import { dataDir } from './paths.js';

const KEEP = 1000; // per number; retries arrive within minutes/hours, so this is plenty
const stores = new Map(); // accountId -> Map(messageId -> serialized message)

const fileOf = (accountId) => path.join(dataDir(), 'sent', `${accountId}.json`);

function load(accountId) {
  if (!stores.has(accountId)) {
    let entries = [];
    try { entries = Object.entries(JSON.parse(fs.readFileSync(fileOf(accountId), 'utf8'))); } catch {}
    stores.set(accountId, new Map(entries));
  }
  return stores.get(accountId);
}

export function rememberSent(accountId, sent) {
  if (!sent?.key?.id || !sent.message) return;
  const m = load(accountId);
  m.set(sent.key.id, JSON.stringify(sent.message, BufferJSON.replacer));
  while (m.size > KEEP) m.delete(m.keys().next().value);
  fs.mkdirSync(path.dirname(fileOf(accountId)), { recursive: true });
  const tmp = fileOf(accountId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)));
  fs.renameSync(tmp, fileOf(accountId));
}

export function findSent(accountId, messageId) {
  const raw = load(accountId).get(messageId);
  return raw ? proto.Message.fromObject(JSON.parse(raw, BufferJSON.reviver)) : undefined;
}

export function forgetAccount(accountId) {
  stores.delete(accountId);
  fs.rmSync(fileOf(accountId), { force: true });
}
