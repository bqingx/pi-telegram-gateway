import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Gateway } from '../src/gateway.js';
import { Telegram } from '../src/telegram.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-explicit-rename-test-'));
  const state = new State(dir), sent = [], prompts = [], names = [], renamed = [], replies = [];
  let busy = false, modelCalls = 0;
  state.data.botId = 7;
  state.data.sessions.s1 = { id: 's1', user: 42, chat: 42, title: '旧名称', file: '/fake', createdAt: '2026-01-01' };
  state.bind(42, 11, 's1', 42);
  const telegram = {
    send: async (...args) => sent.push(args), rename: async (...args) => renamed.push(args),
    requestReply: async (chat, thread, text) => { const r = { message_id: 100 + replies.length, from: { id: 7, is_bot: true }, text }; replies.push(r); return r; },
  };
  const backend = {
    usage: () => busy ? 'local' : 'available',
    setSessionTitle: async (_record, title, beforeWrite) => {
      if (busy) throw Object.assign(new Error('occupied'), { code: 'SESSION_BUSY' });
      await beforeWrite?.(); names.push(title);
    },
    open: async () => { modelCalls++; return { prompt: async text => { prompts.push(text); return '回复'; }, setTitle: title => names.push(title), dispose() {} }; },
  };
  const g = new Gateway({ state, telegram, backend, allowedUsers: [42, 43] });
  t.after(() => { g.topicTitles.stop(); rmSync(dir, { recursive: true, force: true }); });
  const message = (text, extra = {}) => ({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, message_thread_id: 11, text, ...extra } });
  const command = text => g.handle(message(text));
  const reply = (text, extra = {}) => g.handle(message(text, { reply_to_message: replies.at(-1), ...extra }));
  return { state, g, telegram, backend, sent, prompts, names, renamed, replies, message, command, reply, modelCalls: () => modelCalls, setBusy: value => { busy = value; } };
}

