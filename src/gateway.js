import { SessionControls } from './controls.js';
import { LanguageControls } from './language.js';
import { translate, usageLabel } from './i18n.js';
import { fallbackTitle, cleanTitle } from './titles.js';
import { TopicTitles } from './topic-titles.js';

export class Gateway {
  constructor({ state, telegram, backend, allowedUsers, maxActive = 4, sharedSessionOwner }) {
    Object.assign(this, { state, telegram, backend, maxActive, sharedSessionOwner });
    this.allowed = new Set(allowedUsers);
    this.active = new Map();
    this.controls = new SessionControls(this);
    this.languages = new LanguageControls(this);
    this.topicTitles = new TopicTitles(this);
    this.closing = false;
  }
  start() { this.topicTitles.start(); }
  language(user) { return this.state.language(user); }
  t(user, key, params) { return translate(this.language(user), key, params); }
  usage(user, code) { return usageLabel(this.language(user), code); }
  canUse(record, user, chat) {
    return record && record.user === user && record.chat === chat && (record.source !== 'local' || user === this.sharedSessionOwner);
  }
  async syncShared(user, chat) {
    if (user !== this.sharedSessionOwner) return;
    for (const item of await this.backend.listShared()) {
      const existing = this.state.data.sessions[item.id];
      if (existing && (existing.user !== user || existing.chat !== chat || existing.file !== item.file)) continue;
      const metadata = { ...item, ...existing, source: existing ? (existing.source || 'gateway') : 'local', title: item.title || this.t(user, 'untitled'), modifiedAt: item.modifiedAt, user, chat };
      if (existing) Object.assign(existing, metadata); // Preserve references held by active runs/title synchronization.
      else this.state.data.sessions[item.id] = metadata;
    }
    this.state.save();
  }
  async create(chat, thread, user, title, cwd) {
    const info = await this.backend.create(title, cwd);
    const record = { ...info, chat, user, title, pendingTitle: true, source: 'gateway', createdAt: new Date().toISOString() };
    this.state.data.sessions[info.id] = record;
    this.state.bind(chat, thread, info.id, user);
    return record;
  }
  async handleTopicRename(update) {
    const edited = !!update.edited_message;
    const m = update.edited_message || update.message;
    const name = m?.forum_topic_edited?.name ?? (edited ? m?.forum_topic_created?.name : undefined);
    if (this.closing || typeof name !== 'string' || m.chat?.type !== 'private' || !this.allowed.has(m.chat.id)) return false;
    if (m.forward_origin || m.forward_from || m.forward_date || m.forward_sender_name || m.is_automatic_forward) return false;
    const owner = m.chat.id;
    const human = m.from?.id === owner && !m.from?.is_bot;
    // A private topic header can be an edited bot-authored creation message.
    // This exception is only for trusted service metadata, never text/prompts.
    const ownEditedHeader = edited && Number.isSafeInteger(this.state.data.botId) && m.from?.is_bot && m.from.id === this.state.data.botId;
    if (!human && !ownEditedHeader) return false;
    let thread = m.message_thread_id === 1 ? undefined : m.message_thread_id;
    if (!thread && edited && this.state.current(owner, m.message_id)) thread = m.message_id;
    if (thread) await this.topicTitles.changed(owner, thread, owner, name);
    return true;
  }
  async handle(update) {
    if (await this.handleTopicRename(update)) return;
    if (update.callback_query) return update.callback_query.data?.startsWith('pl:') ? this.languages.callback(update.callback_query) : this.controls.callback(update.callback_query);
    const m = update.message;
    if (this.closing || !m || m.chat?.type !== 'private' || m.from?.is_bot || !this.allowed.has(m.from?.id)) return;
    const chat = m.chat.id, user = m.from.id;
    // Telegram General may arrive with thread_id=1 or no thread id.
    let thread = m.message_thread_id === 1 ? undefined : m.message_thread_id;
    const say = text => this.telegram.send(chat, thread, text);
    const t = (key, params) => this.t(user, key, params);
    if (m.forum_topic_deleted && thread) {
      delete this.state.data.bindings[this.state.key(chat, thread)];
      this.state.save();
      return;
    }
    if (m.forum_topic_edited) {
      if (thread && typeof m.forum_topic_edited.name === 'string') await this.topicTitles.changed(chat, thread, user, m.forum_topic_edited.name);
      return;
    }
    if (m.forum_topic_created || m.forum_topic_closed || m.forum_topic_reopened) return;
    if (!m.text) {
      await say(t('textOnly'));
      return;
    }
    const match = m.text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    let record = thread ? this.state.current(chat, thread) : undefined;
    if (!this.canUse(record, user, chat)) record = undefined;
    if (match) {
      const command = match[1].toLowerCase(), arg = (match[2] || '').trim();
      if (command === 'help' || command === 'start') {
        await say(t('help'));
        if (record && !this.active.has(record.id)) return this.controls.show(record, chat, thread, user);
        return this.languages.show(chat, thread, user);
      }
      if (['language', 'lang'].includes(command) || (command === 'menu' && !record)) return this.languages.show(chat, thread, user);
      if (['menu', 'model', 'models', 'thinking', 'reasoning'].includes(command)) {
        if (!record || record.user !== user) return say(t('openSession'));
        if (this.active.has(record.id)) return say(t('busy'));
        const kind = ['model', 'models'].includes(command) ? 'providers' : ['thinking', 'reasoning'].includes(command) ? 'thinking' : 'home';
        return this.controls.show(record, chat, thread, user, { kind });
      }
      if (command === 'sessions' || (command === 'topic' && !thread)) {
        await this.syncShared(user, chat);
        const all = Object.values(this.state.data.sessions).filter(s => this.canUse(s, user, chat))
          .sort((a, b) => (b.modifiedAt || b.createdAt).localeCompare(a.modifiedAt || a.createdAt));
        const page = Math.max(1, Number.parseInt(arg, 10) || 1);
        const items = all.slice((page - 1) * 10, page * 10);
        const bound = new Set(Object.values(this.state.data.bindings));
        return say(t('sessions', { page, pages: Math.max(1, Math.ceil(all.length / 10)), items: items.map(s => `${s.id}\n${s.title} [${t(bound.has(s.id) ? 'bound' : 'available')}]${this.sharedSessionOwner === user ? ` [${this.usage(user, this.backend.usage(s))}]` : ''}`).join('\n\n') || t('none') }));
      }
      if (!thread) return say(t('openTopic'));
      if (command === 'stop') {
        const job = record && this.active.get(record.id);
        if (job) { job.cancelled = true; job.stopTyping?.(); await job.agent?.abort(); }
        return say(t(job ? 'stopRequested' : 'noActive'));
      }
      if (command === 'status' || (command === 'topic' && !arg)) {
        return say(record ? t('status', { title: record.title, id: record.id, state: this.active.has(record.id) ? t('running') : t('idle', { usage: this.usage(user, this.backend.usage?.(record) || 'available') }) }) : t('noBinding'));
      }
      if (!['new', 'topic'].includes(command)) return say(t('unknownCommand'));
      if (record && this.active.has(record.id)) return say(t('busySwitch'));
      if (command === 'new') {
        this.controls.invalidate(chat, thread);
        record = await this.create(chat, thread, user, t('newTitle'), record?.cwd);
        return say(t('newSession', { id: record.id }));
      }
      await this.syncShared(user, chat);
      try { this.state.assertBindable(chat, thread, arg, user); }
      catch { return say(t('cannotSwitch')); }
      const target = this.state.data.sessions[arg];
      if (!this.canUse(target, user, chat)) return say(t('sharedDenied'));
      let agent;
      try {
        agent = await this.backend.open(target); // Lock before changing the binding or opening SDK history.
        this.state.bind(chat, thread, arg, user);
        this.controls.invalidate(chat, thread);
        await say(t('restored', { title: target.title, id: target.id }));
        const last = agent.last(); if (last) await say(last);
      } catch (error) {
        await say(t(error.code === 'SESSION_BUSY' ? 'occupiedRestore' : error.code === 'SESSION_UNMANAGED' ? 'unmanagedRestore' : 'restoreFailed'));
      } finally { agent?.dispose(); }
      return;
    }
    if (record && this.active.has(record.id)) return say(t('busyPrompt'));
    if (this.active.size >= this.maxActive) return say(t('limit'));
    let stopTyping = this.telegram.startTyping?.(chat, thread);
    try {
      if (!thread) {
        // Fail closed: never silently put a root message in a different session.
        thread = await this.telegram.topic(chat, fallbackTitle(m.text, this.language(user)));
        stopTyping?.();
        stopTyping = this.telegram.startTyping?.(chat, thread);
      }
      if (!record) record = await this.create(chat, thread, user, fallbackTitle(m.text, this.language(user)));
      this.controls.invalidate(chat, thread);
      const job = { agent: null, cancelled: false, promise: null, stopTyping };
      this.active.set(record.id, job);
      this.state.data.jobs[record.id] = { chat, thread, status: 'running', updateId: update.update_id };
      this.state.save();
      job.promise = this.run(record, m.text, chat, thread, job);
      stopTyping = undefined; // Lifecycle ownership transferred to the run.
    } finally { stopTyping?.(); }
  }
  async run(record, text, chat, thread, job) {
    let phase = 'model';
    try {
      await this.topicTitles.wait(record.id);
      job.agent = await this.backend.open(record);
      await this.topicTitles.flush(record, job.agent);
      if (job.cancelled) return;
      if (record.pendingTitle) {
        const version = record.titleVersion || 0;
        const suggested = await job.agent.generateTitle?.(text, this.language(record.user));
        if (job.cancelled) return;
        if (record.pendingTitle && (record.titleVersion || 0) === version) {
          const title = cleanTitle(suggested || '') || fallbackTitle(text, this.language(record.user));
          try {
            // Keep the existing session lease throughout both name changes.
            this.topicTitles.namingTargets.set(record.id, title);
            await this.telegram.rename(chat, thread, title);
            if ((record.titleVersion || 0) !== version) {
              // A user rename arrived while Telegram's automatic rename was in flight.
              const manual = record.pendingTopicTitle?.name || record.title;
              this.topicTitles.namingTargets.set(record.id, manual);
              await this.telegram.rename(chat, thread, manual);
            } else {
              job.agent.setTitle(title);
              record.title = title;
            }
          } catch {
            await this.telegram.send(chat, thread, this.t(record.user, 'titleSyncFailed')).catch(() => {});
          } finally { this.topicTitles.namingTargets.delete(record.id); }
          record.pendingTitle = false; // One attempt per session; no loop on generation/rename errors.
          this.state.save();
        }
        await this.topicTitles.flush(record, job.agent);
      }
      const reply = await job.agent.prompt(text);
      job.stopTyping?.();
      phase = 'delivery';
      this.state.data.jobs[record.id].status = 'reply-pending';
      this.state.save();
      await this.telegram.send(chat, thread, reply || this.t(record.user, 'noText'));
      this.state.data.jobs[record.id].status = job.cancelled ? 'stopped' : 'done';
    } catch (error) {
      job.stopTyping?.();
      this.state.data.jobs[record.id].status = phase === 'delivery' ? 'delivery-uncertain' : 'failed';
      await this.telegram.send(chat, thread, this.t(record.user, error.code === 'SESSION_BUSY' ? 'occupiedPrompt' : error.code === 'SESSION_UNMANAGED' ? 'unmanagedPrompt' : phase === 'delivery' ? 'deliveryFailed' : 'runFailed')).catch(() => {});
    } finally {
      job.stopTyping?.();
      if (job.cancelled) this.state.data.jobs[record.id].status = 'stopped';
      job.agent?.dispose();
      this.active.delete(record.id);
      this.state.save();
    }
  }
  async recover() {
    for (const [id, job] of Object.entries(this.state.data.jobs)) {
      if (['running', 'reply-pending'].includes(job.status)) {
        job.status = 'interrupted';
        this.state.save();
        await this.telegram.send(job.chat, job.thread, this.t(this.state.data.sessions[id]?.user ?? job.chat, 'interrupted')).catch(() => {});
      }
    }
  }
  async close() {
    this.closing = true;
    this.topicTitles.stop();
    const jobs = [...this.active.values()];
    for (const job of jobs) { job.cancelled = true; job.stopTyping?.(); }
    await Promise.allSettled(jobs.map(job => job.agent?.abort()));
    await Promise.allSettled(jobs.map(job => job.promise));
    await this.topicTitles.settle();
  }
}
