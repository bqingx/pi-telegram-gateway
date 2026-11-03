import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class PiBackend {
  constructor(cwd, dataDir) { this.cwd = cwd; this.dir = join(dataDir, 'sessions'); }
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
    const { createAgentSession, SessionManager } = await this.sdk();
    const manager = SessionManager.open(record.file, this.dir);
    if (manager.getSessionId() !== record.id) throw new Error('Session ID mismatch');
    const { session } = await createAgentSession({ cwd: this.cwd, sessionManager: manager });
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
      last: () => session.getLastAssistantText(),
      abort: () => session.abort(),
      dispose: () => session.dispose(),
    };
  }
}
