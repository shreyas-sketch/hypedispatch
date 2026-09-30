// Tiny JSON-file store. Everything lives in data/db.json so it survives restarts.
import fs from 'fs';
import path from 'path';
import { SEED_PROGRAMMES } from './seed.js';

const DIR = path.resolve('data');
const FILE = path.join(DIR, 'db.json');
const EMPTY = { programmes: [], accounts: [], workshops: [], sends: [], history: {} };

let cache = null;

export function db() {
  if (cache) return cache;
  fs.mkdirSync(DIR, { recursive: true });
  cache = fs.existsSync(FILE)
    ? { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
    : structuredClone(EMPTY);
  // Add any seed programme that isn't there yet (matched by name)
  for (const p of SEED_PROGRAMMES) {
    if (!cache.programmes.some((x) => x.name === p.name)) cache.programmes.push({ id: newId(), ...p, factSheet: null });
  }
  return cache;
}

export function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE); // atomic swap so a crash never leaves half a file
}

export const newId = () => Math.random().toString(36).slice(2, 10);

// Rolling activity log shown in the dashboard
export function log(level, msg, extra = {}) {
  const d = db();
  d.log = d.log || [];
  d.log.unshift({ at: new Date().toISOString(), level, msg, ...extra });
  d.log = d.log.slice(0, 500);
  save();
  console.log(`[${level}] ${msg}`);
}
