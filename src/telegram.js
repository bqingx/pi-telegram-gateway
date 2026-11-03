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
  constructor(token) { this.token = token; }
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
    if (!data.ok) throw new Error(`Telegram ${method}: API error ${data.error_code ?? response.status}`);
    return data.result;
  }
  async send(chat, thread, text) {
    for (const part of splitText(text || '(No text response)')) {
      await this.call('sendMessage', { chat_id: chat, ...(thread ? { message_thread_id: thread } : {}), text: part });
    }
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
