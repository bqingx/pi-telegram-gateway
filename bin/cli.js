#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { State } from '../src/state.js';
import { Telegram } from '../src/telegram.js';
import { PiBackend } from '../src/pi.js';
import { Gateway } from '../src/gateway.js';

process.umask(0o077);
const configPath = resolve(process.env.PI_TELEGRAM_CONFIG || join(homedir(), '.config/pi-telegram-gateway/config.json'));
if (process.argv[2] === 'init') {
  mkdirSync(resolve(configPath, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify({
    tokenFile: join(homedir(), '.config/pi-telegram-gateway/bot-token'),
    allowedUsers: [], cwd: process.cwd(),
    dataDir: join(homedir(), '.local/share/pi-telegram-gateway'), maxActive: 4, sharedSessionOwner: null,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Created ${configPath}. Fill allowedUsers and write the token to tokenFile (mode 600).`);
} else if (process.argv[2] && process.argv[2] !== 'start') {
  console.log('Usage: pi-telegram-gateway [init|start]\nConfig path: PI_TELEGRAM_CONFIG or ~/.config/pi-telegram-gateway/config.json');
  process.exitCode = 1;
} else {
  await main().catch(() => {
    // SDK/provider failures may contain credentials; never dump raw exceptions.
    console.error('Gateway failed. Check config, credentials, pi installation, and the exclusive data-directory lock. Raw errors are suppressed to protect secrets.');
    process.exitCode = 1;
  });
}

async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.allowedUsers) || !config.allowedUsers.length ||
    config.allowedUsers.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid allowlist');
  if (!Number.isInteger(config.maxActive ?? 4) || (config.maxActive ?? 4) < 1 || (config.maxActive ?? 4) > 32) throw new Error('Invalid maxActive');
  for (const key of ['cwd', 'dataDir', 'tokenFile']) {
    if (typeof config[key] !== 'string' || !config[key].startsWith('/')) throw new Error('Paths must be absolute');
  }
  if (config.sharedSessionOwner != null && (!Number.isSafeInteger(config.sharedSessionOwner) || !config.allowedUsers.includes(config.sharedSessionOwner))) throw new Error('Shared session owner must be allowlisted');
  const token = readFileSync(config.tokenFile, 'utf8').trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid token');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const lock = join(config.dataDir, 'gateway.lock');
  mkdirSync(lock, { mode: 0o700 }); // Exclusive; stale locks require explicit operator intervention.
  writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  let gateway;
  const controller = new AbortController();
  let stopping = false;
  const stop = () => { stopping = true; controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const state = new State(config.dataDir), telegram = new Telegram(token);
    const me = await telegram.call('getMe');
    if (!me.has_topics_enabled) throw new Error('Enable Threaded Mode in BotFather');
    if (state.data.botId && state.data.botId !== me.id) throw new Error('Data directory belongs to another bot');
    state.data.botId = me.id;
    state.save();
    const webhook = await telegram.call('getWebhookInfo');
    if (webhook.url) throw new Error('Webhook configured: remove it explicitly before polling');
    gateway = new Gateway({ state, telegram, backend: new PiBackend(config.cwd, config.dataDir, { sharedSessions: config.sharedSessionOwner != null }),
      allowedUsers: config.allowedUsers, maxActive: config.maxActive ?? 4, sharedSessionOwner: config.sharedSessionOwner });
    await telegram.registerCommands();
    for (const [user, language] of Object.entries(state.data.languages || {})) {
      if (!config.allowedUsers.includes(Number(user))) continue;
      await telegram.registerCommands(language === 'en' ? 'en' : 'zh', Number(user))
        .catch(() => console.error('Per-user command menu refresh failed; select /language to retry.'));
    }
    await gateway.recover();
    console.log('Gateway ready (private topics; allowlist enforced).');
    let failures = 0;
    while (!stopping) {
      let updates;
      try {
        updates = await telegram.call('getUpdates', { offset: state.data.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, controller.signal);
        failures = 0;
      } catch {
        if (stopping) break;
        console.error('Polling failed; retrying with bounded backoff.');
        await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5))));
        continue;
      }
      for (const update of updates) {
        if (stopping) break;
        if (update.update_id < state.data.offset) continue;
        // Durable admission BEFORE effects: crash recovery never blindly reruns tools.
        // This is at-most-once admission, not exactly-once processing/delivery.
        state.data.offset = update.update_id + 1;
        state.save();
        try { await gateway.handle(update); }
        catch {
          console.error('Update failed after admission; not automatically replayed.');
          const m = update.message;
          if (m?.chat?.type === 'private' && config.allowedUsers.includes(m.from?.id)) {
            await telegram.send(m.chat.id, m.message_thread_id === 1 ? undefined : m.message_thread_id,
              gateway.t(m.from.id, 'updateFailed')).catch(() => {});
          }
        }
      }
    }
  } finally {
    await gateway?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    rmSync(lock, { recursive: true });
  }
}
