import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiBackend } from '../src/pi.js';

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
  const other = await backend.create('Independent session');
  agent = await backend.open(other);
  try { assert.equal(agent.config().model.id, 'one'); assert.equal(agent.config().thinking, 'off'); }
  finally { agent.dispose(); }
});
