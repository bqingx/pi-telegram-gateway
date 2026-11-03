import { randomBytes } from 'node:crypto';
import { translate, levelLabel } from './i18n.js';

const PAGE = 8, TTL = 10 * 60 * 1000;
const fingerprint = config => JSON.stringify([config.model?.provider, config.model?.id, config.thinking]);
const short = text => Array.from(text).slice(0, 70).join('');
const summary = (config, language) => translate(language, 'configSummary', {
  model: config.model ? `${config.model.provider}/${config.model.id}` : translate(language, 'none'),
  thinking: levelLabel(language, config.thinking),
});

// Server-side choices: callback_data never contains user-supplied model IDs,
// credentials, paths or session IDs. Every render rotates its single-use token.
export class SessionControls {
  constructor(gateway) { this.gateway = gateway; this.menus = new Map(); }
  invalidate(chat, thread) {
    for (const [token, menu] of this.menus) if (menu.chat === chat && menu.thread === thread) this.menus.delete(token);
  }
  prune() {
    for (const [token, menu] of this.menus) if (Date.now() > menu.expires) this.menus.delete(token);
    while (this.menus.size >= 128) this.menus.delete(this.menus.keys().next().value);
  }
  async show(record, chat, thread, user, view = { kind: 'home' }) {
    let agent;
    try { agent = await this.gateway.backend.open(record); }
    catch (error) {
      if (!['SESSION_BUSY', 'SESSION_UNMANAGED'].includes(error.code)) throw error;
      await this.gateway.telegram.send(chat, thread, this.gateway.t(user, error.code === 'SESSION_BUSY' ? 'occupiedSettings' : 'unmanagedSettings'));
      return;
    }
    try {
      const config = agent.config();
      const models = ['providers', 'models'].includes(view.kind) ? await agent.models() : [];
      const menu = { recordId: record.id, chat, thread, user, config, models,
        fingerprint: fingerprint(config), expires: Date.now() + TTL };
      await this.render(menu, view);
    } finally { agent.dispose(); }
  }
  async render(menu, view) {
    this.prune();
    const g = this.gateway, language = g.language(menu.user), t = (key, params) => g.t(menu.user, key, params);
    const token = randomBytes(12).toString('hex'), actions = [];
    const button = (text, action) => {
      actions.push(action);
      return { text: short(text), callback_data: `pc:${token}:${actions.length - 1}` };
    };
    const rows = [], title = summary(menu.config, language);
    let text = title;
    const navigate = view => ({ type: 'view', view });
    const home = () => button(`◀ ${t('settings')}`, navigate({ kind: 'home' }));
    const cancel = () => button(t('close'), { type: 'close' });
    const pageRows = (items, makeButton) => {
      const pages = Math.max(1, Math.ceil(items.length / PAGE));
      const page = Math.max(0, Math.min(view.page || 0, pages - 1));
      for (const item of items.slice(page * PAGE, (page + 1) * PAGE)) rows.push([makeButton(item)]);
      const nav = [];
      if (page > 0) nav.push(button(t('prev'), navigate({ ...view, page: page - 1 })));
      if (page < pages - 1) nav.push(button(t('next'), navigate({ ...view, page: page + 1 })));
      if (nav.length) rows.push(nav);
      text += `\n${page + 1}/${pages}`;
    };
    if (view.kind === 'home') {
      rows.push([button(t('model'), navigate({ kind: 'providers' })), button(t('thinking'), navigate({ kind: 'thinking' }))]);
      rows.push([button(t('language'), { type: 'language' }), cancel()]);
    } else if (view.kind === 'providers') {
      text += `\n\n${t('chooseProvider')}`;
      const providers = [...new Set(menu.models.map(model => model.provider))].sort();
      if (!providers.length) text += `\n${t('noModels')}`;
      pageRows(providers, provider => button(`${menu.config.model?.provider === provider ? '✓ ' : ''}${provider}`, navigate({ kind: 'models', provider })));
      rows.push([home(), cancel()]);
    } else if (view.kind === 'models') {
      text += `\n\n${t('chooseModel', { provider: view.provider })}`;
      const models = menu.models.filter(model => model.provider === view.provider).sort((a, b) => a.id.localeCompare(b.id));
      pageRows(models, model => button(`${menu.config.model?.provider === model.provider && menu.config.model?.id === model.id ? '✓ ' : ''}${model.id}`, navigate({ kind: 'confirm', model })));
      rows.push([button(`◀ ${t('providers')}`, navigate({ kind: 'providers' })), cancel()]);
    } else if (view.kind === 'confirm') {
      const model = view.model;
      text += `\n\n${t('switchTo', { provider: model.provider, id: model.id })}`;
      if (model.cost) text += `\n${t('catalogCost', { input: model.cost.input ?? t('priceUnknown'), output: model.cost.output ?? t('priceUnknown') })}`;
      text += `\n${t('modelWarning')}`;
      rows.push([button(t('confirm'), { type: 'model', provider: model.provider, id: model.id })]);
      rows.push([button(`◀ ${t('model')}`, navigate({ kind: 'models', provider: model.provider })), cancel()]);
    } else if (view.kind === 'thinking') {
      text += `\n\n${t('chooseThinking')}`;
      if (menu.config.levels.length <= 1) text += `\n${t('noThinking')}`;
      for (const level of menu.config.levels) rows.push([button(`${level === menu.config.thinking ? '✓ ' : ''}${levelLabel(language, level)}`, { type: 'thinking', level })]);
      rows.push([home(), cancel()]);
    } else throw new Error('Unknown settings view');
    // Only replace the previous menu after successful send/edit. A failed edit
    // never arms invisible buttons. Same-message callbacks without thread metadata
    // are safe because message ID, chat, user and binding are checked below.
    if (menu.messageId) await this.gateway.telegram.editPanel(menu.chat, menu.messageId, text, rows);
    else {
      const message = await this.gateway.telegram.panel(menu.chat, menu.thread, text, rows);
      menu.messageId = message.message_id;
    }
    this.invalidate(menu.chat, menu.thread);
    this.menus.set(token, { ...menu, actions });
  }
  async callback(query) {
    const { gateway: g } = this, m = query.message;
    const t = (key, params) => g.t(query.from?.id, key, params);
    const answer = key => g.telegram.answer(query.id, key ? t(key) : '').catch(() => {});
    if (g.closing || !g.allowed.has(query.from?.id) || query.from?.is_bot || m?.chat?.type !== 'private') return answer('unauthorized');
    const match = query.data?.match(/^pc:([a-f0-9]{24}):(\d{1,3})$/);
    const menu = match && this.menus.get(match[1]);
    const thread = m.message_thread_id === 1 ? undefined : m.message_thread_id;
    if (!menu || Date.now() > menu.expires || menu.user !== query.from.id || menu.chat !== m.chat.id ||
        menu.messageId !== m.message_id || (thread !== undefined && thread !== menu.thread)) return answer('expiredMenu');
    const record = g.state.current(menu.chat, menu.thread);
    if (!g.canUse(record, query.from.id, menu.chat) || record.id !== menu.recordId) return answer('sessionChanged');
    const action = menu.actions[Number(match[2])];
    if (!action) return answer('invalidSelection');
    if (g.active.has(record.id)) return answer('busy');
    if (action.type === 'close') {
      this.invalidate(menu.chat, menu.thread);
      await answer();
      await g.telegram.editPanel(menu.chat, menu.messageId, t('settingsClosed'));
      return;
    }
    if (action.type === 'language') {
      this.invalidate(menu.chat, menu.thread);
      await answer();
      return g.languages.show(menu.chat, menu.thread, menu.user);
    }
    await answer(); // Acknowledge before potentially slow auth/SDK work.
    let agent;
    try {
      agent = await g.backend.open(record);
      if (fingerprint(agent.config()) !== menu.fingerprint) {
        this.invalidate(menu.chat, menu.thread);
        await g.telegram.editPanel(menu.chat, menu.messageId, t('configChanged'));
        return;
      }
      if (action.type === 'view') {
        if (['providers', 'models'].includes(action.view.kind)) menu.models = await agent.models();
        await this.render(menu, action.view);
      } else {
        this.invalidate(menu.chat, menu.thread); // Consume before effects, never replay a stale click.
        if (action.type === 'model') await agent.setModel(action.provider, action.id);
        else if (action.type === 'thinking') await agent.setThinking(action.level);
        else throw new Error('Unknown action');
        await g.telegram.editPanel(menu.chat, menu.messageId, t('saved', { summary: summary(agent.config(), g.language(menu.user)) }));
      }
    } catch (error) {
      this.invalidate(menu.chat, menu.thread);
      await g.telegram.editPanel(menu.chat, menu.messageId, t(error.code === 'SESSION_BUSY' ? 'occupiedMenu' : 'selectionFailed')).catch(() => {});
    } finally { agent?.dispose(); }
  }
}
