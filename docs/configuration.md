# 高级配置与接入

## 配置优先级

文件按以下顺序查找：CLI 的 `--config` / `BAND_NOTIFY_CONFIG` 指定文件 → 项目根目录 `config.json` → 用户目录 `.band-notify/config.json` → 内置默认值。下面的环境变量覆盖文件值，即使还没有创建配置文件也可使用。

| 环境变量 | 配置 |
| --- | --- |
| `BAND_NOTIFY_CONFIG` | 指定配置文件绝对路径 |
| `BAND_NOTIFY_TOPIC` | 频道名称 |
| `BAND_NOTIFY_SERVER` | ntfy 服务器地址 |
| `BAND_NOTIFY_TOKEN` | 访问令牌 |
| `BAND_NOTIFY_MIN_SECONDS` | 最短任务秒数 |
| `BAND_NOTIFY_ENABLED` | `0` 暂停发送，`1` 启用 |
| `BAND_NOTIFY_SKIP` | `1` 跳过普通发送，显式测试或 `--force` 可覆盖 |

例如 PowerShell：

```powershell
$env:BAND_NOTIFY_CONFIG = 'C:\tools\agent-band-notify\config.json'
node tools/agent-watch.js
```

示例路径需要换成你自己的项目路径。不要把真实 topic、token 或配置文件提交到 Git。

## 自建服务器

```powershell
node tools/setup.js --server https://notify.example.com
```

如果服务器要求鉴权，将访问令牌放入自己的 `config.json` 的 `token` 字段，或设置 `BAND_NOTIFY_TOKEN`。发布使用 JSON API，消息包含 `topic`、`title`、`message`、`priority` 和 `tags`，令牌通过 `Authorization: Bearer ...` 发送。手机订阅端也需要相应权限。

## 数据目录

默认使用当前用户目录。软件运行在自定义位置时，可在启动监听器前覆盖：

| 环境变量 | 含义 |
| --- | --- |
| `BAND_NOTIFY_CODEX_DIR` | Codex sessions 目录 |
| `BAND_NOTIFY_CODEX_SOURCES` | 额外允许的 Codex 来源类型，按实现使用逗号分隔 |
| `BAND_NOTIFY_SESSION_DIR` | DeepSeek Harness 会话目录 |
| `BAND_NOTIFY_WORKBUDDY_DIR` | WorkBuddy projects 目录 |
| `BAND_NOTIFY_MIMO_DB` | MiMo 数据库文件 |
| `BAND_NOTIFY_ZCODE_DB` | ZCode 权限数据库文件 |

其他适配器的默认路径见 `src/agents/` 中相应文件。状态命令会显示实际扫描位置。环境变量必须设置在启动监听器的进程环境中；已经启动的进程不会自动继承后来修改的环境变量。

SQLite 以只读方式访问。不要复制或公开自己的会话数据库来演示使用方式。

## 接入其他软件

最简单的方式是在目标软件支持的完成回调中运行：

```powershell
node notify.js --title "任务完成" --body "示例软件完成了任务" --force
```

实际接入时使用项目内 `notify.js` 的绝对路径，避免依赖回调的工作目录。通知命令采用失败不阻断调用方的退出策略；自动检查发送结果时应读取 `--json` 输出中的 `ok`，不能只判断进程退出码。

内置五个软件已由统一监听器负责，不需要另行给 Codex 配置 `notify`、给 DSH 添加 Stop 钩子，或同时启动旧监听脚本，否则可能重复提醒。`setup --codex` 明确拒绝修改 Codex 配置。

需要新增文件适配器时，可实现 `src/agents/` 的适配器契约，或通过 `BAND_NOTIFY_AGENT_MODULE` 加载外部模块。公共引擎负责轮询、读取位置持久化、去重和消息发送；适配器负责数据目录、事件结束条件和状态判定。

## 模板与日志

模板支持 `{stateEmoji}`、`{stateLabel}`、`{software}`、`{conversation}`、`{summary}` 等字段，默认显示软件、会话名与摘要。

`logs/` 保存运行日志、心跳、已读位置和去重状态。正常运行日志按大小轮转；删除状态文件会重新建立基线，不是修复所有漏报问题的通用办法。公开日志前需要脱敏消息正文和频道信息。

## 更新

停止旧监听 → 保存自己的 `config.json` 与必要状态 → 更新代码 → 运行 `npm test` → 运行状态检查 → 启动一套监听。移动项目后要重新注册指向新目录的计划任务，不要同时保留旧目录和新目录的自启入口。
