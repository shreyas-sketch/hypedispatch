// Where data (db.json + WhatsApp logins) lives.
// Locally: ./data. On Railway: the attached volume (Railway sets RAILWAY_VOLUME_MOUNT_PATH), or DATA_DIR if you set it.
import path from 'path';

export const onRailway = () => !!process.env.RAILWAY_ENVIRONMENT;
export const dataDir = () => path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || 'data');
// On Railway without a volume, everything is wiped on each redeploy
export const storageIsTemporary = () => onRailway() && !process.env.DATA_DIR && !process.env.RAILWAY_VOLUME_MOUNT_PATH;
