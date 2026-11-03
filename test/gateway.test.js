import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Gateway } from '../src/gateway.js';
import { splitText, Telegram } from '../src/telegram.js';
import { PiBackend } from '../src/pi.js';

function setup(t, { slow = false, maxActive = 4 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tg-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(dir), sent = [], prompts = [];
  state.setLanguage(42, 'en');
  let topic = 10, session = 0, release;
  const telegram = { send: async (...args) => { sent.push(args); }, topic: async () => ++topic,
    panel: async (chat, thread, text) => { sent.push([chat, thread, text]); return { message_id: 1 }; }, rename: async () => {} };
  const backend = {
    create: async () => ({ id: `s${++session}`, file: '/fake' }),
    open: async record => ({
      prompt: async text => { prompts.push([record.id, text]); if (slow) await new Promise(r => { release = r; }); return `reply:${record.id}`; },
      last: () => `last:${record.id}`, setTitle() {}, abort: async () => release?.(), dispose() {},
    }),
  };
  const typing = [];
  telegram.startTyping = (chat, thread) => {
    const pulse = { chat, thread, stopped: false };
    typing.push(pulse);
    return () => { pulse.stopped = true; };
  };
  const gateway = new Gateway({ state, telegram, backend, allowedUsers: [42], maxActive });
  let id = 0;
  const message = (text, thread, extra = {}) => ({ update_id: ++id, message: {
    chat: { id: 42, type: 'private' }, from: { id: 42 }, text, message_thread_id: thread, ...extra,
  } });
  const idle = async () => { await Promise.all([...gateway.active.values()].map(j => j.promise)); };
  return { state, sent, prompts, gateway, message, idle, telegram, dir, typing };
}

test('root prompt creates a topic/session and replies in that topic', async t => {
  const x = setup(t); await x.gateway.handle(x.message('hello')); await x.idle();
  assert.equal(x.state.current(42, 11).id, 's1');
  assert.deepEqual(x.prompts, [['s1', 'hello']]);
  assert.deepEqual(x.sent.at(-1), [42, 11, 'reply:s1']);
  assert.deepEqual(x.typing.map(p => p.thread), [undefined, 11]);
  assert.ok(x.typing.every(p => p.stopped));
});
test('each root prompt starts a separate session; topic continues original', async t => {
  const x = setup(t);
  await x.gateway.handle(x.message('one')); await x.idle();
  await x.gateway.handle(x.message('two')); await x.idle();
  await x.gateway.handle(x.message('continue', 11)); await x.idle();
  assert.deepEqual(x.prompts.map(p => p[0]), ['s1', 's2', 's1']);
});
test('thread 1 is root; root commands do not create sessions', async t => {
  const x = setup(t); await x.gateway.handle(x.message('/help', 1));
  assert.equal(Object.keys(x.state.data.sessions).length, 0);
  await x.gateway.handle(x.message('hi', 1)); await x.idle();
  assert.equal(x.state.current(42, 11).id, 's1');
});
test('unauthorized, groups, bots and edits are ignored', async t => {
  const x = setup(t);
  await x.gateway.handle(x.message('x', undefined, { from: { id: 99 } }));
  await x.gateway.handle(x.message('x', undefined, { chat: { id: 42, type: 'group' } }));
  await x.gateway.handle(x.message('x', undefined, { from: { id: 42, is_bot: true } }));
  await x.gateway.handle({ edited_message: x.message('x').message });
  assert.equal(x.sent.length, 0); assert.equal(x.prompts.length, 0);
  assert.equal(x.typing.length, 0);
});
test('/new preserves old session; /topic restores it and replays last text', async t => {
  const x = setup(t); await x.gateway.handle(x.message('hello')); await x.idle();
  await x.gateway.handle(x.message('/new', 11));
  assert.equal(x.state.current(42, 11).id, 's2');
  await x.gateway.handle(x.message('/topic s1', 11));
  assert.equal(x.state.current(42, 11).id, 's1');
  assert.equal(x.sent.at(-1)[2], 'last:s1');
});
test('cannot bind a session already used by another topic', async t => {
  const x = setup(t); await x.gateway.handle(x.message('hello')); await x.idle();
  await x.gateway.handle(x.message('/topic s1', 99));
  assert.equal(x.state.current(42, 99), undefined);
  assert.match(x.sent.at(-1)[2], /Cannot switch/);
});
test('cannot restore foreign-user or foreign-chat sessions', t => {
  const x = setup(t);
  x.state.data.sessions.foreign = { id: 'foreign', user: 99, chat: 42 };
  assert.throws(() => x.state.bind(42, 11, 'foreign', 42));
  x.state.data.sessions.foreign = { id: 'foreign', user: 42, chat: 99 };
  assert.throws(() => x.state.bind(42, 11, 'foreign', 42));
});
test('busy session rejects switching and duplicate prompts; stop stays responsive', async t => {
  const x = setup(t, { slow: true });
  await x.gateway.handle(x.message('slow')); await new Promise(r => setImmediate(r));
  await x.gateway.handle(x.message('/new', 11)); assert.match(x.sent.at(-1)[2], /busy/);
  await x.gateway.handle(x.message('again', 11)); assert.match(x.sent.at(-1)[2], /not queued/);
  assert.equal(x.typing.at(-1).stopped, false);
  await x.gateway.handle(x.message('/stop', 11)); await x.idle();
  assert.equal(x.prompts.length, 1);
  assert.ok(x.typing.every(p => p.stopped));
});
test('concurrency cap prevents creating another topic', async t => {
  const x = setup(t, { slow: true, maxActive: 1 });
  await x.gateway.handle(x.message('slow')); await new Promise(r => setImmediate(r));
  await x.gateway.handle(x.message('another'));
  assert.equal(Object.keys(x.state.data.sessions).length, 1);
  assert.match(x.sent.at(-1)[2], /concurrency/);
  await x.gateway.close();
  assert.ok(x.typing.every(p => p.stopped));
});
test('topic creation failure never falls back to another topic', async t => {
  const x = setup(t); x.telegram.topic = async () => { throw new Error('no topics'); };
  await assert.rejects(x.gateway.handle(x.message('hello')));
  assert.equal(x.prompts.length, 0);
  assert.ok(x.typing.every(p => p.stopped));
});
test('bindings and offset survive restart with private permissions', async t => {
  const x = setup(t); await x.gateway.handle(x.message('hello')); await x.idle();
  x.state.data.offset = 123; x.state.save();
  const restored = new State(x.dir);
  assert.equal(restored.current(42, 11).id, 's1'); assert.equal(restored.data.offset, 123);
  assert.equal(statSync(restored.file).mode & 0o777, 0o600);
});
test('recovery warns without rerunning interrupted tools', async t => {
  const x = setup(t); x.state.data.jobs.s1 = { chat: 42, thread: 11, status: 'running' };
  await x.gateway.recover();
  assert.equal(x.state.data.jobs.s1.status, 'interrupted'); assert.equal(x.prompts.length, 0);
  assert.match(x.sent[0][2], /not replay/);
});
test('split text respects UTF16 limits without splitting emoji', () => {
  const text = '🙂中文'.repeat(2000), chunks = splitText(text);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(c => c.length <= 3500));
  assert.ok(chunks.every(c => !/[\uD800-\uDBFF]$/.test(c)));
});
test('network errors never expose token', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('https://api.telegram.org/botSECRET/getMe'); };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(new Telegram('SECRET').call('getMe'), e => !e.message.includes('SECRET'));
});
test('SDK-created empty session can be opened with the same ID', async t => {
  const x = setup(t), backend = new PiBackend(x.dir, x.dir);
  const info = await backend.create('Empty session');
  const { SessionManager } = await backend.sdk();
  const manager = SessionManager.open(info.file);
  assert.equal(manager.getSessionId(), info.id);
  assert.equal(manager.getSessionName(), 'Empty session');
});
test('delivery failure is recorded without re-prompting', async t => {
  const x = setup(t); x.telegram.send = async () => { throw new Error('offline'); };
  await x.gateway.handle(x.message('hello')); await x.idle();
  assert.equal(x.state.data.jobs.s1.status, 'delivery-uncertain');
  assert.equal(x.prompts.length, 1);
  assert.ok(x.typing.every(p => p.stopped));
});
