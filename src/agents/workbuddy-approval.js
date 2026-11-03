'use strict';
/**
 * WorkBuddy · 安全中心「等你批准」适配器 —— WorkBuddy 的第二个数据源
 * ====================================================================
 *
 * 为什么有这个文件
 * ---------------
 * WorkBuddy 把「现在卡在人身上」这件事写在**两个互不相干**的地方，而 2026-10-09 之前
 * 只监听了一个：
 *
 *   1. 会话记录   ~/.workbuddy/projects/**\/*.jsonl
 *      → src/agents/workbuddy.js   （轮次结束、以及阻塞式 AskUserQuestion 提问）
 *   2. 安全中心审计日志 ~/.workbuddy/audit-log/**
 *      → 本文件                    （权限询问：允许访问某网络域名 / 批准批量删除）
 *
 * 缺口是一次真实漏报暴露的：16:03:43 用户被弹窗问了「允许访问 www.chinamoney.com.cn？」，
 * 手环没响。那个会话的记录里，工具调用与结果之间有**32 秒整的空白** —— 等待这件事根本
 * 没被写进去。而审计日志里写得清清楚楚：
 *
 *   16:03:43  network.ask-matched   decision=info       {"target":"www.chinamoney.com.cn"}
 *   16:04:05  network.approved      decision=approved
 *
 * 两个文件的 `toolCallId` 完全相同。一本账对「需要人的那一刻」只字未提，另一本用一等字段
 * 记着它。所以这**不是判定代码的 bug，是一个从没被接进来的数据源**。
 *
 * ⚠️ 这不是「WorkBuddy 的第二个所有者」
 * ------------------------------------
 * 项目铁律是「一个软件只能有一个所有者」—— 两个进程读**同一份**日志 = 每条通知发两遍。
 * 这里没有破坏它：两个适配器读的是**互不相交的文件**（会话记录 vs 审计日志），去重键的
 * 命名空间也不同（`workbuddy#` vs `workbuddy-approval#`）。没有任何东西被读两遍，
 * 所以也不可能有任何东西被发两遍。
 *
 * 报什么（以及同样重要的：不报什么）
 * --------------------------------
 * 判据沿用全项目同一条：**只在「用户成为阻塞点」的那一刻报**。在审计日志里，那就是
 * 事件名本身在说"正在问"、且 `decision:"info"` 的那些：
 *
 *   network.ask-matched                     ← 弹窗出现，等你决定   → 通知
 *   file-safety.bulk-delete.needs-approval  ← 弹窗出现，等你决定   → 通知
 *
 * 其余一律静默，且是**故意的**：
 *   *.approved                      —— 你已经决定过了，再告诉你纯属噪音
 *   command-safety.sandbox-executed —— 沙箱内正常执行（实测一小时几十条！）
 *   file-safety.allow-listed        —— 命中放行规则，压根没问过你
 *   command-safety.program-blacklist-blocked —— 拦死且不可批准，模型自己会换路子，
 *                                     没有你的事
 *
 * 这些静默项返回 `null`，不是 `{skip}`：`skip` 会写一行日志，而光 `sandbox-executed`
 * 一小时就是几十条 —— 全记下来会把「为什么当时没响」的证据淹掉，那正是本项目最需要的
 * 东西。
 *
 * 只读 spool
 * ----------
 * 审计目录有两层，而且内容重叠：
 *   spool/audit-spool-<pid>-<date>.jsonl  实时、小，**我们读这个**
 *   <date>.jsonl                          归档段，延迟可达数小时
 * 两个都读会重复上报（归档是把 spool 条目**复制**进日文件，带 `"source":"spool"` 标记）。
 * 只读 spool 既实时，又不重叠。
 *
 * 代价说明白：监听器若停机到 spool 被归档清空，那批询问不会稍后从日文件补发。接受 ——
 * 权限询问是有时效的，几小时后才推「有个弹窗等你批准」没有任何价值。
 *
 * 两个 engine 层面的新风险（会话记录那一路没有）
 * --------------------------------------------
 *  1. **文件名带 PID** —— WorkBuddy 一重启就是新的 spool 文件。引擎对首见的文件按
 *     "baseline 到末尾"处理（历史不是新闻），所以只会丢「我们第一次看见它之前那几秒」
 *     写入的内容。本机实测：新 spool 是空文件，实际不丢。
 *  2. **spool 归档时会被清空**。引擎把「文件变短」当轮转处理，现在会把读位**回退到 0**
 *     而不是新末尾（见 tools/agent-watch.js）—— 没有那处修正，与截断发生在同一轮询
 *     周期内的新内容会被永久跳过。重复读无妨，下面的 `claim()` 兜着。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const workbuddy = require('./workbuddy');

/** 测试接缝，沿用 BAND_NOTIFY_WORKBUDDY_DIR / _CODEX_DIR / _ZCODE_DIR 的同一约定。 */
const AUDIT_DIR =
  process.env.BAND_NOTIFY_WORKBUDDY_AUDIT_DIR || path.join(os.homedir(), '.workbuddy', 'audit-log');
