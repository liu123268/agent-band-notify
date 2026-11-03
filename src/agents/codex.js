'use strict';
/**
 * Codex adapter.
 *
 * Where the log is
 * ----------------
 * One rollout per conversation, JSON-lines, appended forever:
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
 *
 * So this is an ordinary 'append' adapter: the engine tracks the byte offsets and hands
 * each new line to `turnEnd()`. `depth: 3` is the YYYY/MM/DD nesting.
 *
 * What "the turn is over" looks like
 * ----------------------------------
 *   {"type":"event_msg","payload":{"type":"task_complete","turn_id":"<id>",
 *      "last_agent_message":"<the final reply>"}}
 *   {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"<id>", …}}
 *
 * `task_complete` is the authoritative end-of-turn marker. `turn_aborted` is NOT one:
 * Codex writes the same event whether the user pressed stop or the turn crashed, and
 * treating it as a marker produced a "⚠️ 出错了" for turns that never failed. Only the
 * quota path (payload.error) is worth waking someone — see `classifyTurn`.
 *
 * Why most turns must stay silent
 * -------------------------------
 * The first line of every rollout carries its identity:
 *
 *   thread_source: "user" | "subagent" | "guardian_review", plus parent_thread_id on
 *   anything that is a piece of a bigger job.
 *
 * Verified over 360 real rollouts: 134 user / 42 subagent / 184 guardian_review. A subagent
 * finishing ONE STEP also writes task_complete, which is exactly what made completions look
 * premature and duplicated. Only `user` threads with no parent are announced.
 *
 * Codex also runs a safety classifier as its own turn, whose `last_agent_message` is a
 * machine payload ({"risk_level":…,"outcome":"allow",…}). Those are announced-looking but
 * are not replies.
 *
 * The conversation name
 * ---------------------
 * The title lives in `~/.codex/session_index.jsonl`, keyed by the THREAD id — and the
 * thread id is the LAST uuid in the rollout FILENAME, not the `task_complete` turn_id
 * (verified: 0 of 39 turn_ids appear in the index, every filename id does).
 *
 * Cache note: thread identities used to live in `logs/codex-thread-kinds.json`; they now
 * ride in the engine's per-adapter cache (`logs/agent-watch-cache.json`). After the move,
 * the first look at each existing rollout re-reads its first 120 KB once. That is lazy —
 * `threadKind` is only called for a turn that already looks announceable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { threadName } = require('../codex-threads.js');

const SESSIONS_DIR =
  process.env.BAND_NOTIFY_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions');

/** Which `thread_source` values are the user's own conversation. */
const SOURCES = new Set(
  String(process.env.BAND_NOTIFY_CODEX_SOURCES || 'user')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** Keys that mark a JSON `last_agent_message` as machinery rather than a reply. */
const INTERNAL_KEYS = [
  'risk_level',
  'user_authorization',
  'outcome',
  'rationale',
  'decision',
  'allowed',
  'verdict',
];

function shortId(id) {
  return String(id || '').slice(0, 8);
}

/**
 * Distinguish "the agent finished answering you" from Codex's internal machinery.
 *
 *   announce - a real reply for the user
 *   skip     - internal machinery (safety classifier, empty step)
 *   limit    - the turn died on the subscription quota
 *
 * The quota case is deliberately NOT folded into "skip": `last_agent_message` is empty
 * there, so a naive empty-reply filter swallows it — and being told the quota ran out is
 * exactly the alert that matters most.
 */
function classifyTurn(payload) {
  const err = payload.error;
  if (err && typeof err === 'object') {
    const code = String(err.codex_error_info || '');
    const message = String(err.message || '').replace(/\s+/g, ' ').trim();
    if (/usage_limit|quota|rate_limit/i.test(code) || /usage limit|rate limit/i.test(message)) {
      return { action: 'limit', reason: `额度用完（${code || 'limit'}）`, text: message };
    }
    return { action: 'limit', reason: `轮次失败（${code || 'error'}）`, text: message };
  }

  const text = String(payload.last_agent_message || '').trim();
  if (!text) return { action: 'skip', reason: '空回复（内部步骤）' };

  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const keys = Object.keys(JSON.parse(text));
      if (keys.some((k) => INTERNAL_KEYS.includes(k))) {
        return { action: 'skip', reason: '安全检查器判定（内部子代理）' };
      }
      return { action: 'skip', reason: '机器载荷，非面向用户的回复' };
    } catch {
      return { action: 'skip', reason: '疑似机器载荷' };
    }
  }
  return { action: 'announce', reason: '' };
}

