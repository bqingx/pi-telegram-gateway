import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SessionLease, enrollSession, isEnrolled, sessionOccupant } from '../src/session-lock.js';
import { PiBackend } from '../src/pi.js';
import { State } from '../src/state.js';
import { Gateway } from '../src/gateway.js';
import localGuard from '../src/local-guard.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sharing-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.jsonl');
  writeFileSync(file, '{"test":"do not modify"}\n');
  return { dir, file };
}

test('a session admits only one endpoint; release permits the other', t => {
  const { file } = fixture(t);
  const local = SessionLease.acquire(file, 'local');
  assert.equal(sessionOccupant(file).channel, 'local');
  assert.throws(() => SessionLease.acquire(file, 'telegram'), { code: 'SESSION_BUSY' });
  assert.ok(SessionLease.verify(file, local.token));
  local.release(); local.release();
  const telegram = SessionLease.acquire(file, 'telegram');
  assert.throws(() => SessionLease.acquire(file, 'local'), { code: 'SESSION_BUSY' });
  telegram.release(); assert.equal(sessionOccupant(file), null);
});
test('symlink aliases share the same lock', t => {
  const { file, dir } = fixture(t), alias = join(dir, 'alias.jsonl');
  symlinkSync(file, alias);
  const lease = SessionLease.acquire(file, 'local');
  assert.throws(() => SessionLease.acquire(alias, 'telegram'), { code: 'SESSION_BUSY' });
  lease.release();
});
test('empty/crashed lock owners fail closed and are not automatically evicted', t => {
  const { file } = fixture(t);
  mkdirSync(`${file}.pi-shared-lock`);
  assert.equal(sessionOccupant(file).channel, 'unknown');
  assert.throws(() => SessionLease.acquire(file, 'local'), { code: 'SESSION_BUSY' });
});
test('busy and unenrolled sessions are refused BEFORE the SDK opens/migrates files', async t => {
  const { file, dir } = fixture(t), backend = new PiBackend(dir, dir, { sharedSessions: true });
  backend.sdk = async () => { throw new Error('SDK MUST NOT BE CALLED'); };
  await assert.rejects(backend.open({ file, id: 'x' }), { code: 'SESSION_UNMANAGED' });
  enrollSession(file); assert.equal(isEnrolled(file), true);
  const lease = SessionLease.acquire(file, 'local');
  await assert.rejects(backend.open({ file, id: 'x' }), { code: 'SESSION_BUSY' });
  lease.release();
  assert.equal(readFileSync(file, 'utf8'), '{"test":"do not modify"}\n');
  await assert.rejects(backend.open({ file, id: 'x' }), /SDK MUST NOT BE CALLED/);
  assert.equal(sessionOccupant(file), null); // Failed SDK initialization released its lease.
});
test('another process holding a local session excludes Telegram', async t => {
  const { file } = fixture(t);
  const module = new URL('../src/session-lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {SessionLease} from ${JSON.stringify(module)};
    const lease=SessionLease.acquire(process.env.TEST_FILE,'local');
    process.send('ready');
    process.on('message',()=>{lease.release();process.exit(0)});
  `], { env: { ...process.env, TEST_FILE: file }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill());
  await once(child, 'message');
  assert.throws(() => SessionLease.acquire(file, 'telegram'), { code: 'SESSION_BUSY' });
  child.send('release'); await once(child, 'exit');
  const lease = SessionLease.acquire(file, 'telegram'); lease.release();
});
test('shared list exposes local metadata only to the configured Telegram owner', async t => {
  const { file, dir } = fixture(t), state = new State(join(dir, 'state'));
  state.setLanguage(42, 'en');
  const sent = [], backend = {
    listShared: async () => [{ id: 'local-1', file, cwd: dir, title: 'Local history', createdAt: '2026-01-01', modifiedAt: '2026-01-02' }],
    usage: () => 'unmanaged',
  };
  const g = new Gateway({ state, telegram: { send: async (...args) => sent.push(args) }, backend, allowedUsers: [42, 99], sharedSessionOwner: 42 });
  const message = id => ({ message: { from: { id }, chat: { id, type: 'private' }, text: '/sessions' } });
  await g.handle(message(99)); assert.doesNotMatch(sent.at(-1)[2], /Local history/);
  await g.handle(message(42)); assert.match(sent.at(-1)[2], /Local history/); assert.match(sent.at(-1)[2], /unmanaged/);
  await g.handle(message(99)); assert.doesNotMatch(sent.at(-1)[2], /Local history/);
  g.sharedSessionOwner = undefined; // Revoking sharing also hides previously indexed native metadata.
  await g.handle(message(42)); assert.doesNotMatch(sent.at(-1)[2], /Local history/);
});
test('failed occupied restore leaves the previous Telegram binding unchanged', async t => {
  const { file, dir } = fixture(t), state = new State(join(dir, 'state')), sent = [];
  state.setLanguage(42, 'en');
  for (const id of ['old', 'target']) state.data.sessions[id] = { id, user: 42, chat: 42, file, title: id, createdAt: '2026-01-01' };
  state.bind(42, 11, 'old', 42);
  const g = new Gateway({ state, telegram: { send: async (...a) => sent.push(a) },
    backend: { open: async () => { throw Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }); } }, allowedUsers: [42] });
  await g.handle({ message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, message_thread_id: 11, text: '/topic target' } });
  assert.equal(state.current(42, 11).id, 'old'); assert.match(sent.at(-1)[2], /occupied/);
});
test('local guard blocks in-process session switching and checks the parent lease', async t => {
  const { file } = fixture(t), lease = SessionLease.acquire(file, 'local');
  const oldFile = process.env.PI_SHARED_SESSION_FILE, oldToken = process.env.PI_SHARED_SESSION_TOKEN;
  process.env.PI_SHARED_SESSION_FILE = file; process.env.PI_SHARED_SESSION_TOKEN = lease.token;
  t.after(() => {
    if (oldFile === undefined) delete process.env.PI_SHARED_SESSION_FILE; else process.env.PI_SHARED_SESSION_FILE = oldFile;
    if (oldToken === undefined) delete process.env.PI_SHARED_SESSION_TOKEN; else process.env.PI_SHARED_SESSION_TOKEN = oldToken;
  });
  const handlers = {}, commands = {}, notices = [];
  localGuard({ on: (event, fn) => { handlers[event] = fn; }, registerCommand: (name, command) => { commands[name] = command; } });
  let shutdown = false;
  const ctx = { sessionManager: { getSessionFile: () => file }, ui: { notify: text => notices.push(text), setStatus() {} }, abort() {}, shutdown: () => { shutdown = true; } };
  assert.equal(handlers.input({}, ctx).action, 'continue');
  assert.equal(handlers.session_before_switch({}, ctx).cancel, true);
  assert.equal(handlers.session_before_fork({}, ctx).cancel, true);
  await commands['shared-release'].handler('', ctx); assert.equal(shutdown, true);
  lease.release();
  assert.equal(handlers.input({}, ctx).action, 'handled');
  assert.equal(handlers.tool_call({}, ctx).block, true);
});