const SPOOL_DIR = path.join(AUDIT_DIR, 'spool');
const SPOOL_PATTERN = /^audit-spool-.*\.jsonl$/i;

/**
 * 表示「WorkBuddy 此刻正在等你点头/摇头」的事件类型。
 *
 * **显式列出而不是用正则通配**是刻意的：`./approved`、`./allow-listed` 与这些名字只差
 * 一个词，松散的匹配正是「你已经同意了」这类事件开始乱响的入口。往这里加类型之前，
 * 必须先 grep 真实审计日志、确认它带 `decision:"info"` —— tools/check-approvals.js
 * 就是干这个的一条命令。
 */
const PENDING_EVENTS = new Set([
  // 允许访问某个网络目标（实测 target 形如 www.chinamoney.com.cn / biz.finance.sina.com.cn）
  'network.ask-matched',
  // 批准「批量删除」（params: count / threshold / targets，超过阈值才问）
  'file-safety.bulk-delete.needs-approval',
  // 访问 / 处理敏感路径（实测 params.paths 是 C:\Users\…\.ssh\id_rsa 这类）
  // ⚠️ 2026-10-09 补：这一条是**被可证伪等式逼出来的**。适配器起初只列了 bulk-delete
  //    版本，等式立刻给出「判定 28 条 / 日志事实 31 条」——差值正好是 7/16 与 9/14
  //    那 3 条通用版删除询问。**不要因为"最近没见过"就删掉它。**
  'file-safety.needs-approval',
  // 正文里检测到敏感信息，等你放行后才发给模型（params: itemCount / contentPreview）
  // 配套证据：sensitive-protection.approval-resolved（放行）/ .approval-timeout（超时 fail-close）
  'sensitive-protection.detected',
]);