test('rename dialog uses explicit replies and changes topic + session without a model call', async t => {
  const x = setup(t); await x.command('/name'); assert.match(x.replies[0].text, /不调用模型/);
  await x.reply('我的新标题');
  assert.deepEqual(x.renamed, [[42, 11, '我的新标题']]); assert.deepEqual(x.names, ['我的新标题']);
  assert.equal(x.state.current(42, 11).title, '我的新标题');
  assert.equal(x.sent.at(-1)[2], '会话名称已同步为：我的新标题');
  assert.equal(x.modelCalls(), 0);
});
test('direct /name works even if the requested title is already stored', async t => {
  const x = setup(t); await x.command('/name 旧名称');
  assert.equal(x.renamed.length, 1); assert.equal(x.names.length, 1); assert.equal(x.modelCalls(), 0);
  assert.equal(x.replies.length, 0);
});
test('/name remains a direct command even when replying to an old rename dialog', async t => {
  const x = setup(t); await x.command('/name');
  await x.reply('/name 只用这个名称');
  assert.equal(x.names.at(-1), '只用这个名称'); assert.equal(x.renamed.at(-1)[2], '只用这个名称');
  assert.equal(x.modelCalls(), 0);
});
test('/rename is no longer a command and never invokes the model', async t => {
  const x = setup(t); await x.command('/rename 新名称');
  assert.equal(x.renamed.length, 0); assert.equal(x.modelCalls(), 0);
  assert.match(x.sent.at(-1)[2], /未知命令/);
});
test('explicit rename requests are confirmed even when matching an in-flight bot target', async t => {
  const x = setup(t); x.g.topicTitles.namingTargets.set('s1', '同一目标');
  await x.command('/name 同一目标');
  assert.equal(x.names.at(-1), '同一目标'); assert.match(x.sent.at(-1)[2], /已同步为/);
});
test('invalid names and cancelled dialogs never invoke the model or change titles', async t => {
  const x = setup(t); await x.command('/name'); await x.reply('/cancel');
  assert.match(x.sent.at(-1)[2], /已取消/);
  await x.command('/name ' + '名'.repeat(129)); assert.match(x.sent.at(-1)[2], /1–128/);
  assert.equal(x.renamed.length, 0); assert.equal(x.modelCalls(), 0);
});
test('stale or restarted reply prompts are rejected instead of becoming Agent instructions', async t => {
  const x = setup(t); await x.command('/name'); x.g.renames.requests.clear();
  await x.reply('不能执行的旧回复'); assert.match(x.sent.at(-1)[2], /已过期/); assert.equal(x.modelCalls(), 0);
  await x.command('/name'); x.state.data.bindings['42:11'] = 'other';
  await x.reply('旧会话名称'); assert.match(x.sent.at(-1)[2], /已过期/); assert.equal(x.renamed.length, 0);
});
test('wrong users cannot use another user rename dialog', async t => {
  const x = setup(t); await x.command('/name');
  await x.reply('不允许', { from: { id: 99 } });
  assert.equal(x.renamed.length, 0); assert.equal(x.modelCalls(), 0);
});
test('local occupation defers both changes and synchronizes when released', async t => {
  const x = setup(t); x.setBusy(true); await x.command('/name 等待释放');
  assert.equal(x.renamed.length, 0); assert.equal(x.names.length, 0);
  assert.match(x.sent.at(-1)[2], /已记录待同步/);
  x.setBusy(false); await x.g.topicTitles.flushAll();
  assert.equal(x.renamed.at(-1)[2], '等待释放'); assert.equal(x.names.at(-1), '等待释放');
});
test('permanent Telegram rejection does not write a false session name or retry endlessly', async t => {
  const x = setup(t); x.telegram.rename = async () => { throw Object.assign(new Error('SECRET'), { code: 400 }); };
  await x.command('/name 被拒绝'); assert.equal(x.names.length, 0);
  assert.equal(x.state.current(42, 11).title, '旧名称'); assert.equal(x.state.current(42, 11).pendingTopicTitle, undefined);
  assert.match(x.sent.at(-1)[2], /Telegram 拒绝/); assert.doesNotMatch(x.sent.at(-1)[2], /SECRET/);
});
test('active SDK lease is held until an in-flight explicit rename completes', async t => {
  const x = setup(t); let finishPrompt, finishRename, disposed = false;
  x.backend.open = async () => ({ prompt: async () => new Promise(resolve => { finishPrompt = resolve; }), setTitle: title => { assert.equal(disposed, false); x.names.push(title); }, dispose: () => { disposed = true; } });
  x.telegram.rename = async () => new Promise(resolve => { finishRename = resolve; });
  await x.command('正常对话'); await tick();
  const job = x.g.active.get('s1');
  const renaming = x.command('/name 正在同步'); await tick();
  finishPrompt('回复'); await tick(); assert.equal(disposed, false);
  finishRename(); await renaming; await job.promise;
  assert.equal(disposed, true); assert.equal(x.names.at(-1), '正在同步');
});
test('finalizing SDKs are never borrowed for new rename operations', async t => {
  const x = setup(t);
  x.g.active.set('s1', { finalizing: true, agent: { setTitle() { throw new Error('must not use'); } } });
  await x.command('/name 等待结束'); assert.equal(x.renamed.length, 0);
  x.g.active.delete('s1'); await x.g.topicTitles.flushAll(); assert.equal(x.names.at(-1), '等待结束');
});
test('Telegram rename treats only TOPIC_NOT_MODIFIED as idempotent success', async t => {
  const api = new Telegram('dummy'); api.call = async () => { throw Object.assign(new Error('same'), { code: 400, notModified: true }); };
  await api.rename(42, 11, 'same');
  api.call = async () => { throw Object.assign(new Error('other failure'), { code: 400 }); };
  await assert.rejects(api.rename(42, 11, 'other'));
  const calls = []; api.call = async (method, params) => { calls.push([method, params]); return { message_id: 1 }; };
  await api.requestReply(42, 11, 'prompt', 'name'); assert.equal(calls[0][1].reply_markup.force_reply, true);
});