/**
 * Codex's own "I am asking you something" tool call — the ONE exact ❓ signal it gives.
 *
 * ── Verified on a real rollout, 2026-10-07 (fixing a wrong earlier belief) ────
 * `src/turn-text.js` used to state that Codex records no ask event at all and that
 * `request_user_input_async` "only appears inside instruction text". That was WRONG.
 * It is a genuine `function_call`, and it fired twice in one evening:
 *
 *   [21:13:56] name=request_user_input_async
 *     arguments={"questions":[{"title":"V1 发布包已通过云端预检…是否允许现在发布到
 *                现有云主机，安装 python3.12-venv，并启用每天 06:30 的目录同步？…",
 *                "options":["允许发布并启用每日同步","先完成本地，云端暂不改"]}]}
 *     call_id=call_W25sDfGx4bMbE1nUD7M8RHJ0
 *   [21:24:46] name=request_user_input_async
 *     arguments={"questions":[{"title":"新版已发布到 https://134.175.137.81。请用你
 *                自己的账号正常登录…确认报价、K 线和已有研究记录是否正常。", …}]}
 *
 * Neither produced a notification: the user saw the questions on screen and asked why
 * his wristband stayed silent.
 *
 * ── Why turn-end detection cannot see this ───────────────────────────────────
 * The call is immediately followed by `function_call_output {"accepted":true}` —
 * delivery is **async**: the tool returns at once and the turn CARRIES ON. So the
 * question is asked mid-turn and no `task_complete` follows it any time soon (that
 * turn stayed busy for another 11 minutes and then asked again). Keying on the turn
 * end would announce a question long after it was asked — the same trap
 * `workbuddy.js`'s `askPending` exists to avoid.
 *
 * This is the shape `workbuddy.js` already handles with AskUserQuestion; Codex just
 * spells it differently. Note Codex uses `title` where WorkBuddy uses `question`.
 */
const ASK_TOOLS = new Set(['request_user_input_async']);

/** The question(s), out of the call's `arguments` JSON string. Options are dropped. */
function askText(rawArguments) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawArguments || ''));
  } catch {
    return '';
  }
  const list = parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
  return list
    .map((q) => {
      if (!q || typeof q !== 'object') return '';
      const t = typeof q.title === 'string' ? q.title : typeof q.question === 'string' ? q.question : '';
      return t.trim();
    })
    .filter(Boolean)
    .join(' ／ ');
}

/**
 * An explicit request for user input, detected on the `function_call` line itself.
 *
 * Keyed by `ask:<call_id>`, which is stable across a restart and cannot collide with a
 * turn key (the same dedup guarantee the WorkBuddy adapter relies on).
 */
function askPending(event, info) {
  if (!event || event.type !== 'response_item') return null;
  const p = event.payload || {};
  if (p.type !== 'function_call') return null;
  if (!ASK_TOOLS.has(String(p.name || ''))) return null;
  // Same source filter the turn ends use: a subagent's question is not addressed to
  // the user, and guardian_review writes its own rollouts. Only `user` threads with no
  // parent may ring the wristband.
  if (!threadKind(info.file, info.cache).announcement) return null;
  return {
    key: `ask:${p.call_id || p.id || ''}`,
    state: 'ask',
    priority: 4,
    text: askText(p.arguments),
    conversation: conversationName(info) || '',
    cwd: '',
    kind: 'ask-pending',
    log: '等待回答（正在提问）',
  };
}

