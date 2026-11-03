# pi-telegram-gateway

[English / 完整配置与安全说明](README.md) · MIT · Node.js ≥ 22.19

通过 Telegram 私聊话题管理多个持久化 pi session。独立常驻网关，使用 pi SDK，不要求终端一直开着。参考 Hermes 的 `/topic` 与 `dm_topic_auto_transfer` 行为，不是 Hermes 分支，也不是完整功能复刻。

## 当前状态

**0.1.0 早期版本**：路由测试及真实 SDK 会话文件读写测试已通过；**尚未验收真实 Telegram 收发和模型/工具调用**。未发布 npm，请从源码安装。

## 安装

```sh
git clone https://github.com/bqingx/pi-telegram-gateway.git
cd pi-telegram-gateway
npm ci
npm link
pi-telegram-gateway init
```

1. 先配置 pi 模型及登录凭据，默认使用 `~/.pi/agent`（可用 `PI_CODING_AGENT_DIR` 指定）。
2. BotFather **Mini App → My bots → 你的 bot → Bot Settings → Threads Settings** 开启 **Threaded Mode**；需要手动创建话题时，也允许用户建话题。
3. 编辑 `~/.config/pi-telegram-gateway/config.json`：`allowedUsers` 填自己的 Telegram **数字用户 ID**，`cwd` 填工作目录，其他路径也使用绝对路径。
4. 本地编辑 `tokenFile` 指向的文件，写入 Bot Token，设置 `chmod 600`。不要将 Token 写进命令参数、代码或仓库。
5. `pi-telegram-gateway start`。可通过 `PI_TELEGRAM_CONFIG` 指定配置文件。

空白名单拒绝启动；同一个 bot 不可同时运行其他轮询网关。已有 webhook 时拒绝启动，不会擅自删除。无需开放公网端口。

## 使用

- **根私聊 / General 发普通消息**：自动创建新话题、新 session，首条消息送入该 session，回复在新话题中。
- **话题内发消息**：继续绑定的 session；未绑定的话题自动分配新 session。
- **根私聊发命令**：不创建话题。
- `/topic`：查看当前绑定；在根私聊中显示会话列表。
- `/topic <session-id>`：切换到同用户、同聊天的旧会话，重放最近一条助手文本。
- `/sessions [页码]`：查看自己的会话，每页 10 条。
- `/new`：当前话题开启新会话，旧会话保留。
- `/status`：会话及运行状态。
- `/stop`：中止本话题任务，**不会撤销已经执行的工具操作**。
- `/help`：帮助。

一个 session 不能同时绑定两个话题；可先在原话题 `/new`，释放旧绑定。运行中的会话禁止切换；忙碌时新消息明确拒绝、不排队。不同话题可以并行，默认最多 4 个，但共享工作目录与系统账户，**并非文件系统隔离**。不自动导入本机其他 CLI 会话。

当前话题标题取首条消息前 80 个字符；只转发最终助手文本，长消息自动分段，不转发思考、工具日志和原始异常。不支持图片、语音、文件、流式编辑及任意 pi 终端交互命令。SDK 默认加载工作目录指令、技能、扩展，但不自动安装 CLI 特有的 MCP/codemode 内置扩展。

## 持久化及故障

`dataDir/state.json` 保存 bot 身份、话题绑定、所属用户、轮询 offset 和最近任务状态；`dataDir/sessions/` 保存真实 pi JSONL 会话。应一起备份，文件可能包含敏感工具输出。

为了避免崩溃后重复执行交易等副作用，**先落盘更新接收位置，再处理消息**；不是严格恰好一次执行。崩溃可能丢失已接收但未完成的任务、留下空话题或部分操作，不会自动重放指令。重启时尽力通知中断任务。回复发送失败可能部分送达，可以绑定同一 session 重放最后文本，不要盲目重复交易指令。

离线期间尚未接收的 Telegram 消息会在启动后处理；发送时效性指令时要注意。建话题失败直接报错，不会串到其他话题。

独占锁为 `dataDir/gateway.lock`。正常退出自动释放；强制崩溃后须检查其中 `pid`，确认没有活跃进程，才能手动删除。不得删除仍在运行的锁；不同服务器间无法靠此锁检测重复 bot。

## 安全边界

**白名单用户可以通过 pi 使用网关系统账户的权限**，包括 shell、文件、网络以及本地配置的钱包工具。白名单不是沙箱、交易审核或额度限制。只添加完全信任的人；分享部署时使用独立非 root 用户、受限容器/工作目录/模型配置。Telegram bot 聊天不是端到端加密。

不接收群聊、编辑消息及 bot 消息；陌生用户不会自动注册。程序不主动输出 Token URL、内部工具日志及原始异常，但模型回复本身仍可能泄露敏感内容。金融类工具应另外配置并验证无界面的严格权限策略，网关本身不提供钱包授权政策。

## 开发

```sh
npm ci
npm test
npm run check
npm audit
```

[systemd 模板](examples/pi-telegram-gateway.service) 需自行修改用户名、安装路径与配置路径；不会自动安装或启动服务。完整限制和恢复语义见 [英文文档](README.md)。
