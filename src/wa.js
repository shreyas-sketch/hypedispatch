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

const sessions = new Map(); // accountId -> { sock, status, qr, me }
const authDir = (id) => {
  if (!/^[a-z0-9]+$/i.test(id || '')) throw new Error('Bad account id'); // never let an id escape data/auth
  return path.resolve('data', 'auth', id);
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
      log('info', `WhatsApp ${id} connected as ${s.me}`);
    }
    if (u.connection === 'close') {
      if (sessions.get(id) !== s) return; // number was removed or replaced, don't bring it back
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        s.status = 'offline';
        fs.rmSync(authDir(id), { recursive: true, force: true });
        log('warn', `WhatsApp ${id} was logged out. Scan the QR again.`);
      } else {
        s.status = 'reconnecting';
        setTimeout(() => {
          if (sessions.get(id) !== s) return;
          s.status = 'offline';
          startAccount(id).catch((e) => log('error', `WhatsApp ${id} reconnect: ${e.message}`));
        }, 3000);
      }
    }
  });
}

export async function logoutAccount(id) {
  const dir = authDir(id);
  const s = sessions.get(id);
  sessions.delete(id);
  try { await s?.sock?.logout(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
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

export const dryRunSent = [];
export async function sendText(id, jid, text) {
  if (process.env.HYPE_DRY_RUN) { dryRunSent.push({ id, jid, text }); return; } // test mode: nothing leaves the PC
  const s = live(id);
  await s.sock.sendMessage(jid, { text });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