/**
 * Codex's own "may I?" prompts — events that mean the turn is BLOCKED on a yes/no from
 * the user rather than on a question. Announced as ❓ 等你批准 (state `approval`).
 *
 * ── Evidence, and its limits (read before touching the set) ──────────────────
 * The four names are the EventMsg variants the OFFICIAL protocol declares as requests for
 * the user to act. Verified 2026-10-09 against
 * `codex-rs/protocol/src/protocol.rs` + `codex-rs/protocol/src/approvals.rs`:
 * `EventMsg` is `#[serde(tag = "type", rename_all = "snake_case")]`, so the wire tag is the
 * snake_case variant name — the same `payload.type` this adapter already keys on.
 *
 *   exec_approval_request        ExecApprovalRequestEvent { call_id, turn_id, command[],
 *                                                          cwd, reason, approval_id }
 *   apply_patch_approval_request ApplyPatchApprovalRequestEvent { call_id, turn_id,
 *                                                          changes{}, reason, grant_root }
 *   request_permissions          RequestPermissionsEvent
 *   elicitation_request          ElicitationRequestEvent { server_name, id, request }  (MCP)
 *
 * ⚠️ **THIS MACHINE HAS NEVER PRODUCED ONE, and that is expected, not a bug.**
 * A sweep of every `event_msg` type across the 45 most recent rollouts (116 MB) returns
 * only: item_completed / token_count / thread_settings_applied / task_started /
 * task_complete / turn_aborted. An exact search for `"exec_approval_request"` across all
 * 415 rollouts hits one *pasted Rust source snippet* — never an event. The reason is
 * written in the same files:
 *
 *     approval_policy: "on-request"      approvals_reviewer: "auto_review"
 *
 * i.e. Codex's own reviewer takes the approval decisions, so the user is not asked.
 *
 * So this branch is deliberately **forward-looking**: keyed on the protocol's own tag
 * strings (not a guess), locked by regressions that feed protocol-shaped samples, and
 * paired with the "unregistered event type" assertion in tools/test-agent-watch.js — the
 * day this machine does ask, that assertion fires and the audit equation starts moving.
 * **Do not delete it for being quiet.** Being ready is the point; the user asked for it.
 */
const APPROVAL_EVENTS = new Set([
  'exec_approval_request',
  'apply_patch_approval_request',
  'request_permissions',
  'elicitation_request',
]);

/**
 * One line saying what is being asked, tolerant about which fields a given Codex build
 * fills in: every field read here is optional in the protocol, so each branch falls
 * through to a generic sentence instead of rendering an empty body (the notification
 * template drops empty tokens, which would leave the user with a title and nothing else).
 */
function approvalText(type, p) {
  const words = (v) => (typeof v === 'string' ? v.trim() : '');

  if (type === 'exec_approval_request') {
    const cmd = Array.isArray(p.command)
      ? p.command.filter((s) => typeof s === 'string').join(' ').trim()
      : '';
    if (cmd) return `要执行命令：${cmd}`;
    return words(p.reason) || '要执行一条命令，等你批准';
  }
  if (type === 'apply_patch_approval_request') {
    const n = p.changes && typeof p.changes === 'object' ? Object.keys(p.changes).length : 0;
    if (n > 0) return `要修改 ${n} 个文件，等你批准`;
    return words(p.reason) || '要应用代码改动，等你批准';
  }
  if (type === 'request_permissions') {
    return words(p.reason) || '要申请额外权限，等你批准';
  }
  if (type === 'elicitation_request') {
    const server = words(p.server_name);
    return server ? `MCP「${server}」要你确认` : 'MCP 要你确认一件事';
  }
  return '有一项操作等你批准';
}

/**
 * A "may I?" prompt that is IN FLIGHT, detected on the event line itself.
 *
 * Blocking by construction — Codex publishes the request and waits for the user's
 * `Op::ExecApproval` / `Op::PatchApproval` decision — so announcing at the turn end would
 * announce it only after it had been answered. Same reasoning as `askPending` above.
 *
 * The dedup key prefers `approval_id` (the protocol's own id for the request), then
 * `call_id`, then `id`; the type suffix keeps two different prompts on one call apart.
 */
