import { canonicalSession, SessionLease } from './session-lock.js';

// Loaded only by pi-shared, with the parent holding the lock before pi starts.
// No process/timer resources are started from this extension factory.
export default function localGuard(pi) {
  const file = process.env.PI_SHARED_SESSION_FILE, token = process.env.PI_SHARED_SESSION_TOKEN;
  const valid = ctx => {
    try { return file && token && canonicalSession(ctx.sessionManager.getSessionFile()) === canonicalSession(file) && SessionLease.verify(file, token); }
    catch { return false; }
  };
  pi.on('session_start', (_event, ctx) => {
    if (!valid(ctx)) {
      ctx.ui.notify('Shared session lock missing. Exit and reopen with pi-shared.', 'error');
      ctx.abort(); ctx.shutdown();
    } else ctx.ui.setStatus('pi-shared', 'Shared session: local exclusive');
  });
  const cancelSwitch = (_event, ctx) => {
    ctx.ui.notify('Exit this window (or /shared-release), then use pi-shared to select/create a session. In-process switching/forking is disabled to preserve the lock.', 'warning');
    return { cancel: true };
  };
  pi.on('session_before_switch', cancelSwitch);
  pi.on('session_before_fork', cancelSwitch);
  pi.on('input', (_event, ctx) => {
    if (valid(ctx)) return { action: 'continue' };
    ctx.ui.notify('Shared lock lost: refusing input.', 'error');
    return { action: 'handled' };
  });
  pi.on('tool_call', (_event, ctx) => valid(ctx) ? undefined : { block: true, terminate: true, reason: 'Shared session lock lost' });
  pi.on('before_provider_request', (_event, ctx) => { if (!valid(ctx)) ctx.abort(); });
  pi.registerCommand('shared-release', {
    description: 'Exit this local session and release it for Telegram',
    handler: async (_args, ctx) => { ctx.shutdown(); },
  });
}
