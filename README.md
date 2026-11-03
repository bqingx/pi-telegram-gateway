# pi-telegram-gateway

[中文](README.zh-CN.md) · MIT · Node.js ≥ 22.19

A standalone Telegram gateway for [pi](https://github.com/earendil-works/pi). Inspired by Hermes' [multi-session DM mode](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram#multi-session-dm-mode-topic), implemented using the pi SDK. Not a Hermes fork or an in-terminal pi extension.

**Root DM message → new private topic → new persistent pi session.** Continue inside that topic, or restore another session with `/topic <session-id>`.

## Status

Early **0.1.0** implementation. Automated fake-Telegram routing tests and a real SDK session-storage smoke test pass. **Live Telegram delivery and a real model/tool turn have not yet been verified.** No npm release has been published; install from source for now. This is not full Hermes feature parity.

## Install

```sh
git clone https://github.com/bqingx/pi-telegram-gateway.git
cd pi-telegram-gateway
npm ci
npm link
pi-telegram-gateway init
```

Configure pi's model/authentication first using your existing pi profile (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). The gateway uses SDK 1.5.0, the existing pi settings, skills, discovered extensions and the configured workspace's AGENTS.md. SDK defaults are **not** identical to the CLI: CLI-only built-ins such as MCP/codemode are not installed by this gateway.

In **BotFather Mini App → My bots → your bot → Bot Settings → Threads Settings**, enable **Threaded Mode**. Allow user-created topics too if you want to create them manually. Do not run another poller for the same token. An existing webhook is detected and **not** silently deleted.

Edit `~/.config/pi-telegram-gateway/config.json`:

```json
{
  "tokenFile": "/home/alice/.config/pi-telegram-gateway/bot-token",
  "allowedUsers": [123456789],
  "cwd": "/home/alice/workspace",
  "dataDir": "/home/alice/.local/share/pi-telegram-gateway",
  "maxActive": 4
}
```

All paths must be absolute. `allowedUsers` contains **numeric Telegram user IDs**, not usernames. An empty allowlist refuses startup. Write the Bot Token into `tokenFile` using a local editor (not a shell command containing the token), then `chmod 600` that file. Do not commit credentials. Set `PI_TELEGRAM_CONFIG` to use a different config path.

```sh
pi-telegram-gateway start
```

No public port or webhook is needed. Model calls can incur your provider's normal costs. `maxActive` limits parallel sessions to 1–32 (default 4).

## Behavior / commands

| Action | Result |
|---|---|
| Plain text in root DM / General | Create a new topic and session, answer there |
| Plain text in a topic | Continue that topic's session; bind a new one if needed |
| `/help`, `/start` | Help; never creates a topic |
| `/topic` | Topic: current binding. Root: session list |
| `/topic <session-id>` | Restore a session in this topic; replay its latest assistant text |
| `/sessions [page]` | List this user's gateway sessions in this chat (10/page) |
| `/new` | Fresh session in the same topic; retain old session |
| `/status` | Binding and in-process running/idle state |
| `/stop` | Abort this topic's run; does not undo tool effects |

A session already bound to another topic cannot be restored here. Use `/new` there first to release its old binding. Sessions are scoped to this gateway's bot, chat and user; arbitrary local session paths cannot be opened remotely. Existing CLI sessions are **not** imported automatically.

Independent topics can run concurrently, but they share the workspace and OS account: this is conversation isolation, **not filesystem/process isolation**. A busy topic rejects additional prompts (no silent queue) and refuses `/new` or session switching until idle. Polling stays responsive while the model works. Commands are handled by the gateway; arbitrary pi UI slash commands are not forwarded.

Topic names use the first prompt's first 80 characters, not a separate title-generation model call. Initial output is final assistant text, split into Telegram-safe plain-text chunks; reasoning, tool calls, tool output and raw exceptions are not forwarded.

## Persistence and failure semantics

- `dataDir/state.json` stores bot ID, allowlisted-user ownership, topic bindings, session index, polling offset and last job status. Real pi JSONL histories live in `dataDir/sessions/`. Back up **both** together.
- State snapshots use atomic rename + fsync, files are mode 600, state directories mode 700. Session files may contain sensitive tool output.
- An update offset is persisted **before** effects. This intentionally favors **at-most-once admission**, not exactly-once execution. A crash can lose admitted work, orphan a topic or leave a partial operation; it will not blindly replay a possibly side-effecting instruction.
- Interrupted runs get a best-effort restart warning, never automatic tool replay. Delivery errors may leave partial replies; restore the same session to replay its latest assistant text without rerunning the instruction.
- Pending Telegram messages not previously admitted are consumed on startup, including messages sent while offline. Be aware of this before sending time-sensitive instructions.
- If topic creation fails, report failure rather than silently route into an unrelated topic. No automatic retries of mutating Telegram calls.
- An exclusive `dataDir/gateway.lock` prevents two local processes using the same state. After a hard crash, inspect its `pid`, verify that no gateway still runs, and only then remove the stale directory. Never auto-remove a live lock. Locks do not detect another host using the same bot token.
- After graceful shutdown there is no poller; systemd may restart a failed process, but never resumes interrupted tool execution.

## Security

**An allowlisted Telegram user can control a pi agent with the gateway OS user's permissions**, including shell commands, files, network and any locally configured wallet credentials. Only allow fully trusted administrators; a user allowlist is not a sandbox, transaction approval system, or spending limit. Use a dedicated non-root account/container and a restricted workspace/profile for public or shared deployments. Telegram bots are not end-to-end encrypted.

Only private messages from the numeric allowlist are admitted; groups, edits and bots are ignored. Do not allow an unknown user to enroll simply by messaging first. Bot token URLs, raw provider errors and internal tool logs are not intentionally logged/sent, but model replies themselves can contain sensitive content: review the workspace/profile you expose. No telemetric service or extra API credentials are required.

Before using financial tools, install your own fail-closed policy/approval extensions and verify them headlessly. The gateway itself does **not** enforce the operator's wallet policies.

## Development

```sh
npm ci
npm test
npm run check
npm audit
npm pack --dry-run
```

See [systemd example](examples/pi-telegram-gateway.service). Configure its dedicated user, paths and environment before installation; no service is installed automatically.

### Not yet supported

Images/audio/files, streaming edits, typing indicators, inline session pickers, automatic CLI session import, full Hermes commands, tool approval buttons, remote pi UI dialogs, durable outbound delivery queues, and LLM-generated topic titles. First verify live Telegram and model behavior before relying on this for unattended work.
