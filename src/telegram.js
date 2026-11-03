export function splitText(text, limit = 3500) {
  const chunks = [];
  let chunk = '';
  for (const char of text) {
    if (chunk.length + char.length > limit) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class Telegram {
  constructor(token) { this.token = token; this.typingCooldown = new Map(); }
  async call(method, params = {}, signal) {
    // Never surface fetch errors: their messages can contain the token URL.
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params), signal: signal ?? AbortSignal.timeout(40000),
      });
    } catch { throw new Error(`Telegram ${method}: transport failure`); }
    let data;
    try { data = await response.json(); } catch { throw new Error(`Telegram ${method}: invalid response`); }
    if (!data.ok) {
      const error = new Error(`Telegram ${method}: API error ${data.error_code ?? response.status}`);
      error.code = data.error_code ?? response.status;
      const retryAfter = Number(data.parameters?.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
      throw error;
    }
    return data.result;
  }
  async send(chat, thread, text) {
    for (const part of splitText(text || '(No text response)')) {
      await this.call('sendMessage', { chat_id: chat, ...(thread ? { message_thread_id: thread } : {}), text: part });
    }
  }
  startTyping(chat, thread, { intervalMs = 4000, timeoutMs = 3000, cooldownMs = 30000 } = {}) {
    let stopped = false, timer, controller;
    const tick = async () => {
      if (stopped) return;
      const started = Date.now();
      const remaining = (this.typingCooldown.get(chat) || 0) - started;
      if (remaining > 0) {
        timer = setTimeout(tick, remaining);
        timer.unref?.();
        return;
      }
      this.typingCooldown.delete(chat);
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const params = { chat_id: chat, action: 'typing', ...(thread ? { message_thread_id: thread } : {}) };
        try { await this.call('sendChatAction', params, signal); }
        catch (error) {
          // Like Hermes, fall back to the DM view only on a thread API rejection,
          // never on a timeout/429. Typing is metadata, not conversation content.
          if (!thread || error.code !== 400 || signal.aborted) throw error;
          await this.call('sendChatAction', { chat_id: chat, action: 'typing' }, signal);
        }
      } catch (error) {
        if (!stopped) {
          const delay = error.retryAfter ? Math.min(300000, Math.max(1000, error.retryAfter * 1000)) : cooldownMs;
          this.typingCooldown.set(chat, Date.now() + delay);
          // Bounded even if the bot serves many independent allowlisted chats.
          if (this.typingCooldown.size > 128) this.typingCooldown.delete(this.typingCooldown.keys().next().value);
        }
      } finally {
        if (!stopped) {
          const delay = Math.max(0, intervalMs - (Date.now() - started), (this.typingCooldown.get(chat) || 0) - Date.now());
          timer = setTimeout(tick, delay);
          timer.unref?.();
        }
      }
    };
    void tick(); // Immediate and non-blocking; at most one request per lane.
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }
  async panel(chat, thread, text, keyboard) {
    return this.call('sendMessage', { chat_id: chat, ...(thread ? { message_thread_id: thread } : {}),
      text, reply_markup: { inline_keyboard: keyboard } });
  }
  async editPanel(chat, message, text, keyboard = []) {
    return this.call('editMessageText', { chat_id: chat, message_id: message, text,
      reply_markup: { inline_keyboard: keyboard } });
  }
  async answer(query, text = '') {
    return this.call('answerCallbackQuery', { callback_query_id: query, text });
  }
  async registerCommands() {
    await this.call('setMyCommands', { commands: [
      { command: 'menu', description: 'Session settings / 会话设置' },
      { command: 'model', description: 'Choose model / 选择模型' },
      { command: 'thinking', description: 'Reasoning effort / 推理强度' },
      { command: 'sessions', description: 'List sessions / 会话列表' },
      { command: 'new', description: 'Fresh session in this topic' },
      { command: 'topic', description: 'Current session binding' },
      { command: 'status', description: 'Session status' },
      { command: 'stop', description: 'Stop current run' },
      { command: 'help', description: 'Help' },
    ] });
    await this.call('setChatMenuButton', { menu_button: { type: 'commands' } });
  }
  async topic(chat, name) {
    const result = await this.call('createForumTopic', { chat_id: chat, name });
    return result.message_thread_id;
  }
  async rename(chat, thread, name) {
    await this.call('editForumTopic', { chat_id: chat, message_thread_id: thread, name });
  }
}
