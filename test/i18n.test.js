import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messages, translate, levelLabel, usageLabel } from '../src/i18n.js';
import { State } from '../src/state.js';
import { Gateway } from '../src/gateway.js';
import { Telegram } from '../src/telegram.js';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-language-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(dir), panels = [], edits = [], sent = [], answers = [], registrations = [];
  let id = 0;
  const telegram = {
    send: async (...args) => sent.push(args),
    panel: async (chat, thread, text, keyboard) => { const message = { chat, thread, text, keyboard, message_id: ++id }; panels.push(message); return message; },
    editPanel: async (...args) => edits.push(args), answer: async (...args) => answers.push(args),
    registerCommands: async (...args) => registrations.push(args),
  };
  let opens = 0, reply = '';
  const backend = { open: async () => { opens++; return {
    config: () => ({ model: { provider: 'provider-id', id: 'model-id' }, thinking: 'high', levels: ['off', 'low', 'high'] }),
    prompt: async () => reply, dispose() {},
  }; } };
  const g = new Gateway({ state, telegram, backend, allowedUsers: [42, 43] });
  const command = (text, thread, user = 42) => g.handle({ message: { chat: { id: user, type: 'private' }, from: { id: user, language_code: 'en' }, message_thread_id: thread, text } });
  const click = async (choice, override = {}) => {
    const panel = panels.at(-1), button = panel.keyboard.flat().find(b => b.callback_data.endsWith(`:${choice}`));
    assert.ok(button);
    const query = { id: 'q', from: { id: 42 }, message: { chat: { id: panel.chat, type: 'private' }, message_id: panel.message_id, message_thread_id: panel.thread }, data: button.callback_data, ...override };
    await g.handle({ callback_query: query }); return query;
  };
  const bind = () => { state.data.sessions.s1 = { id: 's1', user: 42, chat: 42, title: '用户会话', createdAt: '2026-01-01' }; state.bind(42, 11, 's1', 42); };
  return { dir, state, g, telegram, panels, edits, sent, answers, registrations, command, click, bind, opens: () => opens, setReply: value => { reply = value; } };
}

