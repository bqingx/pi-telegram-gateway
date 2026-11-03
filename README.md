# pi-telegram-gateway

[中文](README.zh-CN.md) · MIT · Node.js ≥ 22.19

A standalone Telegram gateway for [pi](https://github.com/earendil-works/pi). Inspired by Hermes' [multi-session DM mode](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram#multi-session-dm-mode-topic), implemented using the pi SDK. Not a Hermes fork or an in-terminal pi extension.

**Root DM message → new private topic → new persistent pi session.** Continue inside that topic, or restore another session with `/topic <session-id>`.

## Status

Early **0.5.0** implementation. Automated fake-Telegram routing/inline-picker tests and real SDK storage/model/thinking persistence tests pass. **Live Telegram delivery and a real model/tool turn have not yet been verified.** No npm release has been published; install from source for now. This is not full Hermes feature parity.

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
  "maxActive": 4,
  "sharedSessionOwner": null
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
| `/help`, `/start` | Help and settings buttons if a session is bound; never creates a topic |
| `/menu` | Current model/thinking and inline settings buttons |
| `/model`, `/models` | Provider → paginated models → confirmation buttons |
| `/thinking`, `/reasoning` | Supported reasoning-effort buttons (current level marked ✓) |
| `/language`, `/lang` | Chinese / English interface-language buttons; no session needed |
| `/topic` | Topic: current binding. Root: session list |
| `/topic <session-id>` | Restore a session in this topic; replay its latest assistant text |
| `/sessions [page]` | List this user's gateway sessions in this chat (10/page) |
| `/new` | Fresh session in the same topic; retain old session |
| `/status` | Binding and in-process running/idle state |
| `/stop` | Abort this topic's run; does not undo tool effects |

### Interface language

The gateway's Telegram interface defaults to **Chinese**, independently of Telegram's client language. Choose **切换语言** from the bot's command menu, or tap **语言** in session settings (`/menu`), to select **中文 / English**. `/language` and `/lang` also open the buttons. Root DMs, unbound topics and busy sessions can change language without opening pi or making a model request.

The preference is persisted per numeric Telegram user in `state.json` (`languages`) and applies across their topics, including after restart. Help, command descriptions, session/status labels, model/thinking menus, confirmations, callback toasts, errors and restart warnings follow that user's selection. Command descriptions use a **chat-scoped override**, not a global language change for other users. If updating Telegram's command menu fails, the preference remains saved and a localized warning asks you to select it again to retry. Selecting a language invalidates that user's older settings buttons.

Command names (Telegram requires Latin command identifiers), model/provider IDs, user-authored titles/messages and actual assistant responses are not automatically translated or rewritten. Switching UI language does not alter model settings, session contents or ask the model to translate existing messages. Previously sent messages stay in their original language; open a fresh menu to see the new language.

### Button-based model and reasoning settings

On startup the gateway registers Telegram's built-in **command menu** and sets the chat menu button to commands. Pick **menu**, **model** or **thinking** from that menu without typing model names/IDs or effort values. Inside a topic, `/menu` also opens inline **模型 / 推理强度** buttons (or **Model / Thinking** after selecting English). Use `/new` or send a message first if the topic has no session.

The model picker lists only providers/models currently available through the pi SDK (including configured compatible endpoints), offers pagination/back/close buttons and marks the current selection. Choosing a model opens a confirmation showing catalog token prices when available and a reminder that future prompts send this conversation's context to the chosen provider. This is an estimate, not a billing guarantee; switching alone sends no model prompt. Actual provider availability, quota and pricing can still change.

Thinking choices come from `getAvailableThinkingLevels()` rather than a hardcoded list; the provider may further clamp them. A nonreasoning model reports that reasoning is not adjustable. Model switches can reset/clamp effort, and the success message shows the actual SDK value.

Changes are persisted **only to the current session**, not global pi defaults or other topics. Empty `/new` sessions restore their choice too. An unavailable saved model fails closed rather than silently submitting to a fallback provider; restore its local pi configuration/credentials before continuing.

Pickers are bound to their requesting user, chat, topic, message and session. They expire after ten minutes, after a new prompt/session switch, or on restart; older pages cannot apply a stale selection. Open a fresh menu if settings changed elsewhere. Running sessions reject settings changes. `callback_query` updates are authenticated independently, and confirmation/error messages never include raw SDK exceptions. Do not run another service that overwrites this bot's command menu.

A session already bound to another topic cannot be restored here. Use `/new` there first to release its old binding. Sessions are scoped to this gateway's bot, chat and user; arbitrary local session paths cannot be opened remotely. By default CLI sessions stay separate. Enable the explicit single-owner shared mode below to discover and use native session files.

Independent topics can run concurrently, but they share the workspace and OS account: this is conversation isolation, **not filesystem/process isolation**. A busy topic rejects additional prompts (no silent queue) and refuses `/new` or session switching until idle. Polling stays responsive while the model works. Commands are handled by the gateway; arbitrary pi UI slash commands are not forwarded.

Accepted text prompts immediately start a Telegram **typing** indicator, refreshed every four seconds while pi initializes, reasons or runs tools. Root-DM typing moves to the new topic after creation. Completion, failure, `/stop` and shutdown cancel the refresh and any in-flight status request; Telegram clears it on reply or after its approximately five-second expiry (there is no explicit stop-typing API). Status requests never block or retry the model run, use short timeouts, and back off per chat on failure/`retry_after`. If Telegram rejects topic-scoped typing with API 400, it falls back to the DM view, like Hermes. Typing is best-effort activity feedback, not a permanent online indicator.

New topics start with a short local placeholder, then the first real prompt generates one concise title (at most 24 Unicode characters) using the session's selected model. The **same title** names the Telegram topic and native pi session (`session_info`). `/new` defers this until its first message. The separate, tool-free title request contains only a sanitized, bounded first message (at most 2000 characters), is limited to 128 output tokens / approximately six seconds, and records returned usage as a `title` usage entry. It costs an additional short model request and can consume subscription quota; it is not free by assumption. It does not enter conversation history or execute tools. Failure/empty output uses a local short-title fallback; Telegram/filesystem name-sync failures are reported without repeating the user's prompt. Existing sessions are not retroactively auto-titled.

When an authorized user **edits a bound topic's name in Telegram**, the session name follows and the bot explicitly confirms it. This metadata-only operation makes no model request. A manual name is not truncated to the automatic 24-character limit. Manual renames take priority over a pending automatic title. Bot echoes, icon-only edits and unbound/unauthorized topic edits are ignored. If the native session is occupied, the pending name is persisted and a localized notice explains it is not yet synchronized; a two-second reconciler applies the latest pending name when the lock is released, then confirms success. Pending metadata can resume after gateway restart, without replaying any prompt or tools, and is discarded if that session is no longer bound to the original topic. A Telegram topic rename is one-way metadata sync; native-side renames do not automatically rename Telegram topics.

Initial output is final assistant text, split into Telegram-safe plain-text chunks; reasoning, tool calls, tool output and raw exceptions are not forwarded.

## Shared Telegram / local sessions (opt-in)

Set `sharedSessionOwner` in the config to **one allowlisted numeric Telegram user ID**, then restart the gateway. Native pi session metadata from the current profile becomes visible in that user's `/sessions` list, with occupation/enrollment labels; it is not exposed to other allowlisted Telegram users. This is an explicit grant of access to that OS user's local conversation history. No transcript is copied: the gateway uses the **same original JSONL and original workspace**, and reloads it on every operation. New Telegram sessions are written to native pi's session directory. Earlier gateway sessions stay at their original paths and are also discoverable by `pi-shared`.

Use the installed `pi-shared` entry point on the local side:

```sh
pi-shared --list
# For an existing ordinary pi session, CLOSE ALL ordinary pi windows using it,
# then explicitly enroll and open it with the guarded launcher:
pi-shared --enroll <session-id>
# Subsequently:
pi-shared --session <session-id>
pi-shared --new
pi-shared                        # interactive session chooser
```

A previously unguarded local session is listed as **unmanaged** and **cannot be opened by Telegram** until you deliberately enroll it. This prevents the gateway silently taking over one of your already-open ordinary pi windows. Gateway-created sessions in shared mode are enrolled automatically. Enrolling is your acknowledgement that no unguarded writer is still using that file; the launcher cannot discover arbitrary existing pi writers reliably.

**Exclusive use, not live mirroring:** `pi-shared` acquires a sidecar directory lock **before starting pi**, holds it while the entire local window is open (even idle), and releases it only when the child exits. `/shared-release` exits that local window after pi settles. Local in-process `/resume`, `/new`, `/fork` and `/clone` are cancelled by the injected guard; exit and run `pi-shared` again to switch/create sessions. Reloading the same session is allowed. Use a pi CLI compatible with the pinned SDK (currently 1.5.0).

Telegram acquires the same canonical-path lock **before the SDK opens or migrates a session** and holds it until that operation's SDK is disposed. While pi is generating, executing tools, restoring, or editing settings, local open fails. Once a Telegram operation is idle, the local launcher may acquire the session even while its topic remains bound. While the local window is open, new Telegram prompts/settings/restores refuse with an occupied message; they are not queued, replayed or forced. On local exit the next Telegram operation reloads the latest history/model/thinking from disk. Different sessions remain usable concurrently.

**This is a cooperative lock, not an OS sandbox.** Opening the file using ordinary `pi`, disabling/bypassing the guard, manually deleting a live lock, using hard-link aliases, or editing JSONL directly can bypass it. There is no honest guarantee against an unmodified external writer that ignores locks; every shared local session must use `pi-shared`. Current ordinary pi windows do not gain protection automatically. No forced takeover or automatic stale-lock eviction is implemented.

Sidecars are `<session.jsonl>.pi-shared.json` (enrollment) and `<session.jsonl>.pi-shared-lock/owner.json` (channel, PID, host, private nonce). After a crash, check the recorded host, parent **and child** processes, and all possible session users before manually removing a stale lock. Locks with missing/ambiguous owner records also fail closed. Never delete a live lock or use enrollment to override one.

## Persistence and failure semantics

- `dataDir/state.json` stores bot ID, allowlisted-user ownership, topic bindings, session index, polling offset and last job status. Legacy/private pi JSONL histories live in `dataDir/sessions/`; shared mode also references original files in pi's native session directories. Back up the state, all referenced session files and enrollment sidecars together.
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

Images/audio/files, streaming edits, inline session pickers, unguarded ordinary-pi shared access, full Hermes commands, tool approval buttons, remote pi UI dialogs, durable outbound delivery queues, and native-to-Telegram title synchronization. First verify live Telegram and model behavior before relying on this for unattended work.
