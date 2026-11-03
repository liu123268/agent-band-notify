'use strict';
/**
 * DSH adapter — the project's only `mode: 'rewrite'` adapter.
 *
 * Where the log is
 * ----------------
 *   ~/.dsh/storages/session_projcache/sessions/session-<uuid>.json
 *
 * One file per conversation, but NOT append-only: DSH keeps a single JSON object and
 * rewrites the WHOLE file whenever any field changes. There are no "new bytes" to read, so
 * a byte offset is meaningless — the engine hands `snapshot()` the parsed object and this
 * adapter decides what changed, memoising per file through `info.cache`.
 *
 * What "the turn is over" looks like
 * ----------------------------------
 * The session object carries an explicit turn boundary:
 *
 *   rows.turnBoundary.val.openTurnStartSeq   — seq of the in-flight turn, or null/absent
 *   rows.turnBoundary.val.lastTurn           — id of the most recently finished turn
 *
 * A turn finishes when the boundary goes from open to closed, or (if we never caught it
 * open) when `lastTurn` advances. Both are needed: a fast turn can start and finish between
 * two polls, and the cache is rewritten in several bursts, so the same closing boundary can
 * be observed more than once.
 *
 * Why the "baseline turn" rule exists
 * ----------------------------------
 * On FIRST sight of a session file the adapter stays silent and remembers the `lastTurn` it
 * saw. A later rewrite that presents that same turn as if it had just closed (DSH re-derives
 * its cache on startup, and a resumed conversation can replay history) must NOT be announced
 * as news. Turns with any other id are announced normally.
 *
 * The only adapter whose `❓` is a FIELD
 * --------------------------------------
 * DSH records the reason a turn stopped in its own fields, so `❓ 等你回答` here is read, not
 * guessed:
 *
 *   rows.userQuestions.val.questions.active[]  — real questions awaiting a choice
 *   rows.plan.val.active / .running            — a plan awaiting confirmation
 *   rows.goal.val.failure                      — the task broke
 *
 * WorkBuddy also has an exact marker, but a different one: an `AskUserQuestion` tool call
 * (see src/agents/workbuddy.js). Codex and ZCode expose nothing, so for them `❓` is inferred
 * from the closing text — ON by default since 2026-10-05 (opt out with
 * `BAND_NOTIFY_ASK_FROM_TEXT=0`). Order of trust is always: field first, tool call second,
 * wording last. See src/turn-text.js.
 *
 * Known limit
 * -----------
 * `rows.turnOutline.val.turns[].response` is the reply text, but DSH truncates it to ~120
 * characters. The historical `dsh-watch.js` computed it and then sent a constant string
 * ("已经做完了") instead; this adapter sends the real text.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const SESSION_DIR =
  process.env.BAND_NOTIFY_SESSION_DIR ||
  path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');

/** How this adapter's files are found — kept here so `diagnose()` can enumerate them too. */
const DISCOVERY = { dirs: [SESSION_DIR], depth: 0, filePattern: /^session-.*\.json$/ };

/** Turn ids restart per session, so identity is session + turn, never turn alone. */
function isOpen(seq) {
  return seq !== null && seq !== undefined;
}

/** Read the fields we need out of one session object. Null when the boundary is missing. */
function readSession(json, file) {
  const rows = json && json.record && json.record.rows;
  if (!rows || !rows.turnBoundary || !rows.turnBoundary.val) return null;
  const boundary = rows.turnBoundary.val;
  const stats = (rows.sessionStats && rows.sessionStats.val) || {};
  return {
    file,
    id: path.basename(file, '.json'),
    open: boundary.openTurnStartSeq,
    lastTurn: boundary.lastTurn,
    startedTurns: stats.turns,
    title: (rows.title && rows.title.val) || '',
    cwd: (json.record.identity && json.record.identity.cwd) || '',
    outlineTurns: (rows.turnOutline && rows.turnOutline.val && rows.turnOutline.val.turns) || [],
    userQuestions: (rows.userQuestions && rows.userQuestions.val) || null,
    goal: (rows.goal && rows.goal.val) || null,
    plan: (rows.plan && rows.plan.val) || null,
  };
}

