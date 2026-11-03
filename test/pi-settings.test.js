import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiBackend } from '../src/pi.js';
import { SessionLease } from '../src/session-lock.js';

// Real SDK, isolated profile, dummy credentials and no model request. This
// catches SDK persistence behavior that fake Telegram tests cannot exercise.
test('real SDK model/thinking selection survives empty-session reopen without changing defaults', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-settings-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, 'profile');
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'gateway-test': { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'dummy-local-test', models: [
      { id: 'one', reasoning: false }, { id: 'two', reasoning: true },
    ] },
  } }));
  const defaults = JSON.stringify({ defaultProvider: 'gateway-test', defaultModel: 'one', defaultThinkingLevel: 'off' });
  writeFileSync(join(agentDir, 'settings.json'), defaults);
  const backend = new PiBackend(dir, dir, { agentDir, noTools: 'all' });
  const record = await backend.create('Settings before first prompt');
  let agent = await backend.open(record);
  try {
    assert.equal(agent.config().model.id, 'one');
    await assert.rejects(backend.open(record), { code: 'SESSION_BUSY' });
    assert.ok((await agent.models()).some(m => m.id === 'two' && m.provider === 'gateway-test'));
    await agent.setModel('gateway-test', 'two');
    const levels = agent.config().levels;
    assert.ok(levels.includes('high'));
    agent.setThinking('high');
    assert.equal(agent.config().thinking, 'high');
    await assert.rejects(agent.setModel('gateway-test', 'not-a-model'));
    assert.throws(() => agent.setThinking('unsupported'));
  } finally { agent.dispose(); }
  agent = await backend.open(record);
  try {
    assert.equal(agent.config().model.id, 'two');
    assert.equal(agent.config().thinking, 'high');
    await agent.setModel('gateway-test', 'one');
    assert.deepEqual(agent.config().levels, ['off']);
    assert.equal(agent.config().thinking, 'off');
  } finally { agent.dispose(); }
  assert.equal(readFileSync(join(agentDir, 'settings.json'), 'utf8'), defaults);
  const { ModelRuntime, SessionManager } = await backend.sdk();
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
  runtime.completeSimple = async () => ({ content: [{ type: 'text', text: '自动生成会话标题' }], stopReason: 'stop', provider: 'gateway-test', model: 'one',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  backend.options.modelRuntime = runtime;
  agent = await backend.open(record);
  try { const title = await agent.generateTitle('生成标题测试', 'zh'); agent.setTitle(title); }
  finally { agent.dispose(); }
  let named = SessionManager.open(record.file);
  assert.equal(named.getSessionName(), '自动生成会话标题');
  assert.equal(named.getBranch().filter(e => e.type === 'usage' && e.kind === 'title').length, 1);
  assert.equal(named.getBranch().some(e => e.type === 'message' && e.message.role === 'user'), false);
  await backend.setSessionTitle(record, '用户手动标题', async () => {
    assert.throws(() => SessionLease.acquire(record.file, 'local'), { code: 'SESSION_BUSY' });
  });
  named = SessionManager.open(record.file); assert.equal(named.getSessionName(), '用户手动标题');
  const localLease = SessionLease.acquire(record.file, 'local');
  try {
    await assert.rejects(backend.open(record), { code: 'SESSION_BUSY' });
    const { SessionManager } = await backend.sdk();
    const manager = SessionManager.open(record.file);
    manager.appendModelChange('gateway-test', 'two');
    manager.appendThinkingLevelChange('high');
  } finally { localLease.release(); }
  agent = await backend.open(record);
  try { assert.equal(agent.config().model.id, 'two'); assert.equal(agent.config().thinking, 'high'); }
  finally { agent.dispose(); }
  const other = await backend.create('Independent session');
  agent = await backend.open(other);
  try { assert.equal(agent.config().model.id, 'one'); assert.equal(agent.config().thinking, 'off'); }
  finally { agent.dispose(); }
});
