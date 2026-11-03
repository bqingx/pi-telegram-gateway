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
  async topic(chat, name) {
    const result = await this.call('createForumTopic', { chat_id: chat, name });
    return result.message_thread_id;
  }
  async rename(chat, thread, name) {
    await this.call('editForumTopic', { chat_id: chat, message_thread_id: thread, name });
  }
}
