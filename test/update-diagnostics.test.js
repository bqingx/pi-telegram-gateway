import test from 'node:test';
import assert from 'node:assert/strict';
import { updateMetadata, TELEGRAM_UPDATES } from '../src/update-diagnostics.js';

test('polling subscribes to edited messages without treating text edits as new prompts', () => {
  assert.deepEqual(TELEGRAM_UPDATES, ['message', 'edited_message', 'callback_query']);
});
test('diagnostics preserve routing evidence but never message text, title or callback values', () => {
  const meta = updateMetadata({ update_id: 10, edited_message: {
    message_id: 11, message_thread_id: 11, chat: { id: 42, type: 'private' }, from: { id: 1234, is_bot: true },
    text: 'SECRET_BODY', forum_topic_created: { name: 'SECRET_TITLE' },
  }, callback_query: { data: 'SECRET_CALLBACK' } }, 1234);
  assert.equal(meta.kind, 'edited_message'); assert.equal(meta.fromSelf, true); assert.equal(meta.threadId, 11);
  assert.equal(meta.topicNameLength, 12); assert.ok(meta.messageKeys.includes('forum_topic_created'));
  assert.doesNotMatch(JSON.stringify(meta), /SECRET_BODY|SECRET_TITLE|SECRET_CALLBACK/);
});
