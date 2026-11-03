import { mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export const canonicalSession = file => existsSync(file) ? realpathSync(file) : join(realpathSync(dirname(file)), basename(file));
export const lockDirectory = file => `${canonicalSession(file)}.pi-shared-lock`;
const markerFile = file => `${canonicalSession(file)}.pi-shared.json`;

export class SessionBusyError extends Error {
  constructor() { super('Session is occupied; close the other endpoint first.'); this.code = 'SESSION_BUSY'; }
}
export class UnmanagedSessionError extends Error {
  constructor() { super('Close ordinary pi windows and enroll this session with pi-shared --enroll <id> first.'); this.code = 'SESSION_UNMANAGED'; }
}
export function isEnrolled(file) {
  try { const m = JSON.parse(readFileSync(markerFile(file), 'utf8')); return m.version === 1 && m.file === canonicalSession(file); }
  catch { return false; }
}
export function enrollSession(file) {
  writeFileSync(markerFile(file), JSON.stringify({ version: 1, file: canonicalSession(file) }) + '\n', { mode: 0o600 });
}
export function sessionOccupant(file) {
  const dir = lockDirectory(file);
  try {
    const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8'));
    return { channel: owner.channel === 'local' ? 'local' : 'telegram', pid: owner.pid, host: owner.host };
  } catch { return existsSync(dir) ? { channel: 'unknown' } : null; }
}

// A cooperative cross-process lock, acquired BEFORE opening/migrating a JSONL.
// No automatic stale eviction: crashed/ambiguous owners always fail closed.
export class SessionLease {
  static acquire(file, channel) {
    const lease = new SessionLease();
    lease.dir = lockDirectory(file);
    lease.token = randomBytes(24).toString('hex');
    try { mkdirSync(lease.dir, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new SessionBusyError(); throw error; }
    try {
      writeFileSync(join(lease.dir, 'owner.json'), JSON.stringify({ version: 1, token: lease.token,
        pid: process.pid, host: hostname(), channel, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) { rmSync(lease.dir, { recursive: true }); throw error; }
    return lease;
  }
  static verify(file, token) {
    try { return JSON.parse(readFileSync(join(lockDirectory(file), 'owner.json'), 'utf8')).token === token; }
    catch { return false; }
  }
  release() {
    if (this.released) return;
    const owner = JSON.parse(readFileSync(join(this.dir, 'owner.json'), 'utf8'));
    if (owner.token !== this.token) throw new Error('Session lock ownership changed; refusing release');
    rmSync(this.dir, { recursive: true });
    this.released = true;
  }
}
