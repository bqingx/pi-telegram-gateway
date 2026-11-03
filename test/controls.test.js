import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Gateway } from '../src/gateway.js';
import { Telegram } from '../src/telegram.js';

async function setup(t, models = Array.from({ length: 12 }, (_, i) => ({ provider: 'test', id: `model-${String(i).padStart(2, '0')}`, cost: { input: 1, output: 2 } }))) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-controls-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new State(dir), panels = [], answers = [], sends = [], changes = [];
  let mid = 100, config = { model: { provider: 'test', id: 'model-00' }, thinking: 'low', levels: ['off', 'low', 'high'] };
  const telegram = {
    send: async (...args) => sends.push(args),
    panel: async (chat, thread, text, keyboard) => { const p = { chat, thread, text, keyboard, id: ++mid }; panels.push(p); return { message_id: p.id }; },
    editPanel: async (chat, id, text, keyboard = []) => { panels.push({ chat, id, text, keyboard, thread: 11 }); },
    answer: async (id, text) => answers.push([id, text]),
  };
  const backend = {
    create: async () => ({ id: 's2', file: '/fake2' }),
    open: async () => ({
      config: () => structuredClone(config), models: async () => models,
      setModel: async (provider, id) => { changes.push(['model', provider, id]); config.model = { provider, id }; },
      setThinking: async level => { changes.push(['thinking', level]); config.thinking = level; },
      dispose() {},
    }),
  };
  const gateway = new Gateway({ state, telegram, backend, allowedUsers: [42, 43] });
  state.data.sessions.s1 = { id: 's1', file: '/fake', user: 42, chat: 42, title: 'test' };
  state.bind(42, 11, 's1', 42);
  const command = text => gateway.handle({ message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, message_thread_id: 11, text } });
  const click = async (text, overrides = {}) => {
    const p = panels.at(-1), b = p.keyboard.flat().find(b => b.text.includes(text));
    assert.ok(b, `Button not found: ${text}`);
    const query = { id: 'query', from: { id: 42 }, message: { message_id: p.id, chat: { id: 42, type: 'private' }, message_thread_id: 11 }, data: b.callback_data, ...overrides };
    await gateway.handle({ callback_query: query });
    return query;
  };
  await command('/menu');
  return { state, gateway, panels, answers, sends, changes, command, click, setConfig: c => { config = c; } };
}

