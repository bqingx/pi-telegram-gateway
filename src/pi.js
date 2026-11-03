import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class PiBackend {
  constructor(cwd, dataDir, options = {}) {
    this.cwd = cwd;
    this.dir = join(dataDir, 'sessions');
    this.options = options;
  }
  async sdk() { return import('@earendil-works/pi-coding-agent'); }
  async create(title) {
    const { SessionManager } = await this.sdk();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(this.cwd, this.dir);
    manager.appendSessionInfo(title);
    // Pi lazily writes until the first conversation. Materialize the SDK's own
    // header/entries so even an empty /new session survives a restart.
    writeFileSync(manager.getSessionFile(), [manager.getHeader(), ...manager.getEntries()]
      .map(entry => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    return { id: manager.getSessionId(), file: manager.getSessionFile() };
  }
  async open(record) {
    const { createAgentSession, SessionManager, ModelRuntime } = await this.sdk();
    const manager = SessionManager.open(record.file, this.dir);
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
    const { session } = await createAgentSession({ ...this.options, cwd: this.cwd, sessionManager: manager,
      modelRuntime, ...(model ? { model } : {}), ...(thinking ? { thinkingLevel: thinking } : {}) });
    try { await session.bindExtensions({ mode: 'rpc', onError: () => {} }); }
    catch (error) { session.dispose(); throw error; }
    return {
      prompt: async (text) => {
        // Gateway owns slash commands; do not invoke hidden UI-dependent commands remotely.
        let finalMessage;
        const unsubscribe = session.subscribe(event => {
          if (event.type === 'message_end' && event.message.role === 'assistant') finalMessage = event.message;
        });
        try {
          await session.prompt(text, { expandPromptTemplates: false });
          if (finalMessage?.stopReason === 'error') throw new Error('Model run failed');
          return finalMessage?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || '(No text response)';
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
      abort: () => session.abort(),
      dispose: () => session.dispose(),
    };
  }
}
