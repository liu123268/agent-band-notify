'use strict';
/**
 * WorkBuddy adapter.
 *
 * Where the log is
 * ----------------
 * WorkBuddy writes one append-only JSONL transcript per conversation:
 *
 *   ~/.workbuddy/projects/<项目文件夹>/<sessionId>.jsonl
 *
 * (the project folder is the workspace path flattened, e.g. `d-dsh-workspace-band-notify`).
 * One line = one event; the file is only ever appended to. That is the same shape
 * as Codex's rollout, which is why the same engine can read both.
 *
 * What "the turn is over" looks like
 * ----------------------------------
 * Assistant text is written as `{"type":"message","role":"assistant", ...}` — but a
 * whole turn emits SEVERAL of those (one per model round that produced prose), so the
 * event type alone does NOT mean "finished". The discriminator is the `message`
 * field:
 *
 *   中间轮次:  {"type":"message","role":"assistant", "content":[{"type":"output_text",...}]}          ← 无 message
 *   轮次结束:  {"type":"message","role":"assistant", "message":{"usage":{...}}, "content":[...]}      ← 有 message
 *
 * Measured on 547 real occurrences across 80 sessions: every assistant message that
 * carried a `message`/`usage` object was followed by either a new user message, the
 * end of the file, or a fork boundary — NEVER by a tool call or another model round.
 * That is the analogue of Codex's `task_complete`, and it is what this adapter keys on.
 *
 * Conversation name
 * -----------------
 * Taken from the session's `{"type":"ai-title","aiTitle":"…"}` event. Titles are
 * written once, early, so the file is scanned from its head the first time a turn
 * fires and the answer is cached (see the engine's per-adapter cache).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR =
  process.env.BAND_NOTIFY_WORKBUDDY_DIR || path.join(os.homedir(), '.workbuddy', 'projects');

/** How far into a transcript to look for the ai-title event (titles land early). */
const TITLE_SCAN_BYTES = 4 * 1024 * 1024;

/** The assistant's prose, out of the content array. */
function outputText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/** Last `ai-title` event in a transcript, without parsing the whole file. */
function readTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const cap = Math.min(size, TITLE_SCAN_BYTES);
    const buf = Buffer.alloc(cap);
    const n = fs.readSync(fd, buf, 0, cap, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const marker = text.lastIndexOf('"ai-title"');
    if (marker === -1) return '';
    const start = text.lastIndexOf('\n', marker) + 1;
    const end = text.indexOf('\n', marker);
    const line = text.slice(start, end === -1 ? undefined : end).trim();
    const parsed = JSON.parse(line);
    return typeof parsed.aiTitle === 'string' ? parsed.aiTitle.trim() : '';
  } catch {
    return '';
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
 * Read the conversation name, memoised per file.
 *
 * Titles land early in the transcript, so `readTitle` scans the head and this caches
 * the answer under the engine's persisted per-adapter memo — otherwise every turn (and
 * every ask) would re-read up to 4MB.
 */
function conversationOf(info) {
  const cache = info.cache;
  const cacheKey = `title:${info.file}`;
  let conversation = cache.get(cacheKey);
  if (conversation === undefined) {
    conversation = readTitle(info.file);
    cache.set(cacheKey, conversation);
  }
  return conversation;
}

/**
 * Locate the transcript of one session id.
 *
 * `<PROJECTS_DIR>/<flattened workspace>/<sessionId>.jsonl` — the workspace folder is not
 * derivable from the session id, so this walks the (shallow, one-level) project folders.
 *
 * Needed by `workbuddy-approval.js`: the security-centre audit log identifies a session
 * only by `sessionId`, while the notification has to show the conversation NAME (a raw
 * UUID tells the user nothing). It lives HERE rather than in the approval adapter because
 * a second hand-written copy of this reader is a second thing to keep in sync when
 * WorkBuddy moves its folders — the "手抄副本会替旧规则说话" lesson, applied to a reader.
 *
 * ⚠️ A FAILED lookup is NOT cached — only a hit is. Memoising the miss would turn one
 * transient failure (folder briefly locked, project not created yet) into a permanent
 * verdict for the rest of the process. Same rule that bit `codex.js`'s `threadKind()`:
 * 只有成功的读取才允许进缓存.
 */
function findSessionFile(sessionId, cache) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const cacheKey = `session-file:${id}`;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }
  let found = '';
  try {
    for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(PROJECTS_DIR, entry.name, `${id}.jsonl`);
      if (fs.existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  } catch {
    /* no projects dir (software never used here) — not an error */
  }
  if (found && cache) cache.set(cacheKey, found);
  return found;
}

/**
 * Tools that BLOCK the turn until the human answers.
 *
 * This is the ONE place in the whole project where "the AI is waiting for you" is an
 * explicit FIELD instead of a guess about prose — so it is the signal to trust.
 */
const ASK_TOOLS = new Set(['AskUserQuestion']);

/** The question(s) being asked, out of the tool call's `arguments` JSON string. */
function askText(rawArguments) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawArguments || ''));
  } catch {
    return '';
  }
  const list = parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
  return list
    .map((q) => (q && typeof q.question === 'string' ? q.question.trim() : ''))
    .filter(Boolean)
    .join(' ／ ');
}

