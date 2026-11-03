'use strict';
/**
 * ZCode adapter.
 *
 * Where the log is
 * ----------------
 * ZCode keeps a rotating daily event log, one JSON line per event:
 *
 *   ~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl
 *
 * Unlike Codex/WorkBuddy transcripts (one file per conversation, appended forever),
 * this one is shared by every conversation and rolls over at midnight — so the engine
 * sees several files and must key its read offsets per file, which it already does.
 *
 * What "the turn is over" looks like
 * ----------------------------------
 * ZCode writes an explicit lifecycle, verified on real data:
 *
 *   turn.started       {"sessionId":"sess_…","turnId":"turn_…","context":{"turnNumber":4}}
 *   turn.phase.completed  ×N   (context_initialization / target_read / regular_turn_loop …)
 *   turn.completed     {"sessionId":"sess_…","turnId":"turn_…","durationMs":296513,
 *                       "status":"completed","context":{"toolCallCount":4}}
 *
 * `turn.completed` is the authoritative end-of-turn marker — the analogue of Codex's
 * `task_complete` and WorkBuddy's usage-stamped final message.
 *
 * Getting the reply text
 * ----------------------
 * The event log deliberately holds no message bodies; the model traffic lives in a
 * per-session file, one record per model round-trip:
 *
 *   ~/.zcode/cli/rollout/model-io-sess_<id>.jsonl
 *     {"turnId":"turn_…","querySource":"main_turn",
 *      "response":{"finishReason":"stop","text":"<最终回复>","toolCalls":[…]}}
 *
 * So the adapter joins the two by `turnId`, reading only the TAIL of the rollout file
 * (those files reach tens of MB because every request carries the full prompt).
 *
 * Known gap: ZCode stores no human conversation title in a plain file (it is inside
 * `~/.zcode/v2/tasks-index.sqlite`, which would need a SQLite dependency and break the
 * project's zero-dependency rule). The notification therefore shows a short session id.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { looksLikeAsk } = require('../turn-text.js');

const CLIENT_DIR = process.env.BAND_NOTIFY_ZCODE_DIR || path.join(os.homedir(), '.zcode', 'cli');
const LOG_DIR = path.join(CLIENT_DIR, 'log');

/**
 * Where the reply text lives (`model-io-<sessionId>.jsonl`).
 *
 * ZCode keys these by session id rather than by the log file the engine hands us, so the
 * path cannot be derived from `info.file`. Resolved per call on purpose: `dirs` (LOG_DIR,
 * what the engine scans) must stay pointed at the real install while the test suite feeds
 * reply text from a fixture directory via `BAND_NOTIFY_ZCODE_ROLLOUT_DIR`. Same
 * env-override convention as codex.js's BAND_NOTIFY_CODEX_DIR.
 */
function rolloutDir() {
  return process.env.BAND_NOTIFY_ZCODE_ROLLOUT_DIR || path.join(CLIENT_DIR, 'rollout');
}

/**
 * How much of a rollout file's tail to search for the reply. A single record embeds
 * the whole request (system prompt + history), so records reach megabytes; 8 MB is
 * enough to cross several.
 */
const TAIL_BYTES = 8 * 1024 * 1024;

/** Subagent conversations get their own session ids; only the user's turn matters. */
function isSubagent(sessionId) {
  return /subagent/i.test(String(sessionId || ''));
}

/**
 * Records from the tail of a JSONL file, newest last. Lines that cannot be parsed
 * (the buffer starts mid-line, or a record is truncated) are skipped, not fatal.
 */
function tailRecords(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // The first fragment is only a partial line when we did not start at byte 0.
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        /* truncated or mid-write; the next poll will re-read it */
      }
    }
    return out;
  } catch {
    return [];
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

/** Final assistant text for one turn, or '' when the rollout is missing/unreadable. */
function replyText(sessionId, turnId) {
  if (!sessionId || !turnId) return '';
  const file = path.join(rolloutDir(), `model-io-${sessionId}.jsonl`);
  const records = tailRecords(file, TAIL_BYTES);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    if (rec.turnId !== turnId) continue;
    const text = rec.response && rec.response.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

module.exports = {
  id: 'zcode',
  label: 'ZCode',
  dirs: [LOG_DIR],
  depth: 1,
  filePattern: /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/,
  mode: 'append',
  pollMs: 3000,

  turnEnd(event, info) {
    if (!event || typeof event !== 'object') return null;
    const name = event.event;
    if (name !== 'turn.completed' && name !== 'turn.failed') return null;
    const sessionId = String(event.sessionId || '');
    if (isSubagent(sessionId)) return null;

    const turnId = String(event.turnId || '');
    const failed = name === 'turn.failed' || (event.status && event.status !== 'completed');
    const text = failed ? '' : replyText(sessionId, turnId);

    // Same policy layer as the Codex / WorkBuddy adapters: `looksLikeAsk`, never
    // `looksLikeQuestion`, so one env var (`BAND_NOTIFY_ASK_FROM_TEXT=0`) turns the guess
    // off for every software at once. ON by default since 2026-10-05: ZCode exposes no ask
    // field, so without this a turn that ends by asking the user something was announced as
    // "✅ 已完成" — the exact error the user chose to trade for a noisier `❓`.
    const asking = !failed && looksLikeAsk(text);

    // The session id is the only stable identity ZCode exposes in a readable file.
    // Cut at the first '-' so the user sees `19239d85` rather than a truncated UUID.
    const conversation = sessionId.replace(/^sess_/, '').split('-')[0].slice(0, 12) || 'ZCode';

    return {
      key: turnId || `${sessionId}:${event.timestamp || ''}`,
      state: failed ? 'error' : asking ? 'ask' : 'done',
      priority: failed ? 5 : asking ? 4 : 0,
      text: text || (failed ? '轮次失败，进去看一眼' : ''),
      conversation,
      cwd: '',
      kind: failed ? 'turn-failed' : 'turn-end',
      elapsedMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : undefined,
      log: failed ? '轮次失败' : asking ? '等待回答' : '任务完成',
    };
  },

  conversation() {
    return 'ZCode';
  },
};
