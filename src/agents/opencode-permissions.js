'use strict';
/**
 * opencode 系谱的「等你批准」读取器 —— ZCode 与 MiMo 共用
 * ======================================================
 *
 * 为什么有了这个文件
 * ----------------
 * 2026-10-09 之前，ZCode 与 MiMo 的「等你批准」被判为**做不到**。依据是"本机真实数据里
 * 找不到任何 pending 的痕迹"：
 *
 *   ZCode: tool_usage.approval_status 取值 4626/4626 == "none"；permission 表 0 行
 *   MiMo : permission 表 0 行；permission_grant 表 0 行
 *
 * 这个推理有一个洞：**"本机没发生过"不等于"软件不记录"**。拿同一把尺子量一下 Codex
 * 就看得出来 —— Codex 的审批分支在本机也是 0 次触发（`approvals_reviewer:"auto_review"`，
 * 审批由 Codex 自己的审查器做），但它的字段**结构真实存在**（取自官方 protocol.rs），
 * 所以那个分支是"前瞻实现"，不是"不存在"。
 *
 * 于是改用**搜程序本体**（DSH 的关键证据就只在 app.asar 里）。结果两个都能做：
 *
 *   ZCode  …/Programs/ZCode/resources/app.asar
 *     事件枚举里明确有：permission.requested / permission.resolved /
 *                       userInput.requested / userInput.resolved
 *     `permission.lifecycle` 的 zod schema：
 *       { kind: "permission.lifecycle", phase: ["requested","resolved","denied"],
 *         requestId, toolCallId, toolName }
 *     请求 payload：{ requestId, toolCallId, toolName, reason, riskLevel }
 *     UI 动作：{ type: "permission.respond" }
 *
 *   MiMo  …/node_modules/@mimo-ai/mimocode-windows-x64/bin/mimo.exe
 *     permission.asked / permission.replied / permission.reply
 *     permission.allowOnce / permission.allowAlways / permission.deny
 *     payload：{ properties: { sessionID, … } }，且代码里维护**每会话的待处理队列**
 *     （`A.permission[sessionID]`）。另有 `dangerously-skip-permissions` 开关。
 *
 * 两者的 SQLite 里 `permission` 表结构一致：project_id / time_created / time_updated /
 * data（JSON）。**表存在 = 存储机制存在**；本机 0 行只说明"至今没被问过"。
 *
 * 所以它们和 Codex 是同一类：**结构已确证、真机 0 触发**。诚实标注见 README。
 *
 * 读什么
 * ------
 * `permission` 表。**有行 = 此刻有人在等你点头**。opencode 把待裁决的权限请求写在这里，
 * 裁决后清掉（`time_updated` 就是为这种改写留的）。因此"非空"本身就是一等状态，
 * 不需要去猜任何文字。
 *
 * 为什么 `selfRead`
 * ----------------
 * 这是**二进制** SQLite，不是 JSON。引擎的 rewrite 通道会先 `JSON.parse` 整个文件，
 * 对这个库**每一次轮询都会失败**，适配器将永远不被调用 —— 那正是本项目最怕的
 * "注册表里有、实际永不发声"。所以适配器声明 `selfRead: true`：引擎照旧负责发现文件、
 * 缓存、去重与唯一发送路径，只是把"读文件"这一步让给适配器。
 *
 * 依赖说明
 * --------
 * `node:sqlite` 是 **Node 22 内置**模块，不是第三方依赖，所以这不违反项目的零依赖原则。
 * 拿不到它（Node < 22）时适配器静默，由 `--status` 的 diagnose 说明原因 —— 绝不抛错。
 */
const fs = require('fs');
const path = require('path');

const RISK_CN = { low: '低', medium: '中', high: '高' };

/** Cap on remembered keys. The persisted store must stay bounded. */
const PENDING_CAP = 500;
/** How many recent `message` rows a poll inspects. Bounded on purpose. */
const TURN_WINDOW = 500;
/**
 * Cap on remembered turn keys.
 *
 * ⚠️ **必须是 `>= TURN_WINDOW`，且由它派生**（别再写一个独立的字面量）。
 * 不变量：**"记住的" ⊇ "读数器还能返回的"**。`readTurnEnds` 最多返回 TURN_WINDOW 条
 * 边界；只要记住数少一条，那条落榜的旧轮次就会在下一次轮询里**"变成新的"重播一遍**。
 *
 * 2026-10-09 红队实测复现：TURN_CAP=400 而窗口 500，插 450 条边界后第 2 次轮询**误发 50 条**。
 * 根因是**基线里的轮次从不经过 `claim()`** —— 所以去重集救不了它，只有"基线不被截断"才行。
 */
