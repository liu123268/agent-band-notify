# agent-band-notify

AI 任务完成、出错或需要你回答时，让手机收到通知，再由手环的配套 App 转发到手环。

适用环境：**Windows 电脑 + Android 手机 + 支持应用通知转发的手环或手表**。桌面侧使用 Node.js，运行时不需要安装第三方 npm 依赖。

```text
智能体软件的本地会话文件 / SQLite
                 ↓
         一个后台监听器
      识别状态 → 去重 → 生成摘要
                 ↓ HTTPS
              ntfy 服务
                 ↓
          Android ntfy 通知
                 ↓ 配套 App 转发
              手环 / 手表
```

它不直接连接手环蓝牙，不替代手环官方 App，也不会自动替你批准智能体的操作。

## 支持的软件

| 软件 | 完成 / 出错 | 等待回答 | 等待批准 | 数据来源 |
| --- | --- | --- | --- | --- |
| Codex | 支持 | 提问工具事件 | 审批事件 | 本地 rollout JSONL |
| DeepSeek Harness | 支持 | 会话中的提问状态 | 计划待审状态 | 本地会话快照 |
| WorkBuddy | 支持 | AskUserQuestion 事件 | 安全中心审计事件 | 会话 JSONL 与审计文件 |
| ZCode | 支持 | 回复文本规则，可能误判 | SQLite 权限记录 | 会话 JSONL 与数据库 |
| MiMo Desktop | 支持 | 问答工具 / 交互命令状态 | SQLite 权限记录 | 本地 SQLite 数据库 |

五个软件共用 **7 个数据源适配器和 1 个监听进程**。未安装的软件不会阻止其他适配器工作。适配器依赖软件的本地数据格式，软件升级后可能需要调整；它们不是上述软件提供的官方通知接口。

## 快速开始

### 1. 准备电脑

