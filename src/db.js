// Tiny JSON-file store. Everything lives in data/db.json so it survives restarts.
import fs from 'fs';
import path from 'path';
import { SEED_PROGRAMMES } from './seed.js';
import { dataDir } from './paths.js';

let DIR, FILE;
const EMPTY = { programmes: [], accounts: [], workshops: [], sends: [], history: {} };

let cache = null;

export function db() {
  if (cache) return cache;
  DIR = dataDir();
  FILE = path.join(DIR, 'db.json');
  fs.mkdirSync(DIR, { recursive: true });
  cache = fs.existsSync(FILE)
    ? { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
    : structuredClone(EMPTY);
  // Add each seed programme once. Remember which were added so a renamed or deleted one doesn't come back.
  cache.seeded ||= [];
  for (const p of SEED_PROGRAMMES) {
    if (cache.seeded.includes(p.name)) continue;
    if (!cache.programmes.some((x) => x.name === p.name)) cache.programmes.push({ id: newId(), ...p, factSheet: null });
    cache.seeded.push(p.name);
  }
  // Repair workshops a bad request may have damaged in older versions (wrong types would break pages and sends)
  for (const w of cache.workshops) {
    if (!Array.isArray(w.groups)) w.groups = [];
    w.groups = w.groups.filter((g) => g && typeof g.jid === 'string');
    for (const k of ['active', 'dayOf']) if (typeof w[k] === 'string') w[k] = w[k] !== 'false';
  }
  // Give existing seed programmes their signature once (a signature you've edited or cleared is kept)
  for (const p of SEED_PROGRAMMES) {
    const prog = cache.programmes.find((x) => x.name === p.name);
    if (prog && prog.signature === undefined) prog.signature = p.signature;
  }
  return cache;
}

export function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE); // atomic swap so a crash never leaves half a file
}

export const newId = () => Math.random().toString(36).slice(2, 10);

// Rolling activity log shown in the dashboard.
// extra: { kind: 'sent' | 'notsent' | 'change' | 'system' | 'info', workshopId, key (send record) }
export function log(level, msg, extra = {}) {
  const d = db();
  d.log = d.log || [];
  d.log.unshift({ at: new Date().toISOString(), level, msg, kind: level === 'error' ? 'notsent' : 'info', ...extra });
  d.log = d.log.slice(0, 3000);
  save();
  console.log(`[${level}] ${msg}`);
}