/**
 * A blocking ask that is IN FLIGHT.
 *
 * Detected on the `function_call` line itself, NOT at turn end — because at that
 * moment there IS no turn end to detect: the tool blocks, the human answers, and the
 * SAME turn carries on with the answer in hand. Verified on a live transcript:
 *
 *   719 message           ← assistant prose
 *   720 function_call     present_files
 *   722 function_call     AskUserQuestion      ← announce HERE
 *   723 function_call_result                  ← the user's answer comes back
 *   724 reasoning                             ← same turn continues
 *
 * So keying on the turn end would announce the question only AFTER it had already been
 * answered — i.e. never usefully. This was a real miss: a turn asked the user three
 * questions and the only notification produced was "✅ 已完成".
 *
 * The key is the event's own id, which is stable across a restart and across a fork
 * that replays history verbatim — the same dedup guarantee the turn key has, and it
 * cannot collide with a turn key.
 */
function askPending(event, info) {
  if (!event || event.type !== 'function_call') return null;
  if (!ASK_TOOLS.has(String(event.name || ''))) return null;
  return {
    key: `ask:${event.id || event.callId || ''}`,
    state: 'ask',
    priority: 4,
    text: askText(event.arguments),
    conversation: conversationOf(info),
    cwd: event.cwd || '',
    kind: 'ask-pending',
    log: '等待回答（正在提问）',
  };
}

module.exports = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  dirs: [PROJECTS_DIR],
  depth: 2,
  filePattern: /\.jsonl$/i,
  mode: 'append',
  pollMs: 2000,

  /**
   * @param {object} event one parsed JSONL line
   * @param {object} info  { file, cache }
   * @returns {null|object} notice descriptor, or null if this line is not a turn end
   */
  turnEnd(event, info) {
    // A blocking ask is announced the moment it happens, not when the turn ends —
    // see askPending above for why it cannot wait.
    const pending = askPending(event, info);
    if (pending) return pending;

    if (!event || event.type !== 'message' || event.role !== 'assistant') return null;
    // The `message` field (usage accounting) is what the host attaches ONLY to the
    // message that closes the turn. Anything else is a mid-turn prose round.
    if (!event.message || typeof event.message !== 'object') return null;

    const text = outputText(event.content);
    const sessionId = String(event.sessionId || '');

    // ── TEXT GUESSING REMOVED for WorkBuddy (2026-10-06) ─────────────────────────
    // This adapter used to end with `const asking = looksLikeAsk(text)` — guessing
    // "is it waiting for me?" from the closing prose. It is gone, and it should not
    // come back. Three independent reasons, all measured:
    //
    // 1. IT ALREADY HAS THE EXACT SIGNAL, EARLIER. `askPending` above fires on the
    //    `AskUserQuestion` function_call — the moment the question is asked, with the
    //    question text in hand. Guessing again at turn end can only duplicate it.
    //
    // 2. THE GUESS IS MEASURABLY WORTHLESS HERE. Over 162 real WorkBuddy turn-ends
    //    it flagged 100 (61.7%), while the same transcripts contain only 14 genuine
    //    AskUserQuestion calls. And the behavioural check (src/turn-text.js, measured
    //    2026-10-05) found 0 of 141 flagged WorkBuddy turns were followed by an
    //    actual answer. 61.7% flagged / 0% answered = it carries no information, it
    //    only trains the user to ignore ❓.
    //
    //    Why so noisy, specifically: WorkBuddy is used here as a TEACHER, and its
    //    lessons end with Socratic prompts — "想想为什么可以凭空加属性？",
    //    "做完告诉我按钮红了没有。". Those are sign-offs, not handovers.
    //
    // 3. BY CONSTRUCTION A FINISHED WORKBUDDY TURN CANNOT BE BLOCKED. AskUserQuestion
    //    is a BLOCKING tool: the agent asks, the log waits, the human answers, and
    //    only then does the turn finish. So if a turn ENDED, no question of its own
    //    is still open. (Verified: 36 calls, 0 ended unanswered.) The exact signal
    //    is announced when it happens — precisely because waiting for the turn end
    //    would announce it after the user had already replied.
    //
    // The user's own words, 2026-10-06: "之前 WorkBody 也没有出这样的错，结果现在你
    // 也是这样的错" — and they were right; this was the only place in the project
    // where a first-class field existed and the code guessed anyway.
    //
    // KNOWN COST, accepted: if the model asks in PROSE without calling
    // AskUserQuestion, that turn is announced as ✅ and the body is clipped from the
    // START (see clipByState in src/notice.js) — so a question sitting at the very
    // end of a reply may go unread. Traded against 61.7% noise. If that trade ever
    // looks wrong, fix it by making the model call the tool, not by re-adding the
    // guess: BAND_NOTIFY_ASK_FROM_TEXT does NOT apply here any more.
    return {
      // Stable across restarts and across a fork that replays history verbatim.
      key: String(event.id || `${sessionId}:${event.timestamp || ''}`),
      state: 'done',
      priority: 0,
      text,
      conversation: conversationOf(info),
      cwd: event.cwd || '',
      kind: 'turn-end',
      log: '任务完成',
    };
  },

  /** Fallback shown when no title is available yet: the workspace folder. */
  conversation(info) {
    return String(info.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
  },

  /**
   * Shared with `workbuddy-approval.js` (WorkBuddy's second data source — the security
   * centre audit log). It resolves a bare `sessionId` to a conversation name through the
   * exact same reader used here, so the two data sources can never disagree about what a
   * conversation is called.
   */
  readTitle,
  findSessionFile,
};