安装 [Node.js](https://nodejs.org/en/download) **22.13 或更新版本**，建议使用 Node.js 24。SQLite 适配器使用 Node 内置的 `node:sqlite`。

下载本仓库 ZIP 并解压，或使用 Git：

```powershell
git clone https://github.com/liu123268/agent-band-notify.git
cd agent-band-notify
node --version
npm run setup
```

`setup` 会从示例创建本地 `config.json`，生成随机频道名，并在终端显示。首次运行不发送通知，不修改智能体软件的配置；再次运行会保留原频道，并备份现有配置。

**记下自己生成的频道名。手机和电脑要使用同一个 ntfy 服务器与频道。** 不要使用 README 里的示例文字作为真实频道。

无需执行 `npm install`。如果终端不允许运行 `npm.ps1`，可直接使用 `npm.cmd`，或执行对应的 `node tools/...` 命令。

### 2. 配置手机和手环

1. 安装 [ntfy Android App](https://docs.ntfy.sh/subscribe/phone/)。官方提供 Google Play、F-Droid 和 GitHub APK 下载入口。
2. 添加订阅：默认服务器是 `https://ntfy.sh`，频道填写上一步生成的随机名称。
3. 允许 ntfy 显示通知，并按手机系统要求放开后台运行、电池限制和自启动权限。
4. 打开手环配套 App，在“应用通知”中允许转发 ntfy。小米设备通常通过“小米运动健康”设置，具体菜单随手机和设备版本变化。

详细步骤、手机能收到但手环不振动的排查见 [手机与手环设置](docs/phone-setup.md)。

### 3. 先测试，再启动监听

```powershell
npm run doctor
node notify.js --test --json
npm start
```

- `doctor` 检查 Node、配置、SQLite 和适配器，不发送消息。
- `notify.js --test` 发一条测试消息。输出 `ok: true` 只表示服务器接受了消息，请分别确认手机通知和手环振动。
- `npm start` 在当前窗口监听；**窗口要保持开启**，按 Ctrl+C 停止。

第一次启动只建立已有会话的基线，不会把所有历史任务发一遍。此后新发生的事件才会触发通知；监听器保存读取位置和去重记录，用于恢复。

### 4. 后台运行与开机启动（可选）

前台验证成功后，先按 Ctrl+C 关闭前台监听，再双击根目录的 **`一键启动.vbs`**。使用 **`看监听状态.vbs`** 或以下命令查看状态：

```powershell
npm run status
```

需要登录 Windows 后自动运行，可双击 **`装进任务计划程序.vbs`**，按提示完成，再在任务计划程序中核对 `band-notify-watchers` 的路径。

VBS 入口依赖 Windows Script Host / VBScript；系统禁用该组件时，使用前台命令，或按 [Windows 后台运行说明](docs/windows-startup.md) 手动创建计划任务。**计划任务和启动文件夹二选一，且同一份项目只运行一个监听器。** 从旧版本迁移时先停掉旧入口，再安装新目录的入口。

## 通知内容与设置

默认通知示例：

```text
✅ 已完成
【Codex】示例项目 · 已完成接口修改和验证

❓ 等你回答
【WorkBuddy】示例会话 · 请选择运行方式

❓ 等你批准
【MiMo】示例任务 · 需要你确认工具操作
```

编辑本地 `config.json`：

| 配置 | 用途 |
| --- | --- |
| `ntfyServer` | ntfy 服务器地址，支持自建服务器 |
| `topic` | 手机订阅的私有随机频道名称 |
| `token` | 可选的 ntfy 访问令牌 |
| `enabled` | 暂停或启用发送 |
| `minSeconds` | 最短任务时长，`0` 表示不按时长过滤 |
| `title` / `body` | 标题和正文模板 |
| `previewMax` / `conversationMax` | 摘要、会话名的最大显示长度 |
| `priority` | ntfy 优先级 `1`–`5`，默认 `4` |

常用环境变量和非默认数据目录配置见 [高级配置与接入](docs/configuration.md)。

## 常用命令

```powershell
node tools/agent-watch.js --list
node tools/agent-watch.js --status
node tools/agent-watch.js --agent codex --once --dry-run
node notify.js --title "测试提醒" --body "这是一条手动消息" --force
npm test
```

`--once --dry-run` 不发送消息，但会记录扫描状态；需要测试真实完成提醒时，请在开始监听后发起一个新任务。查看 `logs/notify.log`、`logs/agent-watch.log` 可定位发送失败或读取异常。日志、缓存、真实配置均已被 Git 忽略。

## 隐私与边界

通知摘要会发送到所选 ntfy 服务器；如果不希望外部服务看到摘要，可部署自己的 ntfy 并设置访问控制。随机频道名用于防猜测，**不是端到端加密或完整权限控制**，不要公开自己的频道和令牌。[ntfy 发布与鉴权说明](https://docs.ntfy.sh/publish/)

提醒是否及时还取决于电脑联网、手机后台限制、配套 App 和手环通知设置。任务“完成”指检测到软件轮次结束，不代表其代码已通过测试。ZCode 的文本提问识别存在误判可能，审批记录是否可见也取决于软件版本和权限模式。

自动测试覆盖合成会话、SQLite 状态、消息格式、去重、重启恢复、初始化和本地 HTTP 发送；不会替代真实手机与手环验收。手工验收步骤见手机设置文档。

## 开发与复用

运行 `npm test`，测试使用临时用户目录与本地 HTTP 接收器，不写入真实智能体配置、不向公共频道推送。没有安装相应软件时，真实日志样本检查会明确跳过。

适配器位于 `src/agents/`，共享监听引擎位于 `tools/agent-watch.js`，消息渲染和传输位于 `src/notice.js`、`src/transport.js`。旧的 `codex-watch.js` / `dsh-watch.js` 入口仅打印迁移提示并退出，避免额外启动重复监听器。

本项目采用 [MIT License](LICENSE)，允许使用、修改与分发，保留许可声明即可。