function approvalPending(event, info) {
  if (!event || event.type !== 'event_msg') return null;
  const p = event.payload || {};
  const type = String(p.type || '');
  if (!APPROVAL_EVENTS.has(type)) return null;
  // Same source filter as everything else: a subagent's approval prompt is not addressed
  // to the user, and guardian_review writes its own rollouts.
  if (!threadKind(info.file, info.cache).announcement) return null;
  return {
    // ⚠️ `id` 在 elicitation_request 上是 `RequestId`，按协议可以是**对象**或**数字**。
    //    `p.id || ''` 会把对象插值成 "[object Object]" —— 两条不同的询问撞同一个去重键，
    //    第二条被**静默丢掉**；数字 0 也会被 `||` 当成空。所以必须过 idOf。
    key: idKey(p, type),
    state: 'approval',
    priority: 4,
    text: approvalText(type, p),
    conversation: conversationName(info) || '',
    cwd: typeof p.cwd === 'string' ? p.cwd : '',
    kind: 'ask-approval',
    log: '等待批准（正在询问）',
  };
}

/**
 * ── 「等你批准」：Codex 在执行之前向人要一次点头 ────────────────────────────
 *
 * 与 `askPending` 并列的第二种"球在你那边"：不是问问题，而是**批准一个动作**。
 * 用户要的形式与既有状态一致 —— 标题 `❓ 等你批准`，正文 `【Codex】{会话名} · {摘要}`
 * （`src/notice.js` 的 `STATES.approval` 已就位，`config.json` 无需改动）。
 *
 * ⚠️ 本机语料里 **0 条样本**，这一节完全依据官方协议定义 —— 必须说清楚
 * ------------------------------------------------------------------
 * 2026-10-09 全库 ripgrep `~/.codex/sessions`（415 个 rollout）：
 *
 *   "exec_approval_request"        命中 0
 *   "apply_patch_approval_request" 命中 0
 *   "exec_approval_decision"       命中 0
 *
 * 唯一一次字面命中 `approval_request` 是**工具输出里的 Codex 源码片段**
 * （rollout-2026-10-05T11-27-31-…jsonl:72，`payload.type=custom_tool_call_output`）。
 * 日志里所有 `approval` 字段都是**配置回显**：`payload.approval_policy`（86 次，
 * 值 `"on-request"`）、`payload.approvals_reviewer`（86 次，值 `"auto_review"`）——
 * 字段名里有 approval，但它们不是事件。**所以判据是精确 tag，不是 `/approval/i`。**
 * （test-agent-watch.js 里有一条测试专门锁这一点：86 条配置回显 → 0 条通知。）
 *
 * tag 来源（openai/codex，`codex-rs/protocol/src/protocol.rs`，已核对）：
 *
 *   #[derive(…)] #[serde(tag = "type", rename_all = "snake_case")]
 *   pub enum EventMsg {
 *     ExecApprovalRequest(ExecApprovalRequestEvent),          → exec_approval_request
 *     RequestPermissions(RequestPermissionsEvent),            → request_permissions
 *     ElicitationRequest(ElicitationRequestEvent),            → elicitation_request
 *     ApplyPatchApprovalRequest(ApplyPatchApprovalRequestEvent) → apply_patch_approval_request
 *   }
 *
 * 也就是 rollout 里的 `{"type":"event_msg","payload":{"type":"exec_approval_request",…}}`。
 * 字段取自同仓库 `codex-rs/protocol/src/approvals.rs`：`ExecApprovalRequestEvent` 有
 * `call_id` / `turn_id` / `started_at_ms` / `command: Vec<String>` / `cwd` / `reason`；
 * `ApplyPatchApprovalRequestEvent` 有 `call_id` / `turn_id` / `changes: {路径: FileChange}`；
 * `ElicitationRequestEvent` 有 `server_name` / `id` / `request`。
 *
 * 为什么 `guardian_assessment` 不算（这条别改）
 * ------------------------------------------
 * 用户的配置里有 `approvals_reviewer: "auto_review"` —— 官方配置参考：
 * "谁评审符合条件的审批提示；`auto_review` 使用**评审子代理**"。也就是说 Codex 可以让
 * 一个守门人子代理**代你**放行低风险动作、只把高风险的升级给人。守门人自己走的那条线
 * 写出来的是 `guardian_assessment`（官方注释：guardian-reviewed approval request 的
 * **结构化生命周期事件**）和 `guardian_warning` —— 那是**评审过程**，不是"在问你"。
 * 把它们当成弹窗，等于每次自动放行都振一下手环。这跟 WorkBuddy 那边把
 * `command-safety.sandbox-executed` 一律静默是同一条纪律。
 *
 * 已知的开放问题（本机没有数据能回答，先记在这里）
 * ----------------------------------------------
 * 若守门人**自动放行**时 Codex 仍然照写 `exec_approval_request`，我们会多振一次。
 * 本机 0 样本，无法判定。选择"宁可信其有"：漏报是你真正会遇到的失败（WorkBuddy 那次
 * 漏报就是这么来的），而误报会**在日志里留下痕迹**，第一次发生就能查清 —— 这比让你
 * 蒙在鼓里强。一旦发现，修法是把判据收紧到"确实升级给了人"的那条支路，**不是删掉整个分支**。
 */
