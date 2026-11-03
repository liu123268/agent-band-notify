'use strict';
/**
 * ZCode · 「等你批准」适配器 —— ZCode 的第二个数据源
 * ================================================
 *
 * 和 WorkBuddy 一样，ZCode 也把「现在卡在人身上」写在**两个互不相干**的地方：
 *
 *   1. 文本事件日志  ~/.zcode/cli/log/zcode-*.jsonl
 *      → src/agents/zcode.js        （轮次结束、以及从结尾文字猜出来的提问）
 *   2. SQLite 库     ~/.zcode/cli/db/db.sqlite  →  表 permission
 *      → 本文件                      （权限询问：此刻正等你点「允许 / 拒绝」）
 *
 * ⚠️ 这不是「ZCode 的第二个所有者」。铁律管的是"两个适配器读**同一份**文件"；这两个
 * 读的东西**完全不相交**（jsonl 文本 vs SQLite 库），去重键命名空间也不同
 * （`zcode#` vs `zcode-approval#`）。没有任何东西被读两遍，也就不可能发两遍。
 *
 * 为什么需要它：`zcode.js` 只能看**对话文本**，而"被弹窗要求批准"这件事**根本写不进
 * 对话文本**（那段时间里对话是静止的）——所以它永远看不见这类事件。这与 WorkBuddy
 * 16:03:43 那次漏报是同一个形状：一本账不提，另一本用一等字段记着。
 *
 * 依据（都来自程序本体，不是推测）
 * ------------------------------
 * 程序：`…/AppData/Local/Programs/ZCode/resources/app.asar`
 *   事件枚举里有：permission.requested / permission.resolved /
 *                 userInput.requested / userInput.resolved
 *   `permission.lifecycle` 的 zod schema：
 *     { kind: "permission.lifecycle", phase: ["requested","resolved","denied"],
 *       requestId: string, toolCallId: string, toolName?: string }
 *   请求 payload：{ requestId, toolCallId, toolName, reason, riskLevel }
 *   UI 动作：{ type: "permission.respond" }
 * 因而 `reason` 是引擎自带的**人类可读理由**，正好当通知正文。
 *
 * ⚠️ 本机 0 行：`permission` 表结构存在（project_id / time_created / time_updated / data）
 * 但为空，且完整文本日志 3982 条事件里只有 1 条 `permission.resolved`（"已裁决"，
 * 结果而非询问）。**真机 0 次触发**，与 Codex 的审批分支同类：结构确证、无法证伪。
 *
 * 顺带纠正一条旧笔记：早先记的"ZCode 不记录 pending 询问"，依据是"真实数据里查不到"。
 * 那个推理不成立 —— 查不到只能说明没发生，不能说明不存在。结构在程序本体里。
 *
 * 依赖：`node:sqlite`（Node 22 内置模块，非第三方）。详见 opencode-permissions.js。
 */
const os = require('os');
const path = require('path');
const { createAdapter } = require('./opencode-permissions');

const DB_PATH =
  process.env.BAND_NOTIFY_ZCODE_DB ||
  path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

module.exports = createAdapter({
  id: 'zcode-approval',
  label: 'ZCode',
  dbPath: DB_PATH,
  envVar: 'BAND_NOTIFY_ZCODE_DB',
  dbFileName: 'db.sqlite',
});
