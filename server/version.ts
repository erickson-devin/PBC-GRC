import fs from 'fs';
import { fileURLToPath } from 'url';

/** The release version: package.json "version", read once at startup ('unknown' if unreadable). Reported by GET /api/v1/health. */
export function readAppVersion(file: string = fileURLToPath(new URL('../package.json', import.meta.url))): string {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))?.version;
    return typeof v === 'string' && v.length > 0 ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const APP_VERSION = readAppVersion();
