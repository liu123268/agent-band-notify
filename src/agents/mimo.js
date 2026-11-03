'use strict';
/**
 * 小米 MiMo（Xiaomi MiMo 桌面版 / mimocode）适配器
 * =================================================
 *
 * 数据源只有**一个库**：`~/.local/share/mimocode/mimocode.db`，但里面有**三张**表各有用途。
 *
 *     · message     → 「✅ 已完成 / ⚠️ 出错了」   （这一轮结束了）
 *     · permission  → 「❓ 等你批准」            （有行 = 有人在等你点头）
 *     · part        → 「❓ 等你回答」            （工具卡在 running = 正在问你）
 *
 * ★ **桌面版和命令行版共用这个库**（2026-10-09 实证，用户问的就是"桌面版能不能用"）：
 *   `session.version` 有 `desktop-bdfe497`、`session.directory` 是 `D:\MiMo Desktop\…`，
 *   且 `session_prefix_snapshot.system` 开头写着 "You are MiMo agent in MiMo Desktop"。
 *   所以这一个适配器把**桌面版与 CLI 一起覆盖**了。
 *   桌面版另有 `AppData\Roaming\Xiaomi MiMo\db\{rolechat,artifacts,session-review}.db`，
 *   那是**界面附件/角色扮演**的库（role_chat_record 0 行），**不是**轮次与提问的来源。
 *
 * 「这个软件到底行不行、前后说法怎么变了三次」——一次说清
 * --------------------------------------------------------
 * 1. 最早判"不行"，理由是"读它要引入 SQLite 依赖，破坏零依赖"。
 *    ❌ **这条是错的**：`node:sqlite` 是 **Node 22 内置**模块，不是第三方依赖。
 * 2. 真正的障碍在**引擎**：rewrite 通道会先对文件 `JSON.parse`；对二进制库**每次轮询
 *    都失败**，适配器于是永远不会被调用 —— 那正是"注册表里有、实际永不发声"。
 *    → 2026-10-09 给引擎加了 `selfRead` 口子（`agent-watch.js` 的 `scanSnapshotProfile`）。
 * 3. 障碍消失后先只接了 `permission` 表（「等你批准」），因为"轮次结束"的字段还没查到。
 *    → 同一天下半场查清了：**`message.data.finish === "stop"`**。
 *
 * 所以三句话并不矛盾：**①判据错 → ②真障碍在引擎（已修）→ ③先接一半、再补另一半。**
 *
 * 轮次结束怎么判（一等字段，不是猜文字）
 * -------------------------------------
 *   assistant 消息的 `data.finish`：
 *     "stop"              → 这一轮结束            → ✅ 已完成
 *     "tool-calls"        → 还在调工具，轮次还没完 → 不报
 *     缺失 + `data.error` → 这一次请求失败了      → ⚠️ 出错了
 *
 *   实测（2026-10-09，本机 5 个会话 / 129 条消息 / 556 个片段）：
 *     tool-calls **96**、stop **14**、缺 finish **1**（那条正是 `APIError 403 未开通会员`）。
 *
 *   ⚠️ 两个"看着能用、其实不能用"的字段，已用真实数据排除，别再往回加：
 *     · `time.completed` —— 96 条 tool-calls **也都有** completed。用它会把一个 14 步的
 *       轮次报成 14 条通知（实测 110 : 14）。**唯一的分界是 `finish`。**
 *     · `actor_registry` —— `turn_count` 与真实 stop 数对不上（0/0/0/2/52 对 1/10/1/1/1）；
 *       且 5 行 `last_outcome` **全是 `failure`**（"Process restarted while actor was
 *       active"）。拿它当判据会把**每一轮**都报成"出错了"。
 *
 *   ⚠️ 子会话（`session.parent_id` 非空）一律 `skip` 并留日志：opencode 系谱用它标记
 *   派生会话，与 Codex 的 `parent_thread_id` 同类 —— 否则子代理干完一小步也会冒充
 *   "整个任务完成"。本机 5 个会话 parent 全为空，所以这条**真机 0 次触发**（结构确证、
 *   无法证伪），靠合成库回归锁着。
 *
 * 「等你批准」怎么判
 * ------------------
 * `permission` 表**非空** = 此刻有人在等你点头（裁决后清行）。本机 0 行 → 真机 0 次触发，
 * 结构确证、无法证伪，同样靠合成库回归锁着。判定与 ZCode 共用一份实现
 * （`opencode-permissions.js` 的 `approvalDescs`），避免两处漂移。
 *
 * 「等你回答」怎么判（★ 这里改过一次，且改的理由比结论重要）
 * ---------------------------------------------------------
 * ⚠️ 2026-10-09 白天我写的是：「MiMo 全库扫过，**没有任何**"我在等你回答"的字段，所以不报 ❓」。
 *    **那条是错的。** 我只看了 `message.data` 的键和每张表的行数，
 *    **没去看 `part.data.tool` 的取值** —— 而答案就躺在那儿：有个工具叫 `question`，
 *    本机**真的调用过 13 次**（输入 `questions[]`，答完写 `output: "User has answered…"`）。
 *    教训与项目里那条一样：**"本机没发生"≠"软件不记录"；
 *    要看程序本体（引擎/数据库的真实取值），别只看自己顺手打开的那一层。**
 *
 * 判据是一等状态字段（证据取自引擎本体 `mimo.exe` + 引擎日志）：
 *   · `part` 的工具状态机：`pending`（收到调用）→ `running`（开始执行）→ `completed`。
 *     引擎日志佐证：`service=tool.registry status=started question` …
 *     14 秒后 … `status=completed question`（那 14 秒就是人在作答）。
 *   · 对 `question` 工具，**"执行"就是等用户回答** → `tool==='question' && status==='running'`
 *     = **正在等你回答**。（`pending` 不报：调用刚发出、还没轮到，报了就是提前响。）
 *   · 第二类等待：**交互式 bash** —— `tool==='bash' && status==='running'
 *     && input.interactive === true`。引擎文档原文：*"Set to true when the command requires
 *     user interaction (password input, y/N confirmation, SSH key passphrase, etc)."*
 *
 *   ⚠️ 两条都是**结构确证、真机 0 次触发**（本机此刻未结束的工具调用 = **0 条**）。
 *   实在原因：MiMo 最近一次使用是 2026-10-03，适配器上线后它还没跑过一轮。
 *   靠合成库回归锁着；`diagnose()` 会把原始的未结束工具调用打出来，等真出现再收紧文案。
 *
 *   ⛔ **不把"模型在正文里提问"算进来** —— 那是猜文字。WorkBuddy 上试过：
 *   162 条判成"在提问"，真提问只有 14 次，**准确率 0%**。判据只许是字段。
 *
 * ★ 与「等你批准」的一处**故意不一致**：`approvalDescs` 首见即建基线（不报），
 *   而「等你回答」**不建基线**，靠引擎的 `claim()` 去重。理由：`running` 是**当前状态**
 *   而不是历史，且 `claim()` 跨重启持久，既不会重发、又能补上"监听停机期间被问到"的那次。
 *   别把这里改成"对齐"成基线 —— 那会把补发能力一起删掉。
 *
 * 依赖：`node:sqlite`（Node 22 内置模块，非第三方）。详见 opencode-permissions.js。
 */
