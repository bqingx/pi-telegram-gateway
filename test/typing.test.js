import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from '../src/telegram.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const api = new Telegram('dummy'), calls = [];
  api.call = async (method, params, signal) => { calls.push({ method, params, signal }); return true; };
  return { api, calls };
}

test('typing is immediate, thread-scoped and refreshed every four seconds', async t => {
  const { api, calls } = setup(t);
  const stop = api.startTyping(42, 11);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, { chat_id: 42, action: 'typing', message_thread_id: 11 });
  await flush(); t.mock.timers.tick(3999); assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls.length, 2);
  stop(); stop(); t.mock.timers.tick(20000); await flush(); assert.equal(calls.length, 2);
});
test('root typing omits thread ID; concurrent lanes stop independently', async t => {
  const { api, calls } = setup(t);
  const root = api.startTyping(42), topic = api.startTyping(42, 11);
  assert.equal(calls[0].params.message_thread_id, undefined);
  await flush(); root(); t.mock.timers.tick(4000); await flush();
  assert.equal(calls.length, 3); assert.equal(calls[2].params.message_thread_id, 11);
  topic();
});
test('slow typing requests never overlap and stopping aborts the pending request', async t => {
  const { api } = setup(t); let calls = 0, signal;
  api.call = async (_method, _params, s) => {
    calls++; signal = s;
    await new Promise((resolve, reject) => s.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  const stop = api.startTyping(42, 11);
  t.mock.timers.tick(20000); await flush(); assert.equal(calls, 1);
  stop(); await flush(); assert.equal(signal.aborted, true);
  t.mock.timers.tick(30000); await flush(); assert.equal(calls, 1);
  assert.equal(api.typingCooldown.size, 0);
});
test('typing network failures are swallowed and backed off, not fast-retried', async t => {
  const { api } = setup(t); let calls = 0;
  api.call = async () => { calls++; throw new Error('offline'); };
  const stop = api.startTyping(42, 11);
  await flush(); t.mock.timers.tick(29999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  stop();
});
test('429 retry_after is honored across topics in the same chat', async t => {
  const { api } = setup(t); let calls = 0;
  api.call = async () => { calls++; throw Object.assign(new Error('limited'), { code: 429, retryAfter: 60 }); };
  const first = api.startTyping(42, 11); await flush();
  const second = api.startTyping(42, 12); await flush();
  t.mock.timers.tick(59999); await flush(); assert.equal(calls, 1);
  first(); t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  second();
});
test('DM topic 400 rejection falls back to main DM typing; 429 does not', async t => {
  const { api, calls } = setup(t);
  api.call = async (method, params) => {
    calls.push({ method, params });
    if (params.message_thread_id) throw Object.assign(new Error('bad thread'), { code: 400 });
    return true;
  };
  const stop = api.startTyping(42, 11); await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, { chat_id: 42, action: 'typing' });
  stop();
});
test('API errors expose only safe numeric retry metadata', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 429, json: async () => ({ ok: false, error_code: 429, description: 'SECRET', parameters: { retry_after: 60 } }) });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(new Telegram('dummy').call('sendChatAction'), error => error.code === 429 && error.retryAfter === 60 && !error.message.includes('SECRET'));
});