function str(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 一行说清「在问你什么」，取自 `messageParams`。
 *
 * 刻意写短、写具体：`src/notice.js` 会把正文截到 `previewMax`（60 字），而等待类状态
 * 展示的是**开头** —— 要紧的字必须排在前面。
 */
function summarize(record) {
  const params =
    record.messageParams && typeof record.messageParams === 'object' ? record.messageParams : {};

  const target = str(params.target);
  if (target) return `访问 ${target}`;

  // file-safety.needs-approval：不是删除，而是"这条命令会碰到敏感文件"。
  // params.paths 是一个逗号分隔的长列表（实测可达十几个 .ssh 条目），取最能说明问题的
  // 那一截（末两段目录），并给出总数 —— 全文塞进去会被 previewMax 截成没用的开头。
  const paths = str(params.paths);
  if (paths) {
    const list = paths.split(',').map((s) => s.trim()).filter(Boolean);
    const label = (list[0] || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
    if (label) return list.length > 1 ? `访问敏感文件 ${label} 等 ${list.length} 个` : `访问敏感文件 ${label}`;
  }

  // sensitive-protection.detected：正文（或工具参数）里有敏感信息，等你决定放不放行。
  const itemCount = Number(params.itemCount);
  if (Number.isFinite(itemCount) && itemCount > 0) {
    return `正文含 ${itemCount} 处敏感信息，待放行`;
  }

  const count = Number(params.count);
  const targets = str(params.targets).replace(/[\\/]+$/, '');
  if (Number.isFinite(count) && count > 0) {
    const where = targets ? `（${path.basename(targets)}）` : '';
    return `批量删除 ${count} 个文件${where}`;
  }

  const preview = str(record.commandPreview).replace(/\s+/g, ' ');
  if (preview) return preview.slice(0, 140);
  return '有一项操作等你批准';
}

/**
 * 从审计日志唯一的身份字段 `sessionId` 反查会话名。
 *
 * 审计日志不知道「会话叫什么」，所以这里问 `workbuddy.js` 里那个记录读取器（**共享**，
 * 不复制）。兜底用 sessionId 短片段 —— 和 ZCode 适配器一个做法 —— 因为通知模板在没有
 * 会话名时会退到 `folderName(process.cwd())`，也就是**监听进程自己的工作目录**
 * （`band-notify`），那比不显示更误导。
 */
function conversationOf(record, info) {
  const sessionId = str(record.sessionId);
  if (!sessionId) return 'WorkBuddy';

  const cache = info && info.cache;
  const cacheKey = `conv:${sessionId}`;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }
  const file = workbuddy.findSessionFile(sessionId, cache);
  const title = file ? workbuddy.readTitle(file) : '';
  const conversation = title || sessionId.split('-')[0].slice(0, 12);
  if (cache && title) cache.set(cacheKey, conversation); // 只把命中的结果记进缓存
  return conversation;
}

/**
 * 稳定的去重键。
 *
 * `requestId + toolCallId + eventType` 精确标识一次询问：requestId 在同一个用户请求内的
 * 多个工具之间会重复，eventType 在一天里的每次询问之间会重复，三者齐全才唯一。
 * 引擎的 `claim()` 会按适配器加前缀隔离。
 */
function keyOf(record) {
  const parts = [record.requestId, record.toolCallId, record.eventType].map((v) => str(v));
  if (parts.every(Boolean)) return `approval:${parts.join(':')}`;
  return `approval:${str(record.sessionId, '?')}:${record.timestamp || ''}:${str(record.eventType, '?')}`;
}

module.exports = {
  id: 'workbuddy-approval',
  // label 与会话记录适配器**故意相同**：用户在通知里看到的是「【WorkBuddy】…」——
  // 对他而言只有一个 WorkBuddy，不存在两个数据源。
  label: 'WorkBuddy',
  dirs: [SPOOL_DIR],
  depth: 1,
  filePattern: SPOOL_PATTERN,
  mode: 'append',
  pollMs: 2000,

  turnEnd(event, info) {
    if (!event || typeof event !== 'object') return null;
    if (!PENDING_EVENTS.has(str(event.eventType))) return null;

    // 双保险：一条「正在询问」的事件，只在它**还在询问**时才是新闻。
    // `decision` 是审计日志自己的判定字段，比事件名更该被信任。
    const decision = str(event.decision);
    if (decision && decision !== 'info') return null;

    return {
      key: keyOf(event),
      state: 'approval',
      priority: 4,
      text: summarize(event),
      conversation: conversationOf(event, info),
      cwd: '',
      kind: 'ask-approval',
      log: '等待批准（正在询问）',
    };
  },

  conversation() {
    return 'WorkBuddy';
  },

  /**
   * `--status` 诊断：spool 里**此刻**有几条待批准，以及适配器实际会对此动作几条。
   *
   * 加这个是因为本项目反复要回答的问题是「它当时会不会响？」，而一个要在几百条事件里
   * 才浮出一条的数据源，必须能**不等真实弹窗**就查清楚。
   */
  diagnose({ listFiles }) {
    const files = listFiles({ dirs: [SPOOL_DIR], filePattern: SPOOL_PATTERN, depth: 1 });
    if (!files.length) return [`  spool: 没有 audit-spool-*.jsonl（目录: ${SPOOL_DIR}）`];

    const counts = {};
    let pending = 0;
    for (const { file } of files) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // 半行写入：下一轮会重读
        }
        const type = str(record.eventType);
        if (!type) continue;
        counts[type] = (counts[type] || 0) + 1;
        if (PENDING_EVENTS.has(type)) pending += 1;
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k}×${v}`)
      .join('，');
    return [
      `  spool: ${files.length} 个文件，事件 ${total} 条（${top || '空'}）`,
      `  其中「等你批准」${pending} 条（只报这类，其余静默）`,
    ];
  },
};
