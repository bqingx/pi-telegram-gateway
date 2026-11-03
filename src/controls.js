import { randomBytes } from 'node:crypto';

const PAGE = 8, TTL = 10 * 60 * 1000;
const fingerprint = config => JSON.stringify([config.model?.provider, config.model?.id, config.thinking]);
const short = text => Array.from(text).slice(0, 70).join('');
const summary = config => `模型 / Model: ${config.model ? `${config.model.provider}/${config.model.id}` : '(none)'}\n推理强度 / Thinking: ${config.thinking}`;

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
      await this.gateway.telegram.send(chat, thread, error.code === 'SESSION_BUSY' ?
        'Session is occupied locally or by another operation. Close the other endpoint first.' :
        'Enroll this local session with pi-shared --enroll <session-id> after closing ordinary pi windows.');
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
    const token = randomBytes(12).toString('hex'), actions = [];
    const button = (text, action) => {
      actions.push(action);
      return { text: short(text), callback_data: `pc:${token}:${actions.length - 1}` };
    };
    const rows = [], title = summary(menu.config);
    let text = title;
    const navigate = view => ({ type: 'view', view });
    const home = () => button('◀ 设置 / Settings', navigate({ kind: 'home' }));
    const cancel = () => button('关闭 / Close', { type: 'close' });
    const pageRows = (items, makeButton) => {
      const pages = Math.max(1, Math.ceil(items.length / PAGE));
      const page = Math.max(0, Math.min(view.page || 0, pages - 1));
      for (const item of items.slice(page * PAGE, (page + 1) * PAGE)) rows.push([makeButton(item)]);
      const nav = [];
      if (page > 0) nav.push(button('◀ 上一页', navigate({ ...view, page: page - 1 })));
      if (page < pages - 1) nav.push(button('下一页 ▶', navigate({ ...view, page: page + 1 })));
      if (nav.length) rows.push(nav);
      text += `\n${page + 1}/${pages}`;
    };
    if (view.kind === 'home') {
      rows.push([button('模型 / Model', navigate({ kind: 'providers' })), button('推理强度 / Thinking', navigate({ kind: 'thinking' }))]);
      rows.push([cancel()]);
    } else if (view.kind === 'providers') {
      text += '\n\n选择提供商 / Choose provider (configured credentials only)';
      const providers = [...new Set(menu.models.map(model => model.provider))].sort();
      if (!providers.length) text += '\nNo available models. Configure pi credentials locally.';
      pageRows(providers, provider => button(`${menu.config.model?.provider === provider ? '✓ ' : ''}${provider}`, navigate({ kind: 'models', provider })));
      rows.push([home(), cancel()]);
    } else if (view.kind === 'models') {
      text += `\n\n${view.provider} — 选择模型 / Choose model`;
      const models = menu.models.filter(model => model.provider === view.provider).sort((a, b) => a.id.localeCompare(b.id));
      pageRows(models, model => button(`${menu.config.model?.provider === model.provider && menu.config.model?.id === model.id ? '✓ ' : ''}${model.id}`, navigate({ kind: 'confirm', model })));
      rows.push([button('◀ 提供商 / Providers', navigate({ kind: 'providers' })), cancel()]);
    } else if (view.kind === 'confirm') {
      const model = view.model;
      text += `\n\n切换到 / Switch to:\n${model.provider}/${model.id}`;
      if (model.cost) text += `\nCatalog USD / 1M tokens: input ${model.cost.input}, output ${model.cost.output} (estimate, not a quote).`;
      text += '\n仅修改当前会话。下一条消息会将会话上下文发送给所选提供商；可能产生不同费用。\nCurrent session only. Future prompts send its context to this provider; billing may change.';
      rows.push([button('确认切换 / Confirm', { type: 'model', provider: model.provider, id: model.id })]);
      rows.push([button('◀ 模型 / Models', navigate({ kind: 'models', provider: model.provider })), cancel()]);
    } else if (view.kind === 'thinking') {
      text += '\n\n选择推理强度 / Choose reasoning effort';
      if (menu.config.levels.length <= 1) text += '\nThis model has no adjustable reasoning effort.';
      for (const level of menu.config.levels) rows.push([button(`${level === menu.config.thinking ? '✓ ' : ''}${level}`, { type: 'thinking', level })]);
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
    const answer = text => g.telegram.answer(query.id, text).catch(() => {});
    if (g.closing || !g.allowed.has(query.from?.id) || query.from?.is_bot || m?.chat?.type !== 'private') return answer('Not authorized.');
    const match = query.data?.match(/^pc:([a-f0-9]{24}):(\d{1,3})$/);
    const menu = match && this.menus.get(match[1]);
    const thread = m.message_thread_id === 1 ? undefined : m.message_thread_id;
    if (!menu || Date.now() > menu.expires || menu.user !== query.from.id || menu.chat !== m.chat.id ||
        menu.messageId !== m.message_id || (thread !== undefined && thread !== menu.thread)) return answer('菜单已失效，请重新打开 /menu。');
    const record = g.state.current(menu.chat, menu.thread);
    if (!g.canUse(record, query.from.id, menu.chat) || record.id !== menu.recordId) return answer('Session changed. Reopen /menu.');
    const action = menu.actions[Number(match[2])];
    if (!action) return answer('Invalid selection.');
    if (g.active.has(record.id)) return answer('Session busy. Wait or /stop.');
    if (action.type === 'close') {
      this.invalidate(menu.chat, menu.thread);
      await answer();
      await g.telegram.editPanel(menu.chat, menu.messageId, '设置已关闭 / Settings closed.');
      return;
    }
    await answer(); // Acknowledge before potentially slow auth/SDK work.
    let agent;
    try {
      agent = await g.backend.open(record);
      if (fingerprint(agent.config()) !== menu.fingerprint) {
        this.invalidate(menu.chat, menu.thread);
        await g.telegram.editPanel(menu.chat, menu.messageId, '模型设置已变化，请重新打开 /menu。');
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
        await g.telegram.editPanel(menu.chat, menu.messageId, `已保存，仅当前会话 / Saved for this session only.\n${summary(agent.config())}`);
      }
    } catch (error) {
      this.invalidate(menu.chat, menu.thread);
      await g.telegram.editPanel(menu.chat, menu.messageId,
        error.code === 'SESSION_BUSY' ? 'Session is occupied locally. Close that window and reopen /menu.' :
        '操作失败或确认消息未送达；请重新打开 /menu 查看实际设置。未自动重试。\nSelection failed or confirmation delivery was uncertain. Reopen /menu to inspect; no automatic retry.').catch(() => {});
    } finally { agent?.dispose(); }
  }
}
