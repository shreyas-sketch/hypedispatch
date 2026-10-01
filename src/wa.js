// WhatsApp connections (one per sending number) via Baileys.
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  Browsers, jidNormalizedUser,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { log } from './db.js';
import { dataDir } from './paths.js';
import { rememberSent, findSent, forgetAccount } from './sentStore.js';

const sessions = new Map(); // accountId -> { sock, status, qr, me }
const authDir = (id) => {
  if (!/^[a-z0-9]+$/i.test(id || '')) throw new Error('Bad account id'); // never let an id escape data/auth
  return path.join(dataDir(), 'auth', id);
};

export function accountStatus(id) {
  const s = sessions.get(id);
  return { status: s?.status || 'offline', qr: s?.qr || null, me: s?.me || null };
}

export async function startAccount(id) {
  const prev = sessions.get(id);
  if (prev?.sock && prev.status !== 'offline') return;

  const { state, saveCreds } = await useMultiFileAuthState(authDir(id));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.windows('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Lets Baileys resend a message when a recipient's phone couldn't decrypt it.
    // Without this, those people are stuck on "Waiting for this message".
    getMessage: async (key) => findSent(id, key.id),
  });

  const s = { sock, status: 'connecting', qr: null, me: null };
  sessions.set(id, s);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      s.status = 'scan-qr';
      s.qr = await QRCode.toDataURL(u.qr);
    }
    if (u.connection === 'open') {
      s.status = 'connected';
      s.qr = null;
      s.me = jidNormalizedUser(sock.user?.id);
      log('info', `WhatsApp ${id} connected as ${s.me}`, { kind: 'system' });
    }
    if (u.connection === 'close') {
      if (sessions.get(id) !== s) return; // number was removed or replaced, don't bring it back
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        s.status = 'offline';
        fs.rmSync(authDir(id), { recursive: true, force: true });
        log('warn', `WhatsApp ${id} was logged out. Scan the QR again.`, { kind: 'system' });
      } else {
        s.status = 'reconnecting';
        setTimeout(() => {
          if (sessions.get(id) !== s) return;
          s.status = 'offline';
          startAccount(id).catch((e) => log('error', `WhatsApp ${id} reconnect: ${e.message}`, { kind: 'system' }));
        }, 3000);
      }
    }
  });
}

// Resync: drop the current connection and open a fresh one with the same login (no QR needed),
// so WhatsApp re-sends the latest groups and communities. Waits until it's connected again.
export async function resyncAccount(id, timeoutMs = 30000) {
  const old = sessions.get(id);
  sessions.delete(id); // so the old socket's close event doesn't start its own reconnect
  try { old?.sock?.end(undefined); } catch {}
  await startAccount(id);
  const s = sessions.get(id);
  const until = Date.now() + timeoutMs;
  while (s.status !== 'connected' && s.status !== 'scan-qr' && sessions.get(id) === s && Date.now() < until) await sleep(500);
  return s.status;
}

export async function logoutAccount(id) {
  const dir = authDir(id);
  const s = sessions.get(id);
  sessions.delete(id);
  try { await s?.sock?.logout(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
  forgetAccount(id);
}

function live(id) {
  const s = sessions.get(id);
  if (!s || s.status !== 'connected') throw new Error(`WhatsApp account "${id}" is not connected`);
  return s;
}

// Groups + community announcement channels this number is in
export async function listGroups(id) {
  const s = live(id);
  const all = await s.sock.groupFetchAllParticipating();
  const meNum = s.me?.split('@')[0];
  return Object.values(all).map((g) => {
    const me = g.participants?.find((p) => [p.id, p.jid, p.phoneNumber]
      .filter(Boolean).some((j) => j.split('@')[0].split(':')[0] === meNum));
    const isAdmin = !!me?.admin;
    return {
      jid: g.id,
      name: g.subject,
      size: g.participants?.length || g.size || 0,
      community: !!(g.isCommunityAnnounce || g.isCommunity),
      adminOnly: !!g.announce,
      isAdmin,
      canPost: !g.announce || isAdmin || !me, // !me = couldn't tell, let it try
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Test mode (HYPE_DRY_RUN): nothing leaves the PC. Tests can mark numbers offline or groups as failing.
export const dryRunSent = [];
export const dryRunOffline = new Set();
export const dryRunFailing = new Set();

export function isConnected(id) {
  if (process.env.HYPE_DRY_RUN) return !dryRunOffline.has(id);
  return sessions.get(id)?.status === 'connected';
}

const SEND_TIMEOUT_MS = 60_000;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

export async function sendText(id, jid, text) {
  if (process.env.HYPE_DRY_RUN) {
    if (dryRunOffline.has(id)) throw new Error(`WhatsApp account "${id}" is not connected`);
    if (dryRunFailing.has(jid)) throw new Error('send failed (test)');
    dryRunSent.push({ id, jid, text });
    return;
  }
  const s = live(id);
  // A half-dropped connection can make a send hang forever; give up and retry later instead
  const sent = await withTimeout(s.sock.sendMessage(jid, { text }), SEND_TIMEOUT_MS, 'Sending');
  rememberSent(id, sent); // needed to answer "please resend" requests from recipients' phones
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