test('menu -> providers -> paginated models -> confirmation -> apply', async t => {
  const x = await setup(t);
  assert.match(x.panels[0].text, /test\/model-00/);
  await x.click('Model'); await x.click('test');
  assert.match(x.panels.at(-1).text, /1\/2/);
  await x.click('下一页');
  assert.match(x.panels.at(-1).text, /2\/2/);
  await x.click('model-10');
  assert.equal(x.changes.length, 0); assert.match(x.panels.at(-1).text, /billing may change/);
  const query = await x.click('Confirm');
  assert.deepEqual(x.changes, [['model', 'test', 'model-10']]);
  assert.equal(x.panels.at(-1).keyboard.length, 0);
  await x.gateway.handle({ callback_query: query });
  assert.equal(x.changes.length, 1);
});
test('thinking buttons only contain SDK-supported levels, marked current', async t => {
  const x = await setup(t); await x.click('Thinking');
  assert.deepEqual(x.panels.at(-1).keyboard.slice(0, 3).flat().map(b => b.text), ['off', '✓ low', 'high']);
  await x.click('high'); assert.deepEqual(x.changes, [['thinking', 'high']]);
});
test('model aliases and reasoning command open pickers directly', async t => {
  const x = await setup(t);
  for (const command of ['/model', '/models']) { await x.command(command); assert.match(x.panels.at(-1).text, /Choose provider/); }
  for (const command of ['/thinking', '/reasoning']) { await x.command(command); assert.match(x.panels.at(-1).text, /Choose reasoning/); }
});
test('stale button from a previous page or replaced menu cannot act', async t => {
  const x = await setup(t);
  const old = x.panels[0].keyboard[0][1].callback_data;
  await x.click('Model');
  await x.gateway.handle({ callback_query: { id: 'old', from: { id: 42 }, message: { message_id: 101, chat: { id: 42, type: 'private' }, message_thread_id: 11 }, data: old } });
  assert.match(x.answers.at(-1)[1], /失效/); assert.equal(x.changes.length, 0);
});
test('unauthorized users and other allowlisted users cannot use owner menu', async t => {
  const x = await setup(t);
  for (const id of [99, 43]) {
    await x.click('Thinking', { from: { id } });
    assert.equal(x.changes.length, 0); assert.equal(x.panels.length, 1);
  }
});
test('wrong chat, message ID and topic callbacks are rejected', async t => {
  const x = await setup(t);
  for (const patch of [{ message_id: 999 }, { message_thread_id: 12 }, { chat: { id: 99, type: 'private' } }, { chat: { id: 42, type: 'supergroup' } }]) {
    await x.click('Thinking', { message: { message_id: 101, chat: { id: 42, type: 'private' }, message_thread_id: 11, ...patch } });
    assert.equal(x.panels.length, 1);
  }
});
test('callback without thread metadata uses authenticated message binding', async t => {
  const x = await setup(t);
  await x.click('Thinking', { message: { message_id: 101, chat: { id: 42, type: 'private' } } });
  assert.match(x.panels.at(-1).text, /Choose reasoning/);
});
test('busy topic rejects callback and settings command', async t => {
  const x = await setup(t); x.gateway.active.set('s1', {});
  await x.click('Thinking'); assert.match(x.answers.at(-1)[1], /busy/);
  await x.command('/model'); assert.match(x.sends.at(-1)[2], /busy/);
  assert.equal(x.panels.length, 1);
});
test('new session invalidates old menu', async t => {
  const x = await setup(t);
  await x.command('/new'); await x.click('Thinking');
  assert.match(x.answers.at(-1)[1], /失效/); assert.equal(x.changes.length, 0);
});
test('expired/restarted menus do not apply settings', async t => {
  const x = await setup(t);
  for (const menu of x.gateway.controls.menus.values()) menu.expires = 0;
  await x.click('Thinking'); assert.match(x.answers.at(-1)[1], /失效/);
  x.gateway.controls.menus.clear(); await x.click('Thinking'); assert.equal(x.changes.length, 0);
});
test('external configuration change makes menu stale', async t => {
  const x = await setup(t);
  x.setConfig({ model: { provider: 'test', id: 'different' }, thinking: 'low', levels: ['off'] });
  await x.click('Thinking'); assert.match(x.panels.at(-1).text, /已变化/);
  assert.equal(x.changes.length, 0);
});
test('long Unicode model IDs remain server-side; callback_data <= 64 bytes', async t => {
  const x = await setup(t, [{ provider: 'p', id: '模型'.repeat(100) }]);
  await x.click('Model'); await x.click('p');
  for (const panel of x.panels) for (const b of panel.keyboard.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});
test('no available models and nonreasoning model provide explicit guidance', async t => {
  const x = await setup(t, []); await x.click('Model');
  assert.match(x.panels.at(-1).text, /No available models/);
  await x.command('/menu');
  x.setConfig({ model: { provider: 'test', id: 'model-00' }, thinking: 'off', levels: ['off'] });
  await x.command('/thinking');
  assert.match(x.panels.at(-1).text, /no adjustable/);
});
test('selection failure consumes menu and does not leak exception', async t => {
  const x = await setup(t); await x.click('Thinking');
  x.gateway.backend.open = async () => { throw new Error('SECRET'); };
  await x.click('high');
  assert.equal(x.changes.length, 0); assert.doesNotMatch(x.panels.at(-1).text, /SECRET/);
  assert.equal(x.gateway.controls.menus.size, 0);
});
test('register bot command menu and Telegram inline-keyboard payloads', async t => {
  const calls = [], api = new Telegram('test');
  api.call = async (method, params) => { calls.push([method, params]); return { message_id: 1 }; };
  await api.registerCommands();
  assert.ok(calls[0][1].commands.some(c => c.command === 'menu'));
  assert.ok(calls[0][1].commands.some(c => c.command === 'model'));
  await api.panel(42, 11, 'title', [[{ text: 'test', callback_data: 'pc:test' }]]);
  assert.equal(calls.at(-1)[1].message_thread_id, 11);
  await api.editPanel(42, 1, 'done'); assert.deepEqual(calls.at(-1)[1].reply_markup.inline_keyboard, []);
  await api.answer('q', 'ok'); assert.equal(calls.at(-1)[0], 'answerCallbackQuery');
});
