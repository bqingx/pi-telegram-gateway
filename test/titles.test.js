import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTitle, cleanTitle, fallbackTitle, titleInput } from '../src/titles.js';

test('title generation is a bounded isolated request, not an Agent prompt/tool call', async () => {
  const calls = [], runtime = { completeSimple: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: '“珍珠挖矿机制分析”' }], stopReason: 'stop', usage: { totalTokens: 20 } }; } };
  const result = await generateTitle(runtime, { id: 'm' }, '请帮我检查珍珠挖矿合约机制', 'zh');
  assert.equal(result.title, '珍珠挖矿机制分析'); assert.equal(calls.length, 1);
  const [, context, options] = calls[0];
  assert.equal(context.messages.length, 1); assert.equal(context.tools, undefined);
  assert.equal(options.maxTokens, 128); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(result.usage.totalTokens, 20);
});
test('titles and fallback labels stay short, Unicode-safe and strip obvious credentials', () => {
  assert.equal(cleanTitle('标题： **模型选择设置**。'), '模型选择设置');
  assert.equal(Array.from(cleanTitle('🙂'.repeat(50))).length, 24);
  assert.equal(fallbackTitle('请检查挖矿机制。然后再分析第二个问题'), '请检查挖矿机制');
  const input = `${'1'.repeat(9)}:${'A'.repeat(35)} sk-abcdefghijklmnopqrst 0x${'a'.repeat(40)}`;
  assert.doesNotMatch(titleInput(input), /AAAA|abcdefghijkl|aaaa/);
  assert.equal(fallbackTitle(input), 'pi 对话');
  assert.equal(fallbackTitle('https://example.com/private'), 'pi 对话');
});
test('provider errors, empty/aborted output and unavailable models use local fallback', async () => {
  const fallback = '开发消息网关';
  assert.equal((await generateTitle({ completeSimple: async () => { throw new Error('SECRET'); } }, {}, fallback, 'zh')).title, fallback);
  for (const result of [{ content: [], stopReason: 'stop' }, { content: [{ type: 'text', text: '别用这个标题' }], stopReason: 'aborted' }]) {
    assert.equal((await generateTitle({ completeSimple: async () => result }, {}, fallback, 'zh')).title, fallback);
  }
  assert.equal((await generateTitle({}, null, fallback, 'zh')).title, fallback);
});
test('long first messages are bounded and English titles request English', async () => {
  let seen;
  await generateTitle({ completeSimple: async (_model, context) => { seen = context; return { content: [] }; } }, {}, 'z'.repeat(10000), 'en');
  assert.equal(Array.from(seen.messages[0].content).length, 2000);
  assert.match(seen.systemPrompt, /Use English/);
});
