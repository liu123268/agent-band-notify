'use strict';
/**
 * Normalises the many shapes of "a turn just finished" into one notice object.
 * Handles: DSH watcher events, DSH Stop-hook events, Codex `notify` payloads,
 * Claude Code Stop hooks, raw JSON on stdin, plain text.
 *
 * The rendered message reads like:
 *   ✅ 已完成 · DSH · 小米手环AI完成振动提醒方案 · 已经改好了
 */

/**
 * task state -> { emoji, label }
 *
 * `approval` (2026-10-09) is a SEPARATE state from `ask`, not a reuse of it:
 *
 *    ask      — the model asked a question and is waiting for an answer
 *    approval — WorkBuddy's security centre is waiting for a yes/no on an ACTION
 *               (allow this network host / approve this bulk delete)
 *
 * They share the ❓ emoji because the user-facing meaning is identical ("the ball is in
 * your court, go look"), and they share priority 4 for the same reason. They are kept
 * apart because the two arrive through completely different data sources
 * (transcript vs audit-log) and a future tweak to one must not silently move the other.
 */
const STATES = {
  done: { emoji: '✅', label: '已完成' },
  ask: { emoji: '❓', label: '等你回答' },
  approval: { emoji: '❓', label: '等你批准' },
  error: { emoji: '⚠️', label: '出错了' },
  wait: { emoji: '⏸️', label: '已暂停' },
  start: { emoji: '▶️', label: '已开始' },
};

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function clip(text, max) {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const limit = Number(max) > 0 ? Number(max) : 60;
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * 截断方向随状态而变。
 *
 * ❓「等你回答」时，用户唯一需要知道的是"要我回答什么"，而**提问在结尾** ——
 * 这也正是 `src/turn-text.js` 判定 ❓ 的依据（它看的就是结尾）。如果还是截开头，
 * 通知就变成"说在等你、却不告诉你等什么"，用户只能干看着。
 * （2026-10-05 实测踩到：正文截的是开头的排查分析，那句"要不要补发"完全没进通知。）
 *
 * 其余状态要回答的是"这轮干了什么"，摘要给开头才对。
 */
function clipByState(text, max, state) {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const limit = Number(max) > 0 ? Number(max) : 60;
  if (flat.length <= limit) return flat;
  return state === 'ask' ? `…${flat.slice(-(limit - 1))}` : `${flat.slice(0, limit - 1)}…`;
}

/** Try hard to find the assistant's last message inside an arbitrary payload. */
function digForText(node, depth = 0) {
  if (!node || depth > 6) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i -= 1) {
      const found = digForText(node[i], depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof node !== 'object') return '';
  const preferred = [
    'last_assistant_message',
    'last-assistant-message',
    'lastAssistantMessage',
    'assistantMessage',
    'message',
    'text',
    'content',
    'summary',
    'preview',
    'output',
  ];
  for (const key of preferred) {
    if (key in node) {
      const found = digForText(node[key], depth + 1);
      if (found) return found;
    }
  }
  return '';
}

/** Human-readable duration: 45秒 / 1.5分钟 / 21分钟 */
function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const seconds = Math.round(n / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = n / 60000;
  if (minutes < 10) return `${minutes.toFixed(1)}分钟`;
  return `${Math.round(minutes)}分钟`;
}

/** Path -> folder name (the conversation identity we fall back to). */
function folderName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/** Codex's notify payload carries the thread id; resolve it to the sidebar name. */
function codexThreadName(payload) {
  const id = firstString(payload['turn-id'], payload.turnId, payload.thread_id, payload.session_id);
  if (!id) return '';
  try {
    return require('./codex-threads').threadName(id);
  } catch {
    return '';
  }
}

/**
 * Some producers (notably Codex's computer-use wrapper) pass their whole command
 * line through as positional arguments, so the payload arrives as fragments like
 * `["C:\...\node.exe",` / `--previous-notify` / `"C:\...\notify.js"`. None of that
 * is a message, and none of it identifies a conversation.
 */
function looksLikeNoise(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/--previous-notify/.test(s)) return true;
  if (/\.(exe|cmd|bat|js|mjs|cjs|json)\b/i.test(s)) return true; // program / config
  if (/^\[\[/.test(s) || /^\{["']/.test(s)) return true;
  if (/[\\/]{2,}/.test(s) && /["'[\]]/.test(s)) return true; // path + quoting = command line
  if (/^[0-9a-f]{8,}$/i.test(s)) return true; // opaque id, not a conversation name
  return false;
}

/**
 * True when the argument list looks like a forwarded command line rather than a
 * message — i.e. we were invoked through Codex's computer-use wrapper.
 */
function looksLikeForwardedCommand(argv) {
  return (argv || []).some((a) => /--previous-notify/.test(a) || /codex-computer-use/i.test(a));
}

function renderTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== '' ? String(vars[key]) : '',
  );
}

/** Collapse "a ·  · b" / lone separators left behind by empty tokens. */
function tidy(text) {
  return String(text)
    .replace(/\s*·\s*(?=·)/g, '')
    .replace(/^[\s·]+|[\s·]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * @param {object} raw   parsed payload from the source (may be {})
 * @param {object} meta  { agent, source, kind, state, title, body, preview,
 *                         conversation, duration, durationMs, priority, tags }
 * @param {object} cfg
 */
function buildNotice(raw, meta, cfg) {
  const payload = raw && typeof raw === 'object' ? raw : {};

  const wantedState = firstString(meta.state, payload.state, 'done');
  const state = Object.prototype.hasOwnProperty.call(STATES, wantedState) ? wantedState : 'done';
  const { emoji, label } = STATES[state];

  const agent = firstString(meta.agent, payload.agent, payload.source, 'AI');
  // "which conversation": explicit name, else Codex's thread name, else the project
  // folder. Raw session ids are deliberately not used — a UUID tells the user
  // nothing, and the folder at least identifies the workspace.
  const conversation = clip(
    firstString(
      ...[
        meta.conversation,
        payload.conversation,
        codexThreadName(payload),
        payload.session_name,
        payload.thread_name,
        folderName(payload.cwd),
        folderName(process.cwd()),
      ].filter((v) => !looksLikeNoise(v)),
    ),
    cfg.conversationMax || 16,
  );
  const summary = clipByState(
    firstString(...[meta.preview, digForText(payload)].filter((v) => !looksLikeNoise(v))),
    cfg.previewMax,
    state,
  );
  const duration = firstString(meta.duration, formatDuration(meta.durationMs));

  const vars = {
    agent,
    software: agent,
    state: `${emoji} ${label}`,
    stateEmoji: emoji,
    stateLabel: label,
    conversation,
    project: conversation,
    summary,
    preview: summary,
    duration,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    kind: firstString(meta.kind, payload.type, 'turn-end'),
    cwd: firstString(payload.cwd, process.cwd()),
  };

  let title = tidy(firstString(meta.title, renderTemplate(cfg.title, vars)));
  let body = tidy(firstString(meta.body, renderTemplate(cfg.body, vars)));

  // Templates render empty when a token is missing; rebuild defensively so a
  // notification is never blank.
  if (!title) title = `${emoji} ${label}`;
  if (!body) {
    body = tidy([`【${agent}】`, conversation, summary, duration].filter(Boolean).join(' · '));
  }
  if (!body) body = `${emoji} ${label}`;

  return { title, body, priority: meta.priority, tags: meta.tags, vars, state };
}

/** Parse a command-line / stdin blob into a payload object. */
function parseLoose(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // A malformed JSON-looking argument (Codex's computer-use wrapper re-escapes
      // the whole command line) is not a message; drop it rather than shipping a
      // blob of paths to the watch.
    }
  }
  if (looksLikeNoise(trimmed)) return {};
  return { message: trimmed };
}

module.exports = {
  buildNotice,
  parseLoose,
  clip,
  renderTemplate,
  formatDuration,
  folderName,
  firstString,
  looksLikeNoise,
  looksLikeForwardedCommand,
  STATES,
};
