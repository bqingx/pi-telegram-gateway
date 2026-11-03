export class TopicTitles {
  constructor(gateway) { this.gateway = gateway; this.inFlight = new Map(); this.namingTargets = new Map(); this.timer = null; }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flushAll().catch(() => {}); }, 2000);
    this.timer.unref?.();
    void this.flushAll().catch(() => {});
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async wait(id) { await this.inFlight.get(id); }
  async settle() { await Promise.allSettled([...this.inFlight.values()]); }
  async changed(chat, thread, user, name, { renameTopic = false } = {}) {
    const g = this.gateway, record = g.state.current(chat, thread);
    if (!g.canUse(record, user, chat) || !name.trim() || (!renameTopic && this.namingTargets.get(record.id) === name)) return;
    if (!renameTopic && record.title === name && !record.pendingTitle && !record.pendingTopicTitle) return;
    record.titleVersion = (record.titleVersion || 0) + 1;
    record.pendingTitle = false; // User intent wins over an in-flight automatic title.
    record.pendingTopicTitle = { name, chat, thread, user, renameTopic, version: record.titleVersion };
    g.state.save();
    const job = g.active.get(record.id);
    job?.agent?.cancelTitle?.();
    if (job?.finalizing) {
      record.pendingTopicTitle.notified = true;
      g.state.save();
      await g.telegram.send(chat, thread, g.t(user, 'topicTitleQueued', { title: name })).catch(() => {});
      return;
    }
    if (job && !job.agent) return; // The initializing run flushes as soon as its SDK is ready.
    await this.flush(record, job?.agent);
  }
  async flushAll() {
    const g = this.gateway;
    if (g.closing) return;
    for (const record of Object.values(g.state.data.sessions)) {
      const p = record.pendingTopicTitle;
      if (!p || (p.nextAttemptAt || 0) > Date.now() || !g.canUse(record, p.user, p.chat) || g.active.has(record.id) || this.inFlight.has(record.id)) continue;
      let usage;
      try { usage = g.backend.usage?.(record); } catch { continue; }
      if (['local', 'telegram', 'unknown', 'unmanaged'].includes(usage)) continue;
      await this.flush(record);
    }
  }
  async flush(record, agent) {
    if (this.inFlight.has(record.id)) return this.inFlight.get(record.id);
    const task = this.apply(record, agent);
    this.inFlight.set(record.id, task);
    try { await task; } finally { this.inFlight.delete(record.id); }
  }
  async apply(record, agent) {
    const g = this.gateway, pending = record.pendingTopicTitle;
    if (!pending || !g.canUse(record, pending.user, pending.chat)) return;
    if (g.state.current(pending.chat, pending.thread)?.id !== record.id) {
      delete record.pendingTopicTitle;
      g.state.save();
      return;
    }
    try {
      const renameTopic = pending.renameTopic ? async () => {
        this.namingTargets.set(record.id, pending.name);
        try { await g.telegram.rename(pending.chat, pending.thread, pending.name); }
        finally { this.namingTargets.delete(record.id); }
      } : undefined;
      if (agent) { await renameTopic?.(); agent.setTitle(pending.name); }
      else await g.backend.setSessionTitle(record, pending.name, renameTopic);
      if (record.pendingTopicTitle?.version !== pending.version) return; // Newer rename will be flushed next.
      record.title = pending.name;
      delete record.pendingTopicTitle;
      g.state.save();
      await g.telegram.send(pending.chat, pending.thread, g.t(pending.user, 'topicTitleSynced', { title: pending.name })).catch(() => {});
    } catch (error) {
      if (record.pendingTopicTitle?.version !== pending.version) return;
      if (pending.renameTopic && [400, 403].includes(error.code)) {
        delete record.pendingTopicTitle;
        g.state.save();
        await g.telegram.send(pending.chat, pending.thread, g.t(pending.user, 'renameFailed')).catch(() => {});
        return;
      }
      if (error.code !== 'SESSION_BUSY') pending.nextAttemptAt = Date.now() + Math.min(300000, Math.max(2000, error.retryAfter ? error.retryAfter * 1000 : 30000));
      if (pending.notified) { g.state.save(); return; }
      pending.notified = true;
      g.state.save();
      await g.telegram.send(pending.chat, pending.thread, g.t(pending.user, 'topicTitleQueued', { title: pending.name })).catch(() => {});
    }
  }
}