/** The reply text of the newest turn that has one, or ''. */
function lastResponse(session) {
  const turns = session.outlineTurns || [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = turns[i] && turns[i].response;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

/**
 * Finished, waiting on the user, or broken — read from DSH's own fields.
 *
 * Order matters: a failure outranks a question (a question left over from a broken task
 * must not hide the failure), and a paused goal is reported as `wait` rather than `done`
 * so the notification does not claim work finished that is sitting paused.
 *
 * ── `plan` 是**批准**，不是**提问**（2026-10-09 · 依据是 DSH 自己的原文）──────────
 * 证据不在会话 JSON 里，在程序本体（`…/Programs/DeepSeek Harness/resources/app.asar`）：
 *
 *   「实时 `pendingInteraction` 分类：审批显示**等待审批**，计划审阅显示**计划待审**，
 *     普通问题显示**等待回答**。」
 *   「在 `exit_plan_mode` 审阅上设置——渲染紧凑审批卡片，顶部为带"查看全文"链接的
 *     "计划待审"条带……底部提供"要求修改"和"同意执行"。」
 *   「目前唯一的标记是 `plan-review`，其 `detail` 是待审阅的计划，`approve` 指明表示
 *     同意的选项。」
 *
 * 即 DSH 自己就把「计划审阅」和「等待回答」分成两类；plan 要的不是**答案**，是一次
 * **点头**（它的按钮是「要求修改 / 同意执行」）。所以这里报 `❓ 等你批准`。
 * （早先这条注释里写的"原文措辞是「计划待你确认」"是我编的，程序里没有这句话；
 *   真原文是「计划待审」—— 2026-10-09 审核时按 app.asar 原文改正。）
 *
 * ⚠️ **想找比 `plan.active` 更精确的信号是白费力气**：`pendingInteraction` /
 * `exit_plan_mode` / `plan-review` 都**不落盘**（实测 grep 5 个真实会话，全部 0 命中），
 * 只活在运行时内存与 UI 层。落盘可用的就是 `plan` 这一份。
 *
 * ⚠️ **本机 5 个真实会话里 `plan.active` 全是 `false`** —— 这条分支至今**真机 0 次触发**，
 * 和 Codex 的审批分支同病：字段结构已实测确认存在，但**无法用真实数据证伪**，只能靠
 * 行为回归锁兜住（`test-agent-watch.js`：改回 `ask` 即变红）。
 *
 * ⚠️ **`permissions` 那一行不是状态，是设置**：本机 5 个真实会话里实测到两种取值
 * （`approval:"ask"` 3 个 / `approval:"never"` 2 个），它是**权限预设**，不会随
 * "此刻是否卡在人身上"变化。真正的实时状态只有 `userQuestions` / `plan` / `goal`
 * 这三个 —— 别把设置字段当信号用。
 */
function detectState(session) {
  const questions = (session.userQuestions && session.userQuestions.questions) || {};
  const activeAsks = Array.isArray(questions.active) ? questions.active.length : 0;
  const goal = session.goal || {};
  const plan = session.plan || {};

  if (goal.failure) return { state: 'error', why: '任务出错，进去看一眼' };
  if (activeAsks > 0) return { state: 'ask', why: '在等你选一个选项' };
  if (plan.active || plan.running) return { state: 'approval', why: '等待批准（计划待审）' };
  if (goal.current || goal.paused) return { state: 'wait', why: '目标已暂停' };
  return { state: 'done', why: '已经做完了' };
}

module.exports = {
  id: 'dsh',
  label: 'DSH',
  dirs: DISCOVERY.dirs,
  depth: DISCOVERY.depth,
  filePattern: DISCOVERY.filePattern,
  mode: 'rewrite',
  pollMs: 1500,

  snapshot(json, info) {
    const session = readSession(json, info.file);
    if (!session) return null;

    const key = `sess:${info.file}`;
    const prev = info.cache.get(key);

    if (!prev) {
      // First sight: whatever already finished here is history, not news. Remember which
      // turn that was so a later rewrite cannot resurrect it (see the header).
      info.cache.set(key, {
        open: session.open,
        lastTurn: session.lastTurn,
        turnStartMs: null,
        baselineTurn: session.lastTurn,
      });
      return null;
    }

    const wasOpen = isOpen(prev.open);
    const nowOpen = isOpen(session.open);
    const turnChanged = session.lastTurn !== prev.lastTurn;

    // Remember when the turn began, so the notification can carry a duration.
    let turnStartMs = prev.turnStartMs;
    if (nowOpen && (!wasOpen || turnChanged)) turnStartMs = Date.now();

    info.cache.set(key, {
      open: session.open,
      lastTurn: session.lastTurn,
      turnStartMs,
      baselineTurn: prev.baselineTurn,
    });

    // Closed = we watched it open and now it is shut, or it opened and shut between two
    // polls and the turn id moved. Anything else is just another rewrite of a quiet file.
    const justClosed = wasOpen && !nowOpen;
    const turnAdvanced = !wasOpen && !nowOpen && turnChanged;
    if (!justClosed && !turnAdvanced) return null;

    if (session.lastTurn === prev.baselineTurn) return null; // the turn we attached on

    const { state, why } = detectState(session);
    return {
      // Session + turn: turn ids restart per session, so the turn alone is not an identity.
      key: `${session.id}#${session.lastTurn}`,
      state,
      // `approval` 和 `ask` 一样是阻塞态，必须拿到同样的高优先级 —— 漏掉它会让
      // "等你在计划上点头"这条通知被优先级门槛吞掉。
      priority: state === 'error' ? 5 : state === 'ask' || state === 'approval' ? 4 : 0,
      // The real reply, not the state label — the label is already in the title.
      text: lastResponse(session) || session.title || why,
      conversation: session.title || '',
      cwd: session.cwd,
      kind: state === 'approval' ? 'ask-approval' : 'turn-end',
      elapsedMs: turnStartMs ? Date.now() - turnStartMs : undefined,
      log: why,
    };
  },

  /** `--status` extra: every session, whether it is mid-turn, and how many turns it has. */
  diagnose(ctx) {
    const lines = [];
    for (const { file } of ctx.listFiles(DISCOVERY)) {
      let json;
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        lines.push(`  ${path.basename(file).slice(0, 22)}…  读取失败/写入中`);
        continue;
      }
      const s = readSession(json, file);
      if (!s) {
        lines.push(`  ${path.basename(file).slice(0, 22)}…  无轮次边界（DSH 还没在此会话干过活）`);
        continue;
      }
      lines.push(
        `  ${s.id.slice(0, 22)}…  在途=${isOpen(s.open) ? '是' : '否'}  轮次=${s.startedTurns}` +
          `  标题="${s.title}"`,
      );
    }
    return lines;
  },
};
