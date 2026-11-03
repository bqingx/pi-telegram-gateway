import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export class State {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.file = join(dir, 'state.json');
    try { this.data = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.data = { version: 1, offset: 0, sessions: {}, bindings: {}, jobs: {} };
    }
    if (this.data.version !== 1) throw new Error('Unsupported state version');
  }
  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const parent = openSync(join(this.file, '..'), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  language(user) { return this.data.languages?.[String(user)] === 'en' ? 'en' : 'zh'; }
  setLanguage(user, language) {
    if (!['zh', 'en'].includes(language)) throw new Error('Unsupported language');
    this.data.languages ??= {};
    this.data.languages[String(user)] = language;
    this.save();
  }
  key(chat, thread) { return `${chat}:${thread}`; }
  current(chat, thread) {
    return this.data.sessions[this.data.bindings[this.key(chat, thread)]];
  }
  assertBindable(chat, thread, id, user) {
    const target = this.data.sessions[id];
    if (!target || target.user !== user || target.chat !== chat) throw new Error('Session not available to this user/chat');
    const key = this.key(chat, thread);
    if (Object.entries(this.data.bindings).some(([k, v]) => v === id && k !== key)) {
      throw new Error('Session already bound to another topic');
    }
    return key;
  }
  bind(chat, thread, id, user) {
    const key = this.assertBindable(chat, thread, id, user);
    this.data.bindings[key] = id;
    this.save();
  }
}
