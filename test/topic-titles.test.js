import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Gateway } from '../src/gateway.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-topic-title-test-'));
  const state = new State(dir), sent = [], renamed = [], names = new Map(), prompts = [], generated = [];
  let count = 0, busy = false;
  const topics = [];
  const telegram = { topic: async (_chat, name) => { topics.push(name); return 11; }, send: async (...args) => sent.push(args), rename: async (...args) => renamed.push(args) };
  const backend = {
    create: async title => { const id = `s${++count}`; names.set(id, title); return { id, file: `/fake/${id}` }; },
    usage: () => busy ? 'local' : 'available',
    setSessionTitle: async (record, title) => { if (busy) throw Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }); names.set(record.id, title); },
    open: async record => ({
      generateTitle: async text => { generated.push(text); return '消息网关开发'; },
      setTitle: title => names.set(record.id, title), prompt: async text => { prompts.push(text); return '回复'; },
      last: () => '', abort: async () => {}, dispose() {},
    }),
  };
  const g = new Gateway({ state, telegram, backend, allowedUsers: [42] });
  t.after(() => { g.topicTitles.stop(); rmSync(dir, { recursive: true, force: true }); });
  const message = (text, thread) => ({ message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text, message_thread_id: thread } });
  const edited = (name, extra = {}) => ({ message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, message_thread_id: 11, forum_topic_edited: { name }, ...extra } });
  const idle = async () => { await Promise.all([...g.active.values()].map(job => job.promise)); };
  const seed = () => { state.data.sessions.s0 = { id: 's0', file: '/fake/s0', user: 42, chat: 42, title: '原始名称', createdAt: '2026-01-01' }; state.bind(42, 11, 's0', 42); names.set('s0', '原始名称'); };
  return { dir, state, g, telegram, backend, sent, renamed, names, prompts, generated, topics, message, edited, idle, seed, setBusy: value => { busy = value; } };
}

