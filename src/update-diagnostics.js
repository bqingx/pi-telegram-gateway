export const TELEGRAM_UPDATES = Object.freeze(['message', 'edited_message', 'callback_query']);

// Metadata only: never log text, title values, callback payloads, URLs or tokens.
export function updateMetadata(update, botId) {
  const kind = update.edited_message ? 'edited_message' : update.message ? 'message' : update.callback_query ? 'callback_query' : 'other';
  const message = update.edited_message || update.message;
  const name = message?.forum_topic_edited?.name ?? message?.forum_topic_created?.name;
  return { event: 'telegram_update_metadata', updateId: update.update_id, updateKeys: Object.keys(update), kind,
    messageKeys: message ? Object.keys(message) : [], chatId: message?.chat?.id, chatType: message?.chat?.type,
    messageId: message?.message_id, threadId: message?.message_thread_id, fromId: message?.from?.id,
    fromBot: !!message?.from?.is_bot, fromSelf: Number.isSafeInteger(botId) && message?.from?.id === botId,
    topicNameLength: typeof name === 'string' ? Array.from(name).length : undefined,
    replyMessageKeys: message?.reply_to_message ? Object.keys(message.reply_to_message) : [],
    replyMessageId: message?.reply_to_message?.message_id,
    replyTopicNameLength: typeof message?.reply_to_message?.forum_topic_created?.name === 'string'
      ? Array.from(message.reply_to_message.forum_topic_created.name).length : undefined };
}
