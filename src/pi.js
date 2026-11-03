import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionLease, isEnrolled, enrollSession, UnmanagedSessionError, sessionOccupant } from './session-lock.js';
import { generateTitle as requestTitle } from './titles.js';

export class PiBackend {
  constructor(cwd, dataDir, options = {}) {
    this.cwd = cwd;
    this.dir = join(dataDir, 'sessions');
    this.options = options;
  }
  async sdk() { return import('@earendil-works/pi-coding-agent'); }
  async create(title, cwd = this.cwd) {
    const { SessionManager } = await this.sdk();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(cwd, this.options.sharedSessions ? undefined : this.dir);
    manager.appendSessionInfo(title);
    // Pi lazily writes until the first conversation. Materialize the SDK's own
    // header/entries so even an empty /new session survives a restart.
    const file = manager.getSessionFile();
    const lease = SessionLease.acquire(file, 'telegram');
    try {
      writeFileSync(file, [manager.getHeader(), ...manager.getEntries()]
        .map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      enrollSession(file);
    } finally { lease.release(); }
    return { id: manager.getSessionId(), file, cwd };
  }
  async listShared() {
    if (!this.options.sharedSessions) return [];
    const { SessionManager } = await this.sdk();
    const all = [...await SessionManager.listAll(), ...await SessionManager.listAll(this.dir)];
    const seen = new Set();
    return all.filter(s => !seen.has(s.path) && seen.add(s.path)).map(s => ({
      id: s.id, file: s.path, cwd: s.cwd, title: (s.name || s.firstMessage || '').replace(/\s+/g, ' ').slice(0, 120),
      createdAt: s.created.toISOString(), modifiedAt: s.modified.toISOString(), source: 'local',
    }));
  }
  usage(record) {
    if (this.options.sharedSessions && !isEnrolled(record.file)) return 'unmanaged';
    return sessionOccupant(record.file)?.channel || 'available';
  }
  async setSessionTitle(record, title, beforeWrite) {
    if (this.options.sharedSessions && !isEnrolled(record.file)) throw new UnmanagedSessionError();
    const lease = SessionLease.acquire(record.file, 'telegram');
    try {
      const { SessionManager } = await this.sdk();
      const manager = SessionManager.open(record.file);
      if (manager.getSessionId() !== record.id) throw new Error('Session ID mismatch');
      await beforeWrite?.();
      manager.appendSessionInfo(title);
    } finally { lease.release(); }
  }
  async open(record) {
    if (this.options.sharedSessions && !isEnrolled(record.file)) throw new UnmanagedSessionError();
    const lease = SessionLease.acquire(record.file, 'telegram');
    try {
      const agent = await this.openUnlocked(record);
      return { ...agent, dispose: () => { try { agent.dispose(); } finally { lease.release(); } } };
    } catch (error) { lease.release(); throw error; }
  }
  async openUnlocked(record) {
    const { createAgentSession, SessionManager, ModelRuntime } = await this.sdk();
    const manager = SessionManager.open(record.file);
    if (manager.getSessionId() !== record.id) throw new Error('Session ID mismatch');
    const modelRuntime = this.options.modelRuntime ?? await ModelRuntime.create(this.options.agentDir ? {
      authPath: join(this.options.agentDir, 'auth.json'), modelsPath: join(this.options.agentDir, 'models.json'),
    } : {});
    const branch = manager.getBranch();
    const selected = branch.filter(entry => entry.type === 'model_change').at(-1);
    const thinking = branch.filter(entry => entry.type === 'thinking_level_change').at(-1)?.thinkingLevel;
    const model = selected ? modelRuntime.getModel(selected.provider, selected.modelId) : undefined;
    // Explicit options also restore settings in empty /new sessions (SDK defaults
    // otherwise restore selections only after conversation messages exist).
    if (selected && (!model || !await modelRuntime.checkAuth(model.provider))) throw new Error('Saved model unavailable');
    const { session } = await createAgentSession({ ...this.options, cwd: manager.getCwd() || this.cwd, sessionManager: manager,
      modelRuntime, ...(model ? { model } : {}), ...(thinking ? { thinkingLevel: thinking } : {}) });
    try { await session.bindExtensions({ mode: 'rpc', onError: () => {} }); }
    catch (error) { session.dispose(); throw error; }
    const titleController = new AbortController();
    return {
      generateTitle: async (text, language) => {
        const result = await requestTitle(session.modelRuntime, session.model, text, language, titleController.signal);
        if (result.usage) manager.appendUsage('title', result.provider || session.model?.provider || 'unknown', result.model || session.model?.id || 'unknown', result.usage);
        return result.title;
      },
      setTitle: title => { manager.appendSessionInfo(title); },
      cancelTitle: () => titleController.abort(),
      prompt: async (text) => {
        // Gateway owns slash commands; do not invoke hidden UI-dependent commands remotely.
        let finalMessage;
        const unsubscribe = session.subscribe(event => {
          if (event.type === 'message_end' && event.message.role === 'assistant') finalMessage = event.message;
        });
        try {
          await session.prompt(text, { expandPromptTemplates: false });
          if (finalMessage?.stopReason === 'error') throw new Error('Model run failed');
          return finalMessage?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
        } finally { unsubscribe(); }
      },
      config: () => ({
        model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null,
        thinking: session.thinkingLevel,
        levels: session.model ? session.getAvailableThinkingLevels() : [],
      }),
      models: async () => (await session.modelRuntime.getAvailable()).map(model => ({
        provider: model.provider, id: model.id, name: model.name, cost: model.cost,
      })),
      setModel: async (provider, id) => {
        const model = (await session.modelRuntime.getAvailable()).find(model => model.provider === provider && model.id === id);
        if (!model) throw new Error('Model unavailable');
        await session.setModel(model, { persist: false });
      },
      setThinking: level => {
        if (!session.model || !session.getAvailableThinkingLevels().includes(level)) throw new Error('Unsupported thinking level');
        session.setThinkingLevel(level, { persist: false });
      },
      last: () => session.getLastAssistantText(),
      abort: () => { titleController.abort(); return session.abort(); },
      dispose: () => { titleController.abort(); session.dispose(); },
    };
  }
}
