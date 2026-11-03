#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { PiBackend } from '../src/pi.js';
import { SessionLease, isEnrolled, enrollSession, sessionOccupant } from '../src/session-lock.js';

process.umask(0o077);
await main().catch(error => {
  console.error(error.code === 'SESSION_BUSY' ? 'Session occupied. Close the other endpoint; stale locks require manual verification.' :
    error.code === 'SESSION_UNMANAGED' ? 'Close ALL ordinary pi windows using this session first, then explicitly run: pi-shared --enroll <session-id>' :
    'Cannot open shared session. Check pi installation, session ID and lock state. Raw errors are suppressed.');
  process.exitCode = 1;
});

async function main() {
  let config = {};
  try { config = JSON.parse(readFileSync(process.env.PI_TELEGRAM_CONFIG || join(homedir(), '.config/pi-telegram-gateway/config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const backend = new PiBackend(process.cwd(), config.dataDir || join(homedir(), '.local/share/pi-telegram-gateway'), { sharedSessions: true });
  const sessions = await backend.listShared();
  const [command, arg, ...extra] = process.argv.slice(2);
  if (extra.length || (command && !['--list', '--new', '--session', '--enroll'].includes(command)) ||
      (['--session', '--enroll'].includes(command) && !arg) || (['--list', '--new'].includes(command) && arg)) {
    console.log('Usage: pi-shared [--list | --new | --session <id> | --enroll <id>]');
    process.exitCode = 1; return;
  }
  const show = () => sessions.forEach((s, i) => console.log(`${i + 1}. ${s.id} [${sessionOccupant(s.file)?.channel || (isEnrolled(s.file) ? 'available' : 'unmanaged')}] ${s.title}\n   ${s.cwd}`));
  if (command === '--list') { show(); return; }
  let record;
  if (command === '--new') record = await backend.create('Shared local conversation');
  else if (arg) {
    const matches = sessions.filter(s => s.id === arg || s.id.startsWith(arg));
    if (matches.length !== 1) throw new Error('Missing or ambiguous session ID');
    record = matches[0];
  } else {
    if (!process.stdin.isTTY) throw new Error('Choose session explicitly');
    show();
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = (await reader.question('Session number, or n for new: ')).trim(); }
    finally { reader.close(); }
    record = answer === 'n' ? await backend.create('Shared local conversation') : sessions[Number(answer) - 1];
    if (!record) throw new Error('Invalid selection');
  }
  if (!isEnrolled(record.file) && command !== '--enroll') throw Object.assign(new Error('Unmanaged session'), { code: 'SESSION_UNMANAGED' });
  const lease = SessionLease.acquire(record.file, 'local');
  try {
    if (command === '--enroll') enrollSession(record.file);
    // No arbitrary pi flags: --no-extensions / another --session would bypass
    // the guard. The child gets its original workspace, not the gateway cwd.
    const child = spawn(process.env.PI_SHARED_PI_BIN || 'pi', ['--session', record.file, '-e', fileURLToPath(new URL('../src/local-guard.js', import.meta.url))], {
      cwd: record.cwd || process.cwd(), stdio: 'inherit',
      env: { ...process.env, PI_SHARED_SESSION_FILE: record.file, PI_SHARED_SESSION_TOKEN: lease.token },
    });
    // Keep the parent alive and the lock held until the child has really exited.
    const interrupt = () => { child.kill('SIGINT'); };
    const terminate = () => { child.kill('SIGTERM'); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
      process.exitCode = code;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  } finally { lease.release(); }
}
