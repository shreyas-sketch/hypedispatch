// WhatsApp connections (one per sending number) via Baileys.
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  Browsers, jidNormalizedUser, WAMessageStatus,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { log } from './db.js';
import { dataDir } from './paths.js';
import { rememberSent, findSent, forgetAccount } from './sentStore.js';

const sessions = new Map(); // accountId -> { sock, status, qr, me }

// WhatsApp can refuse a message AFTER sendMessage returned (e.g. not allowed to post in that group).
// It arrives later as a messages.update with status ERROR; the scheduler subscribes here.
const rejectedHandlers = [];
export const onSendRejected = (fn) => rejectedHandlers.push(fn);
export function reportRejected(accountId, msgId, jid, code) { for (const fn of rejectedHandlers) fn(accountId, msgId, jid, String(code || '')); }

// Plain-English reason for a WhatsApp error code, and whether retrying could help
export function describeRejection(code) {
  const c = String(code || '');
  if (/^(401|not-authorized)$/.test(c)) return { permanent: true, text: `WhatsApp refused it (${c}): this number isn't allowed to post here` };
  if (/^(403|forbidden)$/.test(c)) return { permanent: true, text: `WhatsApp refused it (${c}): this number isn't allowed to post here (not an admin, or it's the community itself and not its announcements group)` };
  if (/^(404|item-not-found)$/.test(c)) return { permanent: true, text: `WhatsApp refused it (${c}): the group no longer exists or this number left it` };
  if (/^(406|not-acceptable)$/.test(c)) return { permanent: true, text: `WhatsApp refused it (${c}): this group doesn't accept messages from this number` };
  if (c === '463') return { permanent: true, text: 'WhatsApp refused it (463): this number looks restricted by WhatsApp' };
  return { permanent: false, text: `WhatsApp rejected it (error ${c || 'unknown'}), will retry` };
}
const authDir = (id) => {
  if (!/^[a-z0-9]+$/i.test(id || '')) throw new Error('Bad account id'); // never let an id escape data/auth
  return path.join(dataDir(), 'auth', id);
};

export function accountStatus(id) {
  if (process.env.HYPE_DRY_RUN) return { status: dryRunOffline.has(id) ? 'offline' : 'connected', qr: null, me: 'test-mode' }; // test mode: pretend connected
  const s = sessions.get(id);
  return { status: s?.status || 'offline', qr: s?.qr || null, me: s?.me || null };
}

export async function startAccount(id) {
  const prev = sessions.get(id);
  if (prev?.sock && !['offline', 'qr-expired'].includes(prev.status)) return;

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
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      if (u.key?.fromMe && u.update?.status === WAMessageStatus.ERROR) reportRejected(id, u.key.id, u.key.remoteJid, u.update.messageStubParameters?.[0]);
    }
  });

  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      s.status = 'scan-qr';
      s.qr = await QRCode.toDataURL(u.qr);
    }
    if (u.connection === 'open') {
      s.status = 'connected';
      s.qr = null;
      s.me = jidNormalizedUser(sock.user?.id);
      s.meLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null; // v7: WhatsApp may list us by LID in groups
      log('info', `WhatsApp ${id} connected as ${s.me}`, { kind: 'system' });
    }
    if (u.connection === 'close') {
      if (sessions.get(id) !== s) return; // number was removed or replaced, don't bring it back
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.timedOut && s.status === 'scan-qr' && !state.creds?.me) {
        // The QR was shown but nobody scanned it. Stop here instead of reconnecting (and asking WhatsApp
        // for new QR codes) forever; "Show QR" in the dashboard starts again.
        s.status = 'qr-expired';
        s.qr = null;
        log('info', `WhatsApp ${id}: the QR code expired without being scanned. Press "Show QR" to try again.`, { kind: 'system' });
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        s.status = 'offline';
        log('error', `WhatsApp ${id} was taken over by another session using the same login (is Hype Dispatch also running on another computer?). Stop the other copy, then press Resync.`, { kind: 'system' });
        return;
      }
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
  if (process.env.HYPE_DRY_RUN) { // test mode: groups from HYPE_DRY_RUN_GROUPS="Name 1,Name 2"
    return (process.env.HYPE_DRY_RUN_GROUPS || '').split(',').filter(Boolean).map((name, i) => ({ jid: `dry${i}@g.us`, name, kind: 'announcements', size: 100, community: true, adminOnly: true, isAdmin: true, canPost: true }));
  }
  const s = live(id);
  const all = await s.sock.groupFetchAllParticipating();
  // Our own ids: phone number and (Baileys 7) LID; participants may be listed by either
  return toGroupList(all, [s.me, s.meLid, s.sock.user?.id, s.sock.user?.lid]);
}

// Turn WhatsApp's group metadata into the list shown in the group picker (exported for tests)
export function toGroupList(all, myIds) {
  const mine = new Set(myIds.filter(Boolean).map((j) => j.split('@')[0].split(':')[0]));
  const names = new Map(Object.values(all).map((g) => [g.id, g.subject]));
  return Object.values(all).map((g) => {
    const me = g.participants?.find((p) => [p.id, p.jid, p.lid, p.phoneNumber]
      .filter(Boolean).some((j) => mine.has(j.split('@')[0].split(':')[0])));
    const isAdmin = !!(me?.admin || me?.isAdmin || me?.isSuperAdmin);
    // A WhatsApp community comes back twice: the community itself (isCommunity) and its announcements
    // group (isCommunityAnnounce), usually with the same name. Messages can only go to the announcements group.
    const kind = g.isCommunityAnnounce ? 'announcements' : g.isCommunity ? 'community' : g.linkedParent ? 'community-group' : 'group';
    return {
      jid: g.id,
      name: g.subject || '(no name)',
      parentName: g.linkedParent ? names.get(g.linkedParent) || '' : '',
      kind,
      size: g.size || g.participants?.length || 0,
      community: kind !== 'group',
      adminOnly: !!g.announce,
      isAdmin,
      canPost: kind === 'community' ? false : !g.announce || isAdmin || !me, // !me = couldn't tell, let it try
      cantPostReason: kind === 'community' ? 'This is the community itself. WhatsApp only allows posting in its announcements group.' : '',
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Test mode (HYPE_DRY_RUN): nothing leaves the PC. Tests can mark numbers offline or groups as failing.
export const dryRunSent = [];
export const dryRunOffline = new Set();
export const dryRunFailing = new Set();
export const dryRunErrors = new Map(); // jid -> error message to throw (e.g. 'forbidden')

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
    if (dryRunErrors.has(jid)) throw new Error(dryRunErrors.get(jid));
    dryRunSent.push({ id, jid, text });
    return `dry-${dryRunSent.length}`;
  }
  const s = live(id);
  // A half-dropped connection can make a send hang forever; give up and retry later instead
  const sent = await withTimeout(s.sock.sendMessage(jid, { text }), SEND_TIMEOUT_MS, 'Sending');
  rememberSent(id, sent); // needed to answer "please resend" requests from recipients' phones
  return sent?.key?.id;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