const os = require('os');
const path = require('path');
const {
  approvalDescs,
  readTurnEnds,
  readTexts,
  readPendingAsks,
  TURN_CAP,
} = require('./opencode-permissions');

const DB_PATH =
  process.env.BAND_NOTIFY_MIMO_DB ||
  path.join(os.homedir(), '.local', 'share', 'mimocode', 'mimocode.db');

const ID = 'mimo';
const LABEL = 'MiMo';
// 记住多少个轮次键（有界，落盘进 agent-watch-cache.json）。**从共享模块导入**，
// 不再在本文件另写一个字面量 —— 两个同名字面量迟早会漂移，而这条漂移会静默误报。

/** 对话名：优先 session.title；取不到退回会话号前 12 位（绝不退回 watcher 自己的 cwd）。 */
function conversationOf(sessionId, title) {
  if (title && String(title).trim()) return String(title).trim();
  const s = String(sessionId || '').replace(/^ses_/, '');
  return s ? s.slice(0, 12) : LABEL;
}

module.exports = {
  id: ID,
  label: LABEL,
  dirs: [path.dirname(DB_PATH)],
  depth: 0,
  filePattern: /^mimocode\.db$/,
  mode: 'rewrite',
  selfRead: true,
  pollMs: 3000,

  /**
   * 一个库、两张表，所以一次快照可以同时产出两类通知（引擎支持返回数组）。
   * 返回 null 表示"这次没有新东西"。
   */
  snapshot(_json, info) {
    const descs = [];

    // ---------- ① 轮次结束（message 表 → ✅ / ⚠️）----------
    const turns = readTurnEnds(DB_PATH);
    if (turns.ok) {
      const prev = info.cache.get('turns');
      const prevKeys = Array.isArray(prev) ? new Set(prev) : null;

      if (!prevKeys) {
        // 首见 = 基线：否则每次重启都会把历史上 14 条轮次全部重播一遍。
        //
        // ⚠️ **不许截断**。读数器（`readTurnEnds`）已被 TURN_WINDOW 限住，所以这里原样
        // 记下全部即可。若在此处 `slice(0, 更小的数)`，落榜的旧轮次下一轮就会"变成新的"
        // 重播 —— 而它们**从没经过 `claim()`**，去重集拦不住。2026-10-09 红队复现过。
        info.cache.set('turns', turns.rows.map((r) => `turn:${r.id}`));
      } else {
        const fresh = turns.rows.filter((r) => !prevKeys.has(`turn:${r.id}`));
        if (fresh.length) {
          // 只对"新的、且真要报"的消息取正文 —— 窗口里通常躺着十几条历史 stop 消息，
          // 全取会把每次轮询变成十几次查询。
          const needText = fresh.filter((r) => r.kind === 'done' && !r.parent).map((r) => r.id);
          const texts = needText.length ? readTexts(DB_PATH, needText) : new Map();

          for (const r of fresh) {
            if (r.parent) {
              // 派生会话：是真实轮次，但故意不通知。必须留痕（引擎会写进日志）。
              descs.push({
                skip: '非用户线程（子会话）',
                detail: `session=${r.sessionId.slice(0, 16)} parent=${r.parent.slice(0, 16)}`,
              });
              continue;
            }
            const conversation = conversationOf(r.sessionId, r.title);
            if (r.kind === 'error') {
              descs.push({
                key: `turn:${r.id}`,
                state: 'error',
                priority: 5,
                text: r.errorText || '这一轮失败了，进去看一眼',
                conversation,
                cwd: '',
                kind: 'turn-failed',
                log: '轮次失败',
              });
              continue;
            }
            descs.push({
              key: `turn:${r.id}`,
              state: 'done',
              priority: 0,
              text: texts.get(r.id) || '',
              conversation,
              cwd: '',
              kind: 'turn-end',
              log: '任务完成',
            });
          }
        }
        // 这一批**全部**记账（含被跳过与失败的），否则同一批每轮都会重新判定一次：
        // 被跳过的会每轮刷一行日志，已通知的会走引擎的"跳过重复轮次"。
        info.cache.set(
          'turns',
          [...fresh.map((r) => `turn:${r.id}`), ...prevKeys].slice(0, TURN_CAP),
        );
      }
    }

    // ---------- ② 等你批准（permission 表 → ❓）----------
    const approvals = approvalDescs(DB_PATH, info, LABEL);
    if (approvals) descs.push(...approvals);

    // ---------- ③ 等你回答（part 表的工具状态机 → ❓）----------
    // `question` 工具卡在 running = 正在问你；`bash` + input.interactive = 命令等你输入。
    //
    // ⚠️ 这里**故意不建基线**（与 ② 的 approvalDescs 不同）：running 是"当前状态"而不是
    // 历史，靠引擎的 `claim()` 去重 —— 它跨重启持久，所以既不会重发，又能补上"监听停机
    // 期间被问到"的那一次。别"顺手对齐"成基线，那会把补发能力一起删掉。
    //
    // 缓存只存**当前可见**的键：工具状态只会向前走（running → completed），
    // 一旦答完就再也不会变回 running，所以"忘掉它"是安全的 —— 缓存天然保持极小。
    const asks = readPendingAsks(DB_PATH);
    if (asks.ok) {
      const prevAsk = info.cache.get('asks');
      const prevAskKeys = Array.isArray(prevAsk) ? new Set(prevAsk) : new Set();
      const currentAsks = new Map();
      for (const r of asks.rows) {
        const key = `ask:${r.callId}`;
        currentAsks.set(key, r);
        if (prevAskKeys.has(key)) continue; // 上一轮已经报过（含被 claim 拦下的），别每轮刷
        descs.push({
          key,
          state: 'ask',
          priority: 4,
          text: r.text,
          conversation: conversationOf(r.sessionId, r.title),
          cwd: '',
          kind: r.kind === 'interactive' ? 'ask-shell' : 'ask-question',
          log: r.kind === 'interactive' ? '等待回答（命令卡在等待输入）' : '等待回答（正在提问）',
        });
      }
      info.cache.set('asks', [...currentAsks.keys()]);
    }

    return descs.length ? descs : null;
  },

  conversation() {
    return LABEL;
  },

  diagnose() {
    const lines = [];
    const fs = require('fs');
    lines.push(`  数据库：${DB_PATH}${fs.existsSync(DB_PATH) ? '' : '（不存在）'}`);
    const mod = (() => {
      try {
        // eslint-disable-next-line global-require
        return require('node:sqlite');
      } catch {
        return null;
      }
    })();
    lines.push(`  node:sqlite：${mod && mod.DatabaseSync ? '可用' : '不可用（需要 Node 22+）'}`);

    const turns = readTurnEnds(DB_PATH);
    if (!turns.ok) {
      lines.push(`  message 表：读不到（${turns.reason}）`);
    } else {
      const done = turns.rows.filter((r) => r.kind === 'done').length;
      const failed = turns.rows.filter((r) => r.kind === 'error').length;
      const child = turns.rows.filter((r) => r.parent).length;
      lines.push(
        `  message 表：最近 ${turns.rows.length} 个轮次边界（完成 ${done} / 失败 ${failed} / 子会话 ${child}）`,
      );
      for (const r of turns.rows.slice(0, 5)) {
        lines.push(
          `    · ${r.kind === 'done' ? '✅' : '⚠️'} ${r.id.slice(0, 26)}  "${conversationOf(r.sessionId, r.title)}"${r.parent ? '  (子会话)' : ''}`,
        );
      }
    }

    const { readPermissions, parseData, keyOf, describe } = require('./opencode-permissions');
    const asks = readPendingAsks(DB_PATH);
    if (!asks.ok) {
      lines.push(`  part 表：读不到（${asks.reason}）`);
    } else {
      lines.push(
        `  part 表（等你回答）：${asks.rows.length} 个工具正在等你` +
          `${asks.rows.length ? '' : '（0 = 此刻没人被问、也没命令卡住，正常状态）'}`,
      );
      for (const r of asks.rows.slice(0, 5)) {
        lines.push(
          `    · [${r.kind}] callID=${r.callId.slice(0, 26)}  "${conversationOf(r.sessionId, r.title)}"`,
        );
        lines.push(`      正文将显示: ${r.text}`);
      }
    }

    const perms = readPermissions(DB_PATH);
    lines.push(
      perms.ok
        ? `  permission 表：${perms.rows.length} 行待处理`
        : `  permission 表：读不到（${perms.reason}）`,
    );
    for (const row of (perms.rows || []).slice(0, 5)) {
      const data = parseData(row.data);
      lines.push(`    · ${keyOf(row, data).slice(0, 60)}  字段: ${Object.keys(data).join(', ') || '(空)'}`);
      lines.push(`      正文将显示: ${describe(data)}`);
    }
    return lines;
  },
};
