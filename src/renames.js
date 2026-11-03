import { translate } from './i18n.js';

export class RenameControls {
  constructor(gateway) { this.gateway = gateway; this.requests = new Map(); }
  key(user, chat, thread) { return `${user}:${chat}:${thread}`; }
  async show(record, chat, thread, user) {
    const g = this.gateway;
    if (!thread || !g.canUse(record, user, chat)) return g.telegram.send(chat, thread, g.t(user, 'openSession'));
    const message = await g.telegram.requestReply(chat, thread, g.t(user, 'renamePrompt'), g.t(user, 'renamePlaceholder'));
    while (this.requests.size >= 128) this.requests.delete(this.requests.keys().next().value);
    this.requests.set(this.key(user, chat, thread), { messageId: message.message_id, recordId: record.id, expires: Date.now() + 600000 });
  }
  async apply(record, chat, thread, user, name) {
    const g = this.gateway;
    if (!thread || !g.canUse(record, user, chat)) return g.telegram.send(chat, thread, g.t(user, 'openSession'));
    name = name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
    if (!name || Array.from(name).length > 128) return g.telegram.send(chat, thread, g.t(user, 'renameInvalid'));
    g.controls.invalidate(chat, thread);
    await g.topicTitles.changed(chat, thread, user, name, { renameTopic: true });
  }
  async handleReply(message, record, chat, thread, user) {
    const g = this.gateway, key = this.key(user, chat, thread), request = this.requests.get(key);
    const reply = message.reply_to_message;
    const ownOldPrompt = Number.isSafeInteger(g.state.data.botId) && reply?.from?.id === g.state.data.botId &&
      [translate('zh', 'renamePrompt'), translate('en', 'renamePrompt')].includes(reply?.text);
    if (!reply || (reply.message_id !== request?.messageId && !ownOldPrompt)) return false;
    if (!request || reply.message_id !== request.messageId || request.expires < Date.now() || record?.id !== request.recordId || !g.canUse(record, user, chat)) {
      await g.telegram.send(chat, thread, g.t(user, 'renameExpired'));
      return true;
    }
    this.requests.delete(key);
    if (message.text === '/cancel') await g.telegram.send(chat, thread, g.t(user, 'renameCancelled'));
    else if (typeof message.text === 'string') await this.apply(record, chat, thread, user, message.text);
    else await g.telegram.send(chat, thread, g.t(user, 'renameInvalid'));
    return true;
  }
}
