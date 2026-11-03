import { SessionControls } from './controls.js';

const HELP = `/menu — settings buttons for this session
/model, /models — choose provider and model
/thinking, /reasoning — choose reasoning effort
/topic — show current binding (root: list sessions)
/topic <session-id> — restore an unbound session in this topic
/sessions [page] — list your sessions
/new — fresh session in this topic, keep old history
/status — current session and running state
/stop — abort this topic's active run
/help — this help
Send a normal message in the root DM to create a new topic + session.`;

export class Gateway {
  constructor({ state, telegram, backend, allowedUsers, maxActive = 4 }) {
    Object.assign(this, { state, telegram, backend, maxActive });
    this.allowed = new Set(allowedUsers);
    this.active = new Map();
    this.controls = new SessionControls(this);
    this.closing = false;
  }
  async create(chat, thread, user, title) {
    const info = await this.backend.create(title);
    const record = { ...info, chat, user, title, createdAt: new Date().toISOString() };
    this.state.data.sessions[info.id] = record;
    this.state.bind(chat, thread, info.id, user);
    return record;
  }
  async handle(update) {
    if (update.callback_query) return this.controls.callback(update.callback_query);
    const m = update.message;
    if (this.closing || !m || m.chat?.type !== 'private' || m.from?.is_bot || !this.allowed.has(m.from?.id)) return;
    const chat = m.chat.id, user = m.from.id;
    // Telegram General may arrive with thread_id=1 or no thread id.
    let thread = m.message_thread_id === 1 ? undefined : m.message_thread_id;
    const say = text => this.telegram.send(chat, thread, text);
    if (m.forum_topic_deleted && thread) {
      delete this.state.data.bindings[this.state.key(chat, thread)];
      this.state.save();
      return;
    }
    if (m.forum_topic_created || m.forum_topic_edited || m.forum_topic_closed || m.forum_topic_reopened) return;
    if (!m.text) {
      await say('This version accepts text only; attachments are not processed.');
      return;
    }
    const match = m.text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    let record = thread ? this.state.current(chat, thread) : undefined;
    if (match) {
      const command = match[1].toLowerCase(), arg = (match[2] || '').trim();
      if (command === 'help' || command === 'start') {
        await say(HELP);
        if (record && !this.active.has(record.id)) return this.controls.show(record, chat, thread, user);
        return;
      }
      if (['menu', 'model', 'models', 'thinking', 'reasoning'].includes(command)) {
        if (!record || record.user !== user) return say('请进入话题，并先发送消息或点选 /new。Open a topic and send a message or use /new first.');
        if (this.active.has(record.id)) return say('Session is busy. Wait for it to finish or use /stop.');
        const kind = ['model', 'models'].includes(command) ? 'providers' : ['thinking', 'reasoning'].includes(command) ? 'thinking' : 'home';
        return this.controls.show(record, chat, thread, user, { kind });
      }
      if (command === 'sessions' || (command === 'topic' && !thread)) {
        const all = Object.values(this.state.data.sessions).filter(s => s.user === user && s.chat === chat);
        const page = Math.max(1, Number.parseInt(arg, 10) || 1);
        const items = all.slice((page - 1) * 10, page * 10);
        const bound = new Set(Object.values(this.state.data.bindings));
        return say(`Sessions (page ${page}/${Math.max(1, Math.ceil(all.length / 10))}):\n` + (items.map(s => `${s.id}\n${s.title} ${bound.has(s.id) ? '[bound]' : '[available]'}`).join('\n\n') || '(none)'));
      }
      if (!thread) return say('Open a topic first, or send a normal message here to create one.');
      if (command === 'stop') {
        const job = record && this.active.get(record.id);
        if (job) { job.cancelled = true; await job.agent?.abort(); }
        return say(job ? 'Stop requested. Already executed tool effects cannot be undone.' : 'No active run.');
      }
      if (command === 'status' || (command === 'topic' && !arg)) {
        return say(record ? `${record.title}\n${record.id}\n${this.active.has(record.id) ? 'Running' : 'Idle'}` : 'No session bound yet.');
      }
      if (!['new', 'topic'].includes(command)) return say('Unknown command. Use /help.');
      if (record && this.active.has(record.id)) return say('Session is busy. Use /stop and wait before switching.');
      if (command === 'new') {
        this.controls.invalidate(chat, thread);
        record = await this.create(chat, thread, user, 'New conversation');
        return say(`New session: ${record.id}`);
      }
      try { this.state.bind(chat, thread, arg, user); }
      catch { return say('Cannot switch: session missing, belongs elsewhere, or is bound to another topic.'); }
      this.controls.invalidate(chat, thread);
      record = this.state.current(chat, thread);
      await say(`Restored: ${record.title}\n${record.id}`);
      const agent = await this.backend.open(record);
      try { const last = agent.last(); if (last) await say(last); }
      finally { agent.dispose(); }
      return;
    }
    if (record && this.active.has(record.id)) return say('This session is busy. Wait for its reply or use /stop; this message was not queued.');
    if (this.active.size >= this.maxActive) return say('Gateway concurrency limit reached; try again later.');
    if (!thread) {
      // Fail closed: never silently put a root message in a different session.
      thread = await this.telegram.topic(chat, Array.from(m.text.replace(/\s+/g, ' ').trim()).slice(0, 80).join('') || 'Pi Chat');
    }
    if (!record) record = await this.create(chat, thread, user, Array.from(m.text.replace(/\s+/g, ' ').trim()).slice(0, 80).join('') || 'Pi Chat');
    this.controls.invalidate(chat, thread);
    const job = { agent: null, cancelled: false, promise: null };
    this.active.set(record.id, job);
    this.state.data.jobs[record.id] = { chat, thread, status: 'running', updateId: update.update_id };
    this.state.save();
    job.promise = this.run(record, m.text, chat, thread, job);
  }
  async run(record, text, chat, thread, job) {
    let phase = 'model';
    try {
      job.agent = await this.backend.open(record);
      if (job.cancelled) return;
      const reply = await job.agent.prompt(text);
      phase = 'delivery';
      this.state.data.jobs[record.id].status = 'reply-pending';
      this.state.save();
      await this.telegram.send(chat, thread, reply);
      this.state.data.jobs[record.id].status = job.cancelled ? 'stopped' : 'done';
    } catch {
      this.state.data.jobs[record.id].status = phase === 'delivery' ? 'delivery-uncertain' : 'failed';
      await this.telegram.send(chat, thread, phase === 'delivery'
        ? 'Reply delivery failed or is uncertain. Use /topic <same-session-id> when idle to replay the last reply. Do not repeat side-effecting instructions blindly.'
        : 'Run failed. History is preserved; check /status. Tool effects may already have occurred; nothing was automatically retried.').catch(() => {});
    } finally {
      if (job.cancelled) this.state.data.jobs[record.id].status = 'stopped';
      job.agent?.dispose();
      this.active.delete(record.id);
      this.state.save();
    }
  }
  async recover() {
    for (const job of Object.values(this.state.data.jobs)) {
      if (['running', 'reply-pending'].includes(job.status)) {
        job.status = 'interrupted';
        this.state.save();
        await this.telegram.send(job.chat, job.thread, 'Gateway restarted during a run. It will not replay the instruction automatically. Check the session and any external effects before retrying.').catch(() => {});
      }
    }
  }
  async close() {
    this.closing = true;
    const jobs = [...this.active.values()];
    for (const job of jobs) job.cancelled = true;
    await Promise.allSettled(jobs.map(job => job.agent?.abort()));
    await Promise.allSettled(jobs.map(job => job.promise));
  }
}