/**
 * 名字像"审批"、但**故意不报**的事件。列出来是为了让"这条为什么不响"有个可查的答案。
 * test-agent-watch.js 的全库普查哨兵会拿这份清单当下界：语料里一旦出现清单外的
 * 审批类事件，测试立刻失败并点名，而不是安静地漏一辈子。
 */
const APPROVAL_MACHINERY = new Set([
  'guardian_assessment', // 评审子代理的结论（自动放行/拒绝）—— 过程，不是问你
  'guardian_warning', // 评审子代理的告警 —— 同上
  'elicitation_abandoned', // MCP 询问已被丢弃，问题不存在了
]);

/**
 * 只认真正的字符串/数字 id。
 *
 * `RequestId` 按协议可以是**对象**（`{"String":"…"}`）或数字，而 `p.id || ''` 会把对象
 * 插值成 "[object Object]"：两条不同的询问于是撞同一个去重键，**第二条被静默丢掉**
 * （本项目最糟的失败方式）。数字 0 也会被 `||` 当成空。这个函数就是堵这两条。
 */
function idOf(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * 审批请求的去重键。
 *
 * 优先 `approval_id`（协议自己的请求 id），其次 `call_id`，再次 `id`（elicitation 用）；
 * 三者都缺时退到 `turn_id + started_at_ms`，**绝不退到空** —— 空键会让同一类型的两条
 * 询问互相吃掉。末尾的 `:${type}` 保证不同类型的请求即使共用同一个 id 也不撞车。
 */
function idKey(payload, type) {
  const rid = idOf(payload.approval_id) || idOf(payload.call_id) || idOf(payload.id);
  const fallback = `${idOf(payload.turn_id)}:${idOf(payload.started_at_ms)}`;
  return `approval:${rid || fallback}:${type}`;
}

const UNKNOWN_KIND = { source: 'unknown', parent: '', nickname: '', cwd: '', announcement: true };

/** The conversation title, or the workspace folder as a fallback. */
function conversationName(info) {
  return threadName(threadIdFromFile(info.file)) || folderName(info.cwd) || '';
}

/**
 * Identity of a rollout, read from its first line (the `session_meta` event) and remembered
 * in the engine's per-adapter cache so a restart does not re-read every historical file.
 *
 * Unreadable metadata must NOT silence a genuine completion, hence the permissive `unknown`
 * fallback (`announcement: true`).
 */
function readThreadKind(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(120000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const meta = JSON.parse(nl === -1 ? text : text.slice(0, nl));
    const p = meta.payload || {};
    const src = p.source;
    const source =
      (typeof p.thread_source === 'string' && p.thread_source) ||
      (typeof src === 'string' ? src : src && typeof src === 'object' ? Object.keys(src).join('+') : '');
    const parent = typeof p.parent_thread_id === 'string' ? p.parent_thread_id : '';
    return {
      source: source || 'unknown',
      parent,
      nickname: p.agent_nickname || '',
      cwd: typeof p.cwd === 'string' ? p.cwd : '',
      // A parent thread means "this rollout is a piece of another thread's job", which is
      // authoritative regardless of how the source string is spelled.
      announcement: !parent && SOURCES.has(String(source || '').toLowerCase()),
    };
  } catch {
    // Unreadable (empty file, or the poll landed mid-write on the first line).
    // Return null rather than the permissive `unknown` kind: the CALLER decides what to
    // do now, and - crucially - must not memoise it. See threadKind().
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Identity of a rollout, memoised per file.
 *
 * ⚠️ Only a SUCCESSFUL read may be memoised. Caching the failure was a real bug: when a
 * brand-new rollout is first seen while it is still 0 bytes / mid-write, the read fails,
 * and memoising the permissive `unknown` kind (`announcement: true`) made that file
 * announce forever afterwards — so a subagent rollout's every step arrived as "✅ 已完成".
 * That is precisely the "a finished sub-step looks like the whole task is done" failure
 * this filter exists to prevent. A transient failure must stay transient.
 */
function threadKind(file, cache) {
  const key = `kind:${file}`;
  const known = cache.get(key);
  if (known && typeof known === 'object') return known;
  const kind = readThreadKind(file);
  if (kind) cache.set(key, kind);
  return kind || UNKNOWN_KIND;
}

function threadIdFromFile(file) {
  const base = path.basename(file, '.jsonl');
  const uuids = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
  return uuids.length ? uuids[uuids.length - 1] : '';
}

function folderName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/** Directory walk mirroring the engine's, used only by diagnose(). */
function listRollouts(listFiles) {
  return listFiles({ dirs: [SESSIONS_DIR], depth: 3, filePattern: /^rollout-.*\.jsonl$/ });
}

module.exports = {
  id: 'codex',
  label: 'Codex',
  dirs: [SESSIONS_DIR],
  depth: 3,
  filePattern: /^rollout-.*\.jsonl$/,
  mode: 'append',
  pollMs: 2000,

  // 显式导出这两份清单，供 test-agent-watch.js 的全库普查哨兵当下界比较
  // （哨兵要断言"语料里没有未登记的审批类事件"，它需要一个已知集合）。
  // 适配器本体只用它们做精确匹配，不做任何模糊判断。
  APPROVAL_EVENTS,
  APPROVAL_MACHINERY,

  turnEnd(event, info) {
    if (!event || typeof event !== 'object') return null;

    // A request for user input is announced the moment it is CALLED — it is async, so
    // keying on the turn end would announce the question only after the turn had moved
    // on. See askPending above for the real shapes this was verified against.
    const pending = askPending(event, info);
    if (pending) return pending;

    // The other "the ball is in your court": a yes/no on an ACTION. Same reason for
    // catching it on the event line rather than at the turn end — the turn does not end,
    // it WAITS. See approvalPending above.
    const approval = approvalPending(event, info);
    if (approval) return approval;

    // Everything below is the turn-end path, which only ever lives on `event_msg`.
    if (event.type !== 'event_msg') return null;

    const payload = event.payload || {};
    const type = payload.type;
    if (type !== 'task_complete' && type !== 'turn_aborted') return null;

    const verdict = classifyTurn(payload);
    const turn = shortId(payload.turn_id);

    // An aborted turn is a separate rule, deliberately checked first: classifyTurn would
    // call it "空回复（内部步骤）" (the message really is empty), which would be a misleading
    // line in the log for what is almost always the user pressing stop.
    if (type === 'turn_aborted' && verdict.action !== 'limit') {
      return { skip: '中断轮次（多为用户手动停止）', detail: `turn=${turn}` };
    }

    if (verdict.action === 'skip') {
      return { skip: verdict.reason, detail: `turn=${turn}` };
    }

    const identity = threadKind(info.file, info.cache);
    if (!identity.announcement) {
      return {
        skip: '非用户线程（子代理/守护评审）',
        detail:
          `turn=${turn} 来源=${identity.source}` +
          (identity.parent ? ` parent=${shortId(identity.parent)}` : '') +
          (identity.nickname ? ` 代号=${identity.nickname}` : ''),
      };
    }

    const limit = verdict.action === 'limit';
    const text = String(payload.last_agent_message || '').replace(/\s+/g, ' ').trim();

    // ── TEXT GUESSING REMOVED for Codex too (2026-10-08) ─────────────────────────
    // This used to be `const asking = !limit && looksLikeAsk(text)` — the same prose
    // guess WorkBuddy dropped on 2026-10-06. It is gone, for the same three reasons,
    // and it should not come back.
    //
    // 1. CODEX HAS AN EXACT SIGNAL AND IT FIRES EARLIER. `request_user_input_async`
    //    (see askPending above) announces the question the moment it is asked, with the
    //    question text in hand. Guessing again at turn end can only add noise.
    //
    // 2. THE GUESS IS MEASURABLY WORTHLESS. Behaviourally measured (turn-text.js): of
    //    253 flagged Codex turns only 11 (4%) were ever followed by an answer. The
    //    production false positive that prompted this removal, 2026-10-08 15:20:
    //
    //      A turn that had FINISHED (documents reviewed, a commit message proposed,
    //      "尚未执行提交") was announced as ❓ because it closed with a check-in:
    //      "…你觉得这样的结果符合你的预期吗，还是其中有一项你希望换成更有用的内容？"
    //      That session called request_user_input_async ZERO times.
    //
    //    The user's report, verbatim: "20分codex完成任务。但是识别出来是等我回答。"
    //    Note what the closing line actually was: a sign-off inviting reflection, not a
    //    handover. Codex is used here for project discussion; its turns end like that.
    //
    // 3. THE TURN-END MARKER IS RELIABLE. `task_complete` is authoritative, so an ended
    //    Codex turn has provably stopped — it is not blocked waiting on the user.
    //
    // KNOWN COST, accepted: if the model asks in PROSE without calling
    // `request_user_input_async`, that turn is announced as ✅ and the body is clipped
    // from the START (clipByState), so a question at the very end may go unread. This is
    // the same trade the WorkBuddy adapter took. **If that ever looks wrong, the fix is
    // to make the model call the tool — NOT to re-add the guess.** BAND_NOTIFY_ASK_FROM_TEXT
    // no longer applies to Codex (it still governs ZCode).
    //
    // NOT YET DONE: ZCode keeps the text guess (see src/agents/zcode.js). It is the only
    // adapter with no first-class ask signal left — the last one out.
    return {
      key: payload.turn_id || '',
      state: limit ? 'error' : 'done',
      // A quota stop must never slip past a priority filter.
      priority: limit ? 5 : 0,
      text: limit ? verdict.text || '额度/调用失败' : text,
      conversation: '', // resolved by conversation() below
      cwd: identity.cwd || '',
      kind: limit ? 'quota' : type === 'turn_aborted' ? 'turn-aborted' : 'task-complete',
      log: limit ? '额度用尽' : '任务完成',
    };
  },

  conversation(info) {
    return conversationName(info);
  },

  /**
   * `--status` extra: what share of rollouts will and will not be announced. A source that
   * is being filtered by mistake shows up here instead of staying invisible until the day
   * a completion never rings.
   */
  diagnose(ctx) {
    const counts = new Map();
    for (const { file } of listRollouts(ctx.listFiles)) {
      const kind = threadKind(file, ctx.cache);
      const key = `${kind.source}${kind.parent ? '+子线程' : ''}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const lines = [`只通知来源 ∈ {${[...SOURCES].join(', ')}} 且没有父线程的会话：`];
    for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      const ok = SOURCES.has(key.split('+')[0]) && !key.includes('+');
      lines.push(`  ${String(n).padStart(5)}  ${key}${ok ? '  ← 会通知' : '  （静默）'}`);
    }
    // Which tags count as "Codex is asking YOU". Printed here because the honest answer
    // to "它会报批准吗" must be checkable in one command, and because these tags were
    // taken from the official protocol rather than from a sample on this machine.
    // Deliberately NOT counted here: a full census would mean reading every rollout
    // (hundreds of MB) on every `--status`. The census lives in the test suite instead,
    // where scanning the whole corpus offline is the point.
    lines.push(`  审批请求事件：${[...APPROVAL_EVENTS].join('、')}`);
    lines.push(`  评审生命周期（故意静默）：${[...APPROVAL_MACHINERY].join('、')}`);
    return lines;
  },
};