const TURN_CAP = TURN_WINDOW;
/** Hard cap on a notification body. */
const MAX_TEXT = 4000;

/** First non-empty trimmed string, or ''. */
function str(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

let sqliteModule;
let sqliteTried = false;

/** `node:sqlite` or null. Loaded once; a missing module is a known state, not an error. */
function sqlite() {
  if (sqliteTried) return sqliteModule;
  sqliteTried = true;
  try {
    // eslint-disable-next-line global-require
    sqliteModule = require('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** `data` may be a JSON string (opencode stores TEXT) or already-parsed. */
function parseData(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read every row of the `permission` table.
 *
 * Returns `{ ok, reason, rows }`. `ok:false` means "we could not look" (missing db,
 * no node:sqlite, unreadable file) — the adapter stays silent for that poll and the
 * reason is surfaced by `diagnose()` instead of being thrown. A **missing table** is
 * `ok:true` with no rows: that is a legitimate "this engine build never asks".
 */
function readPermissions(dbPath) {
  const mod = sqlite();
  if (!mod || !mod.DatabaseSync) {
    return { ok: false, reason: 'node:sqlite 不可用（需要 Node 22+）', rows: [] };
  }
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `数据库不存在：${dbPath}`, rows: [] };
  }
  let db;
  try {
    // read-only: we must never take a write lock on the software's live database.
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { ok: false, reason: `打开失败：${err.message}`, rows: [] };
  }
  try {
    // NOTE: single quotes — in SQLite a double-quoted token is an *identifier*, so
    // type="table" fails with `no such column: "table"`.
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='permission'")
      .get();
    if (!table) return { ok: true, reason: '没有 permission 表', rows: [] };
    const rows = db
      .prepare('SELECT project_id, time_created, time_updated, data FROM permission')
      .all();
    return { ok: true, reason: '', rows };
  } catch (err) {
    return { ok: false, reason: `查询失败：${err.message}`, rows: [] };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Stable identity of one waiting request. */
function keyOf(row, data) {
  const id = str(data.requestId, data.request_id, data.id, data.callID, data.callId, data.toolCallId);
  if (id) return `approval:${id}`;
  // No id anywhere: fall back to the row's own time columns, which exist precisely
  // because a permission row is written and later rewritten.
  return `approval:${str(row.project_id, '?')}:${row.time_created ?? ''}:${row.time_updated ?? ''}`;
}

/**
 * One line saying what is being asked, from whatever the row happens to carry.
 *
 * Deliberately forgiving: the exact `data` shape could not be observed on this machine
 * (0 rows), so it reads every plausible key and **always** ends in a fallback sentence.
 * A wrong guess therefore degrades into a vague notice, never into an empty body or a
 * crash. Once a real request shows up, `diagnose()` prints the raw keys so the mapping
 * can be tightened with evidence instead of assumption.
 */
function describe(data) {
  const reason = str(data.reason, data.description, data.message, data.title, data.prompt, data.summary);
  if (reason) return reason.slice(0, 140);

  const tool = str(data.toolName, data.tool_name, data.tool, data.type, data.kind);
  const risk = str(data.riskLevel, data.risk_level, data.risk);
  const riskCn = RISK_CN[risk.toLowerCase()] || risk;
  if (tool) return riskCn ? `要执行 ${tool}（风险：${riskCn}）` : `要执行 ${tool}`;

  return '有一项操作等你批准';
}

/** Session/conversation hint carried by the request payload. */
function sessionOf(data) {
  return str(data.sessionID, data.sessionId, data.session_id, data.session);
}

/* ------------------------------------------------------------------ *
 * 轮次结束（turn end）—— 「✅ 已完成 / ⚠️ 出错了」
 * ------------------------------------------------------------------ *
 * 和 permission 表在**同一个库**里，但是另一张表：`message`。判据是 MiMo
 * （opencode 系谱）自己写的字段，不是文字猜测：
 *
 *   assistant 消息的 `data.finish`
 *     "stop"              → 这一轮结束           → ✅ 已完成
 *     "tool-calls"        → 还在调工具，轮次未完  → 不报
 *     缺失 + `data.error` → 这一轮失败           → ⚠️ 出错了
 *
 * 真实数据（2026-10-09 本机 5 个会话 / 129 条消息 / 556 个片段）：
 *   finish=tool-calls **96** 条、finish=stop **14** 条、缺 finish **1** 条（正是那条
 *   `APIError 403 未开通会员`）。
 *
 *   ⚠️ **`time.completed` 绝不能当判据** —— 96 条 tool-calls 也全都带 completed，
 *   用它会把一个 14 步的轮次报成 14 条通知（实测 ratio 110 : 14）。唯一的分界是 `finish`。
 *
 *   ⚠️ **`actor_registry` 也不能用** —— 它的 `turn_count` 实测是 0/0/0/2/52，而同一批
 *   会话的真实 stop 数是 1/10/1/1/1（对不上）；且 5 行的 `last_outcome` **全是 `failure`**
 *   （原因是"Process restarted while actor was active"）。拿它当判据会把每一轮都报成
 *   "出错了"。这正是本项目那条纪律：**有一等字段也要先拿真实数据对一遍口径**。
 *
 * 为什么要 join `session`：对话名在 `session.title`；而 `session.parent_id` 非空 =
 * 子会话（opencode 系谱用 parent_id 标派生会话，与 Codex 的 `parent_thread_id` 同类），
 * 一律静默**并写日志** —— 否则子代理干完一小步也会冒充"整个任务完成"。
 */

/** Classify one MiMo message row: 'done' | 'error' | null (turn not over). */
function classifyMessage(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.role !== 'assistant') return null;
  const finish = typeof data.finish === 'string' ? data.finish : '';
  if (finish === 'stop') return 'done';
  if (finish) return null; // tool-calls / length / … → 轮次还在跑
  return data.error ? 'error' : null; // 没有 finish 但有 error = 这一次请求失败了
}

/** 失败原因：取到哪句算哪句。可能为空（调用方补兜底句）。 */
function errorText(data) {
  const e = data && data.error;
  if (!e) return '';
  const inner = e.data || {};
  return str(inner.message, e.message, inner.error, e.name);
}

/**
 * Candidate turn-boundary rows, newest first. **不含正文**（正文单独取，见 readTexts）——
 * 因为首次建立基线时不需要任何正文，而窗口里可能躺着十几条历史 stop 消息，
 * 白取会把每次轮询变成十几次查询。
 *
 * Returns `{ ok, reason, rows }`；`rows[i] = { id, sessionId, kind, title, parent, errorText }`。
 */
function readTurnEnds(dbPath) {
  const mod = sqlite();
  if (!mod || !mod.DatabaseSync) {
    return { ok: false, reason: 'node:sqlite 不可用（需要 Node 22+）', rows: [] };
  }
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `数据库不存在：${dbPath}`, rows: [] };
  }
  let db;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { ok: false, reason: `打开失败：${err.message}`, rows: [] };
  }
  try {
    const hasMessage = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message'")
      .get();
    if (!hasMessage) return { ok: true, reason: '没有 message 表', rows: [] };
    const hasSession = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
      .get();
    const sql = hasSession
      ? `SELECT m.id AS id, m.session_id AS session_id, m.data AS data,
                s.title AS title, s.parent_id AS parent
           FROM message m LEFT JOIN session s ON s.id = m.session_id
          ORDER BY m.time_created DESC LIMIT ${TURN_WINDOW}`
      : `SELECT id AS id, session_id AS session_id, data AS data,
                NULL AS title, NULL AS parent
           FROM message ORDER BY time_created DESC LIMIT ${TURN_WINDOW}`;

    const rows = [];
    for (const raw of db.prepare(sql).all()) {
      const data = parseData(raw.data);
      const kind = classifyMessage(data);
      if (!kind) continue;
      rows.push({
        id: String(raw.id),
        sessionId: String(raw.session_id || ''),
        kind,
        title: str(raw.title),
        parent: raw.parent == null ? '' : String(raw.parent),
        errorText: kind === 'error' ? errorText(data) : '',
      });
    }
    return { ok: true, reason: '', rows };
  } catch (err) {
    return { ok: false, reason: `查询失败：${err.message}`, rows: [] };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * 正文 = 这条消息所有 `text` 片段拼起来。真实数据里每条 finish=stop 的消息**恰好**
 * 只有一个非空 text 片段，所以这里的拼接几乎总是退化成"取那一个"。
 * 只对**新出现的**消息调用（数量通常 0～1），所以不用担心窗口大小。
 */
function readTexts(dbPath, ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const mod = sqlite();
  if (!mod || !mod.DatabaseSync) return out;
  let db;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return out;
  }
  try {
    const stmt = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created');
    for (const id of ids) {
      const chunks = [];
      for (const r of stmt.all(id)) {
        const d = parseData(r.data);
        if (d.type === 'text' && typeof d.text === 'string' && d.text.trim()) chunks.push(d.text.trim());
      }
      out.set(id, chunks.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT));
    }
  } catch {
    /* fall through: missing text degrades to an empty body, never a crash */
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 「MiMo 正在等你回答」—— `part` 表的工具状态机
 * ------------------------------------------------------------------ *
 * ★ 这一节推翻了一个**错误结论**，记下来免得再犯：
 *   2026-10-09 白天我写过「MiMo 全库扫过，**没有任何**"我在等你回答"的字段，所以不报 ❓」。
 *   **那是错的** —— 我只看了 `message.data` 的键和表的行数，**没看 `part.data.tool` 的取值**。
 *   真实数据里有一个工具叫 **`question`**，本机**调用过 13 次**：
 *     {"type":"tool","tool":"question","callID":"call_…","state":{"status":"completed",
 *      "input":{"questions":[{"question":"你同意这个方案吗？","header":"方案确认",
 *                             "options":[{"label":"同意，开始做",…}],"multiple":false}]},
 *      "output":"User has answered your questions: …"}}
 *   工具名叫 `question`，输入是 `questions[]`，答完后写 `output: "User has answered…"` ——
 *   与 WorkBuddy 的 `AskUserQuestion` / Codex 的 `request_user_input_async` **同类**。
 *
 * 判据是一等状态字段，不是猜文字（证据取自引擎本体 `mimo.exe`）：
 *   · 工具 part 的状态机（schema 里的 `ToolStatePending` / `ToolStateRunning`）：
 *       收到调用 → {status:"pending", input:…, raw:…}
 *       开始执行 → {…, status:"running", input:…, time:{start:…}}
 *       执行完毕 → {status:"completed", output:…, metadata:…}
 *     代码实证：`…state:{...T.state,status:"running",input:U.input,time:{start:Date.now()}}`
 *   · 对 `question` 工具，**"执行"就是等用户回答** → 所以 **`running` = 正在等你回答**。
 *     引擎日志佐证：`service=tool.registry status=started question` …
 *     14 秒后 … `status=completed question`（那 14 秒就是人在作答）。
 *   · `pending` = 调用刚发出、还没轮到执行 → **不报**（报了就是提前响）。
 *
 * 第二类等待：**交互式 bash**。bash 的入参有 `interactive` 字段，引擎文档原文：
 *   "Set to true when the command requires user interaction (password input,
 *    y/N confirmation, SSH key passphrase, etc)."
 *   → `tool==='bash' && status==='running' && input.interactive === true`
 *     = 命令正卡在那里等你敲键盘（会在你回答前一直不结束）。
 *
 *   ⚠️ 这两条都是**结构确证、真机 0 次触发**（本机此刻未结束的工具调用 = 0 条）。
 *   原因很实在：MiMo 最近一次使用是 2026-10-03，适配器上线后它还没跑过一轮。
 *   所以靠合成库回归锁着，`diagnose()` 会把原始行打出来，等真出现一次再收紧文案。
 *
 *   ⚠️ **不要**把"模型在正文里提问"也算进来 —— 那是猜文字，本项目在 WorkBuddy 上
 *   试过，162 条判成"在提问"而真提问只有 14 次（准确率 0%）。判据只许是字段。
 */
/** 一次轮询最多看多少条"未结束的工具调用"。这类的正常值是 0～1 条。 */
const ASK_WINDOW = 200;

/**
 * Classify one `part` row: 'question' | 'interactive' | null.
 *
 * 判定**只在这一处**。SQL 那边只是"召回"（粗筛未结束的工具调用，必然是这里的超集），
 * 精度一律由这个函数说了算 —— 下推会把判据撕成两份，边界输入上必然分歧。
 */
function classifyToolPart(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.type !== 'tool') return null;
  const state = data.state;
  if (!state || typeof state !== 'object') return null;
  // pending = 还没开始执行（报了就太早）；completed / error / cancelled = 已经结束。
  if (state.status !== 'running') return null;
  const tool = typeof data.tool === 'string' ? data.tool : '';
  if (tool === 'question') return 'question';
  if (tool === 'bash') {
    const input = state.input && typeof state.input === 'object' ? state.input : {};
    if (input.interactive === true) return 'interactive';
  }
  return null;
}

/** 一句话说清它在问什么 / 在等什么。取不到就退回兜底句，正文绝不为空。 */
function askText(data, kind) {
  const state = data && data.state && typeof data.state === 'object' ? data.state : {};
  const input = state.input && typeof state.input === 'object' ? state.input : {};

  if (kind === 'interactive') {
    const cmd = str(input.command, input.cmd, input.script);
    return cmd ? `命令卡住等你输入：${cmd.slice(0, 120)}` : '有命令在等你输入';
  }

  const questions = Array.isArray(input.questions) ? input.questions : [];
  const first = questions[0] && typeof questions[0] === 'object' ? questions[0] : {};
  const text = str(first.question, first.header, first.prompt, first.title);
  if (!text) return 'MiMo 正在等你回答一个问题';
  const head = text.slice(0, 120);
  return questions.length > 1 ? `${head}（共 ${questions.length} 个问题）` : head;
}

/**
 * 此刻"正在等你回答"的工具调用。返回 `{ ok, reason, rows }`，
 * `rows[i] = { partId, callId, sessionId, title, kind, text }`。
 *
 * 返回 0 行是完全正常的状态（没人被问、也没命令卡住）。
 */
function readPendingAsks(dbPath) {
  const mod = sqlite();
  if (!mod || !mod.DatabaseSync) {
    return { ok: false, reason: 'node:sqlite 不可用（需要 Node 22+）', rows: [] };
  }
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `数据库不存在：${dbPath}`, rows: [] };
  }
  let db;
  try {
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    return { ok: false, reason: `打开失败：${err.message}`, rows: [] };
  }
  try {
    const hasPart = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='part'")
      .get();
    if (!hasPart) return { ok: true, reason: '没有 part 表', rows: [] };
    const hasSession = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
      .get();

    // `json_valid` 先挡掉半截写入的坏 JSON —— 缺了它，`json_extract` 会直接抛错，
    // 整条查询失败 → 适配器静默。粗筛只到"未结束的工具调用"为止，判定交给 classifyToolPart。
    const sql = `SELECT p.id AS part_id, p.session_id AS session_id, p.data AS data,
                        ${hasSession ? 's.title' : 'NULL'} AS title
                   FROM part p
                   ${hasSession ? 'LEFT JOIN session s ON s.id = p.session_id' : ''}
                  WHERE json_valid(p.data)
                    AND json_extract(p.data,'$.type') = 'tool'
                    AND json_extract(p.data,'$.state.status') IN ('pending','running')
                  ORDER BY p.time_created DESC LIMIT ${ASK_WINDOW}`;

    const rows = [];
    for (const raw of db.prepare(sql).all()) {
      const data = parseData(raw.data);
      const kind = classifyToolPart(data);
      if (!kind) continue;
      rows.push({
        partId: String(raw.part_id),
        // callID 是引擎给的稳定身份；万一缺失就退回 part 主键（同样唯一）。
        callId: str(data.callID, data.call_id, raw.part_id),
        sessionId: str(raw.session_id),
        title: str(raw.title),
        kind,
        text: askText(data, kind),
      });
    }
    return { ok: true, reason: '', rows };
  } catch (err) {
    return { ok: false, reason: `查询失败：${err.message}`, rows: [] };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Build one adapter. ZCode and MiMo have identical schemas and identical semantics, so
 * they differ only in the path to their database — everything else is shared here so the
 * two can never drift apart.
 */
function createAdapter({ id, label, dbPath, envVar, dbFileName }) {
  // Test seam, same convention as BAND_NOTIFY_WORKBUDDY_DIR / _CODEX_DIR / _ZCODE_DIR.
  const resolved = (envVar && process.env[envVar]) || dbPath;
  const dirs = [path.dirname(resolved)];
  const filePattern = new RegExp(`^${dbFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

  return {
    id,
    label,
    dirs,
    depth: 0,
    filePattern,
    mode: 'rewrite',
    selfRead: true,
    pollMs: 3000,

    snapshot(_json, info) {
      return approvalDescs(resolved, info, label);
    },

    conversation() {
      return label;
    },

    diagnose() {
      const lines = [];
      const mod = sqlite();
      lines.push(`  数据库：${resolved}${fs.existsSync(resolved) ? '' : '（不存在）'}`);
      lines.push(`  node:sqlite：${mod && mod.DatabaseSync ? '可用' : '不可用（需要 Node 22+）'}`);
      const { ok, reason, rows } = readPermissions(resolved);
      if (!ok) {
        lines.push(`  permission 表：读不到（${reason}）`);
        return lines;
      }
      lines.push(`  permission 表：${rows.length} 行待处理${reason ? `（${reason}）` : ''}`);
      for (const row of rows.slice(0, 5)) {
        const data = parseData(row.data);
        const keys = Object.keys(data).join(', ') || '(空)';
        lines.push(`    · ${keyOf(row, data).slice(0, 60)}  字段: ${keys}`);
        lines.push(`      正文将显示: ${describe(data)}`);
      }
      return lines;
    },
  };
}

/**
 * 「有没有新的待批准项」——把判定与状态回写收在一处，`createAdapter`（ZCode / MiMo 的
 * 纯审批适配器）和 `mimo.js`（审批 + 轮次结束的复合适配器）共用，避免两份逻辑漂移。
 *
 * 返回 descriptor 数组，或 null（没有新东西 / 读不到库）。
 */
function approvalDescs(dbPath, info, label) {
  const { ok, rows } = readPermissions(dbPath);
  if (!ok) return null; // cannot look → stay quiet (diagnose explains)

  const cacheKey = 'pending';
  const prev = info.cache.get(cacheKey);

  // current: key -> { data, row }
  const current = new Map();
  for (const row of rows) {
    const data = parseData(row.data);
    current.set(keyOf(row, data), { data, row });
  }

  // ⚠️ 持久化状态必须是 **JSON 安全的**。这里原来存的是一个 `Map`，而
  // `JSON.stringify(new Map())` === `"{}"` —— 重启后从磁盘读回来的 `prev` 是个
  // **真值空对象**，于是 `prev.has(key)` 抛 `TypeError`，被引擎的 try/catch 吞掉，
  // 适配器从此**每一轮都异常、永远不发声**（而且是注册表里"看起来正常"的那种死法）。
  // 2026-10-09 复现并修正：改存**键名数组**；任何非数组一律当"没有历史状态"→ 重建基线，
  // 绝不抛错。
  const prevKeys = Array.isArray(prev) ? new Set(prev) : null;
  if (!prevKeys) {
    info.cache.set(cacheKey, [...current.keys()]);
    return null;
  }

  const descs = [];
  for (const [key, { data }] of current) {
    if (prevKeys.has(key)) continue;
    const session = sessionOf(data);
    descs.push({
      key,
      state: 'approval',
      priority: 4,
      text: describe(data),
      // No real conversation title in the permission row; a short session fragment
      // beats falling back to the watcher's own cwd (which would say "band-notify").
      conversation: session ? session.split('-')[0].slice(0, 12) : label,
      cwd: '',
      kind: 'ask-approval',
      log: '等待批准（permission 表里出现待处理项）',
    });
  }
  info.cache.set(cacheKey, [...current.keys()].slice(-PENDING_CAP));
  return descs.length ? descs : null;
}

module.exports = {
  createAdapter,
  approvalDescs,
  readPermissions,
  readTurnEnds,
  readTexts,
  readPendingAsks,
  classifyMessage,
  classifyToolPart,
  askText,
  errorText,
  parseData,
  describe,
  keyOf,
  TURN_CAP,
  TURN_WINDOW,
  ASK_WINDOW,
};