test('Chinese/English catalogs have matching keys and interpolation parameters', () => {
  assert.deepEqual(Object.keys(messages.zh).sort(), Object.keys(messages.en).sort());
  const params = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const key of Object.keys(messages.zh)) assert.deepEqual(params(messages.zh[key]), params(messages.en[key]), key);
  assert.equal(translate('unknown', 'model'), '模型');
  assert.equal(levelLabel('zh', 'high'), '高'); assert.equal(usageLabel('zh', 'unmanaged'), '待纳管');
  assert.throws(() => translate('zh', 'missing'));
});
test('Chinese is the default regardless of Telegram client language; root language menu needs no session', async t => {
  const x = setup(t); await x.command('/language');
  assert.match(x.panels[0].text, /界面语言：中文/);
  assert.equal(x.panels[0].keyboard[0][0].text, '✓ 中文');
  assert.equal(x.opens(), 0); assert.equal(Object.keys(x.state.data.sessions).length, 0);
  for (const b of x.panels[0].keyboard.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});
test('button switching persists user language across topics and restart, not other users', async t => {
  const x = setup(t); await x.command('/language'); await x.click('en');
  assert.equal(x.g.language(42), 'en'); assert.equal(x.g.language(43), 'zh');
  assert.deepEqual(x.registrations, [['en', 42]]);
  assert.match(x.edits.at(-1)[2], /changed to English/);
  await x.command('/unknown', 11); assert.match(x.sent.at(-1)[2], /Unknown command/);
  const restored = new State(x.dir); assert.equal(restored.language(42), 'en'); assert.equal(restored.language(43), 'zh');
  await x.command('/language', 12); await x.click('zh');
  assert.match(x.edits.at(-1)[2], /已切换为中文/);
  assert.equal(x.state.language(42), 'zh'); assert.equal(x.opens(), 0);
});
test('settings home has a language button; language-only selection does not change model settings', async t => {
  const x = setup(t); x.bind(); await x.command('/menu', 11);
  const panel = x.panels.at(-1);
  assert.match(panel.text, /模型：provider-id\/model-id\n推理强度：高/);
  assert.equal(panel.keyboard[0][0].text, '模型'); assert.equal(panel.keyboard[0][1].text, '推理强度');
  const button = panel.keyboard.flat().find(b => b.text === '语言');
  await x.g.handle({ callback_query: { id: 'settings', from: { id: 42 }, message: { chat: { id: 42, type: 'private' }, message_id: panel.message_id, message_thread_id: 11 }, data: button.callback_data } });
  await x.click('en'); assert.equal(x.opens(), 1);
});
test('language switching works in unbound topics and while sessions are busy', async t => {
  const x = setup(t); x.bind(); x.g.active.set('s1', {});
  await x.command('/lang', 11); await x.click('en');
  assert.equal(x.g.language(42), 'en'); assert.equal(x.opens(), 0);
  await x.command('/menu', 12); assert.match(x.panels.at(-1).text, /Interface language/);
});
test('stale, replayed, expired and wrong-user language buttons cannot mutate preferences', async t => {
  const x = setup(t); await x.command('/language', 11);
  for (const patch of [{ from: { id: 43 } }, { from: { id: 99 } }, { message: { chat: { id: 42, type: 'private' }, message_id: 999, message_thread_id: 11 } },
    { message: { chat: { id: 42, type: 'private' }, message_id: 1, message_thread_id: 12 } }]) {
    await x.click('en', patch); assert.equal(x.g.language(42), 'zh');
  }
  const old = await x.click('en'); assert.equal(x.g.language(42), 'en');
  await x.g.handle({ callback_query: old }); assert.equal(x.registrations.length, 1);
  await x.command('/language'); for (const m of x.g.languages.menus.values()) m.expires = 0;
  await x.click('zh'); assert.equal(x.g.language(42), 'en'); assert.match(x.answers.at(-1)[1], /expired/);
});
test('callback without thread metadata is authenticated by its message/user/chat', async t => {
  const x = setup(t); await x.command('/language', 11);
  await x.click('en', { message: { chat: { id: 42, type: 'private' }, message_id: 1 } });
  assert.equal(x.g.language(42), 'en');
});
test('Telegram command-menu failure preserves saved preference and returns localized warning', async t => {
  const x = setup(t); await x.command('/language');
  x.telegram.registerCommands = async () => { throw new Error('SECRET'); };
  await x.click('en'); assert.equal(new State(x.dir).language(42), 'en');
  assert.match(x.edits.at(-1)[2], /preference saved/); assert.doesNotMatch(x.edits.at(-1)[2], /SECRET/);
});
test('language changes invalidate old model selectors across topics', async t => {
  const x = setup(t); x.bind(); await x.command('/menu', 11);
  assert.equal(x.g.controls.menus.size, 1);
  await x.command('/language', 12); await x.click('en');
  assert.equal(x.g.controls.menus.size, 0);
});
test('Chinese commands, status, usage and errors are localized; assistant text is untouched', async t => {
  const x = setup(t); x.bind();
  await x.command('/status', 11); assert.match(x.sent.at(-1)[2], /空闲（可用）/);
  await x.command('/sessions'); assert.match(x.sent.at(-1)[2], /会话列表/); assert.match(x.sent.at(-1)[2], /已绑定话题/);
  await x.command('/unknown', 11); assert.match(x.sent.at(-1)[2], /未知命令/);
  await x.command('/thinking', 11);
  assert.deepEqual(x.panels.at(-1).keyboard.slice(0, 3).flat().map(b => b.text), ['关闭', '低', '✓ 高']);
  x.setReply('Original English model output');
  await x.command('question', 11); await Promise.all([...x.g.active.values()].map(j => j.promise));
  assert.equal(x.sent.at(-1)[2], 'Original English model output');
  x.setReply(''); await x.command('question', 11); await Promise.all([...x.g.active.values()].map(j => j.promise));
  assert.equal(x.sent.at(-1)[2], '（本次没有文字回复）');
});
test('Chinese help, run errors and recovery warnings do not fall back to English', async t => {
  const x = setup(t); await x.command('/help'); assert.match(x.sent[0][2], /切换界面语言/);
  x.bind(); x.g.backend.open = async () => { throw new Error('SECRET'); };
  await x.command('test', 11); await Promise.all([...x.g.active.values()].map(j => j.promise));
  assert.match(x.sent.at(-1)[2], /任务失败/); assert.doesNotMatch(x.sent.at(-1)[2], /SECRET/);
  x.state.data.jobs.s1 = { chat: 42, thread: 11, status: 'running' };
  await x.g.recover(); assert.match(x.sent.at(-1)[2], /不会自动重放/);
});
test('command descriptions default to Chinese and language switching uses chat-scoped overrides', async () => {
  const api = new Telegram('dummy'), calls = [];
  api.call = async (method, params) => calls.push([method, params]);
  await api.registerCommands(); assert.ok(calls[0][1].commands.every(c => /[\u4e00-\u9fff]/.test(c.description)));
  assert.ok(calls[0][1].commands.some(c => c.command === 'language'));
  await api.registerCommands('en', 42);
  assert.deepEqual(calls[2][1].scope, { type: 'chat', chat_id: 42 });
  assert.ok(calls[2][1].commands.every(c => !/[\u4e00-\u9fff]/.test(c.description)));
  assert.equal(calls[3][1].chat_id, 42);
});