test('new root topic and new session converge on one generated short title', async t => {
  const x = setup(t); await x.g.handle(x.message('帮我开发一个Telegram消息网关')); await x.idle();
  const record = x.state.current(42, 11);
  assert.equal(record.title, '消息网关开发'); assert.equal(x.names.get(record.id), record.title);
  // The topic is created with the final title: Telegram clients ignore later
  // editForumTopic renames in private topics (tdlib/telegram-bot-api#915).
  assert.deepEqual(x.topics, ['消息网关开发']);
  assert.deepEqual(x.renamed, []);
  assert.deepEqual(x.prompts, ['帮我开发一个Telegram消息网关']);
  await x.g.handle(x.message('继续', 11)); await x.idle(); assert.equal(x.generated.length, 1);
});
test('/new defers generation until its first real prompt', async t => {
  const x = setup(t); x.seed();
  await x.g.handle(x.message('/new', 11)); assert.equal(x.generated.length, 0);
  await x.g.handle(x.message('测试语言菜单', 11)); await x.idle();
  assert.equal(x.generated.length, 1); assert.equal(x.state.current(42, 11).title, '消息网关开发');
});
test('manual topic edit synchronizes the bound session and explicitly confirms, without model calls', async t => {
  const x = setup(t); x.seed(); const manual = '这是用户自己设置的很长的话题标题，不应该被自动标题长度限制截断';
  await x.g.handle(x.edited(manual));
  assert.equal(x.names.get('s0'), manual); assert.equal(x.state.current(42, 11).title, manual);
  assert.match(x.sent.at(-1)[2], /^会话名称已同步为：这是用户自己设置的很长的话题标题/);
  assert.equal(x.prompts.length, 0); assert.equal(x.generated.length, 0); assert.equal(x.renamed.length, 0);
});
test('bot echo, icon-only edits, unbound topics and unauthorized edits do not loop or touch sessions', async t => {
  const x = setup(t); x.seed();
  await x.g.handle(x.edited('bot', { from: { id: 42, is_bot: true } }));
  await x.g.handle(x.edited(undefined));
  await x.g.handle(x.edited('foreign', { from: { id: 99 } }));
  await x.g.handle(x.edited('unbound', { message_thread_id: 99 }));
  assert.equal(x.names.get('s0'), '原始名称'); assert.equal(x.sent.length, 0);
});
test('edited bot-authored private topic header renames its bound session without admitting bot prompts', async t => {
  const x = setup(t); x.seed(); x.state.data.botId = 1234;
  await x.g.handle({ edited_message: { from: { id: 1234, is_bot: true }, chat: { id: 42, type: 'private' }, message_thread_id: 11, message_id: 11, forum_topic_created: { name: '私聊标题编辑' } } });
  assert.equal(x.names.get('s0'), '私聊标题编辑'); assert.match(x.sent.at(-1)[2], /会话名称已同步/);
  await x.g.handle({ edited_message: { from: { id: 1234, is_bot: true }, chat: { id: 42, type: 'private' }, text: 'do not run this' } });
  assert.equal(x.prompts.length, 0);
});
test('edited topic service messages use known creation message IDs only when thread ID is absent', async t => {
  const x = setup(t); x.seed(); x.state.data.botId = 1234;
  const header = name => ({ edited_message: { from: { id: 1234, is_bot: true }, chat: { id: 42, type: 'private' }, message_id: 11, forum_topic_edited: { name } } });
  await x.g.handle(header('无显式话题ID')); assert.equal(x.names.get('s0'), '无显式话题ID');
  const forwarded = header('转发不能改名'); forwarded.edited_message.forward_origin = { type: 'user' };
  await x.g.handle(forwarded); assert.equal(x.names.get('s0'), '无显式话题ID');
  const foreign = header('其他机器人'); foreign.edited_message.from.id = 999;
  await x.g.handle(foreign); assert.equal(x.names.get('s0'), '无显式话题ID');
});
test('occupied local session queues the newest title and auto-syncs when released', async t => {
  const x = setup(t); x.seed(); x.setBusy(true);
  await x.g.handle(x.edited('第一个名称')); await x.g.handle(x.edited('最终名称'));
  assert.equal(x.names.get('s0'), '原始名称'); assert.match(x.sent.at(-1)[2], /已记录待同步标题/);
  const restored = new State(x.dir); assert.equal(restored.data.sessions.s0.pendingTopicTitle.name, '最终名称');
  await x.g.topicTitles.flushAll(); assert.equal(x.names.get('s0'), '原始名称');
  x.setBusy(false); await x.g.topicTitles.flushAll();
  assert.equal(x.names.get('s0'), '最终名称'); assert.equal(x.state.data.sessions.s0.pendingTopicTitle, undefined);
  assert.match(x.sent.at(-1)[2], /^会话名称已同步为：最终名称\n/);
});
test('active SDK is reused for renaming instead of re-entering its exclusive lock', async t => {
  const x = setup(t); x.seed(); x.setBusy(true);
  x.g.active.set('s0', { agent: { setTitle: title => x.names.set('s0', title) } });
  await x.g.handle(x.edited('运行中的新名称'));
  assert.equal(x.names.get('s0'), '运行中的新名称'); assert.match(x.sent.at(-1)[2], /已同步/);
});
test('manual edit while title generation is pending wins over the late automatic result', async t => {
  const x = setup(t); x.seed(); let release;
  const original = x.backend.open;
  x.backend.open = async record => ({ ...await original(record), generateTitle: async () => new Promise(resolve => { release = resolve; }) });
  await x.g.handle(x.message('/new', 11));
  await x.g.handle(x.message('自动命名测试', 11)); await tick();
  await x.g.handle(x.edited('我的手动名称')); release('过时的自动标题'); await x.idle();
  assert.equal(x.state.current(42, 11).title, '我的手动名称'); assert.equal(x.names.get('s1'), '我的手动名称');
  assert.equal(x.renamed.length, 0);
});
test('manual edit during an in-topic automatic rename restores the manual topic name', async t => {
  const x = setup(t); x.seed(); let release;
  x.telegram.rename = async (...args) => { x.renamed.push(args); if (x.renamed.length === 1) await new Promise(resolve => { release = resolve; }); };
  await x.g.handle(x.message('/new', 11));
  await x.g.handle(x.message('消息网关开发', 11)); await tick();
  await x.g.handle(x.edited('用户选定名称')); release(); await x.idle();
  assert.equal(x.renamed.at(-1)[2], '用户选定名称'); assert.equal(x.names.get('s1'), '用户选定名称');
});
test('read-only shared discovery preserves live record references and manual rename priority', async t => {
  const x = setup(t); x.g.sharedSessionOwner = 42; x.seed();
  let release; const original = x.backend.open;
  x.backend.open = async record => ({ ...await original(record), generateTitle: async () => new Promise(resolve => { release = resolve; }) });
  await x.g.handle(x.message('/new', 11));
  await x.g.handle(x.message('自动标题', 11)); await tick();
  const record = x.state.current(42, 11);
  x.backend.listShared = async () => [{ id: record.id, file: record.file, title: record.title, createdAt: record.createdAt, modifiedAt: record.createdAt }];
  await x.g.syncShared(42, 42); assert.equal(x.state.current(42, 11), record);
  await x.g.handle(x.edited('用户新标题')); release('不要覆盖'); await x.idle();
  assert.equal(record.title, '用户新标题');
});
test('rename failures do not execute the prompt twice or repeatedly regenerate titles', async t => {
  const x = setup(t); x.seed(); x.telegram.rename = async () => { throw new Error('SECRET'); };
  await x.g.handle(x.message('/new', 11));
  await x.g.handle(x.message('title', 11)); await x.idle();
  assert.ok(x.sent.some(args => args[2].includes('自动标题未能完整同步')));
  assert.equal(x.prompts.length, 1); assert.equal(x.state.current(42, 11).pendingTitle, false);
  await x.g.handle(x.message('继续', 11)); await x.idle(); assert.equal(x.generated.length, 1);
  assert.ok(x.sent.every(args => !args[2].includes('SECRET')));
});
test('background reconciliation automatically notices a released local lock', async t => {
  const x = setup(t); x.seed(); x.setBusy(true);
  t.mock.timers.enable({ apis: ['setInterval'] });
  await x.g.handle(x.edited('等待释放后同步'));
  x.g.start(); await tick(); assert.equal(x.names.get('s0'), '原始名称');
  x.setBusy(false); t.mock.timers.tick(2000); await tick();
  assert.equal(x.names.get('s0'), '等待释放后同步');
  x.g.topicTitles.stop();
});
test('pending sync is discarded if its session is no longer bound to that topic', async t => {
  const x = setup(t); x.seed(); x.setBusy(true); await x.g.handle(x.edited('旧话题标题'));
  delete x.state.data.bindings[x.state.key(42, 11)]; x.setBusy(false); await x.g.topicTitles.flushAll();
  assert.equal(x.names.get('s0'), '原始名称'); assert.equal(x.state.data.sessions.s0.pendingTopicTitle, undefined);
});
