import { randomBytes } from 'node:crypto';
import { languageName } from './i18n.js';

// Language is a user preference, independent of session/model locks. It works
// in the root DM, unbound topics, and while another topic is running.
export class LanguageControls {
  constructor(gateway) { this.gateway = gateway; this.menus = new Map(); }
  async show(chat, thread, user) {
    const g = this.gateway, token = randomBytes(12).toString('hex');
    for (const [id, menu] of this.menus) if (menu.user === user || menu.expires < Date.now()) this.menus.delete(id);
    while (this.menus.size >= 128) this.menus.delete(this.menus.keys().next().value);
    const lang = g.language(user);
    const keyboard = [['zh', '中文'], ['en', 'English']].map(([code, name]) => [{ text: `${lang === code ? '✓ ' : ''}${name}`, callback_data: `pl:${token}:${code}` }]);
    keyboard.push([{ text: g.t(user, 'close'), callback_data: `pl:${token}:close` }]);
    const result = await g.telegram.panel(chat, thread, g.t(user, 'languageTitle', { language: languageName(lang) }), keyboard);
    this.menus.set(token, { user, chat, thread, messageId: result.message_id, expires: Date.now() + 600000 });
  }
  async callback(query) {
    const g = this.gateway, m = query.message, user = query.from?.id;
    const answer = key => g.telegram.answer(query.id, key ? g.t(user, key) : '').catch(() => {});
    if (g.closing || !g.allowed.has(user) || query.from?.is_bot || m?.chat?.type !== 'private') return answer('unauthorized');
    const match = query.data?.match(/^pl:([a-f0-9]{24}):(zh|en|close)$/), menu = match && this.menus.get(match[1]);
    const thread = m.message_thread_id === 1 ? undefined : m.message_thread_id;
    if (!menu || menu.user !== user || menu.chat !== m.chat.id || menu.messageId !== m.message_id ||
      menu.expires < Date.now() || (thread !== undefined && thread !== menu.thread)) return answer('languageExpired');
    this.menus.delete(match[1]); // One use, including failed delivery.
    await answer();
    if (match[2] === 'close') return g.telegram.editPanel(menu.chat, menu.messageId, g.t(user, 'languageClosed'));
    g.state.setLanguage(user, match[2]);
    for (const [id, item] of g.controls.menus) if (item.user === user) g.controls.menus.delete(id);
    // Persist first; Telegram API failure must not undo the selected language.
    let menuFailed = false;
    try { await g.telegram.registerCommands(match[2], menu.chat); }
    catch { menuFailed = true; }
    await g.telegram.editPanel(menu.chat, menu.messageId, g.t(user, menuFailed ? 'languageMenuFailed' : 'languageSaved', { language: languageName(match[2]) }));
  }
}
