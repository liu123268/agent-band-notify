'use strict';
/**
 * Resolve a Codex thread id to its human-readable conversation name.
 *
 * Codex keeps `~/.codex/session_index.jsonl`, one JSON object per line:
 *   {"id":"01a106e2-...","thread_name":"Guardian review","updated_at":"..."}
 * The `notify` payload carries the same id in its `turn-id` field, so the real
 * conversation name (the one shown in the Codex sidebar) is available locally.
 *
 * Reading 200 lines is cheap, but it happens on every turn-end, so the parsed
 * index is cached with a short TTL.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const INDEX_FILE = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const TTL_MS = 60000;

let indexCache = null; // { at: number, map: Map<string, string> }
const resolveCache = new Map(); // sessionId -> threadId

function loadIndex() {
  const now = Date.now();
  if (indexCache && now - indexCache.at < TTL_MS) return indexCache.map;

  const map = new Map();
  try {
    const text = fs.readFileSync(INDEX_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && row.id && row.thread_name) {
          // Later lines win: the index is append-only and last write is newest.
          map.set(String(row.id), String(row.thread_name));
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    // No Codex installed, or the file is being rewritten; fall through empty.
  }
  indexCache = { at: now, map };
  return map;
}

/** @returns {string} the conversation name, or '' when unknown. */
function threadName(threadId) {
  const id = String(threadId || '').trim();
  if (!id) return '';
  const direct = loadIndex().get(id);
  if (direct) return direct;
  // A hook payload carries the SESSION id, while session_index.jsonl is keyed by
  // the THREAD id. The rollout filename links them:
  //   rollout-<timestamp>-<session_id>[_<thread_id>].jsonl
  const threadIdFromSession = resolveThreadId(id);
  if (threadIdFromSession && threadIdFromSession !== id) {
    return loadIndex().get(threadIdFromSession) || '';
  }
  return '';
}

/**
 * Map a session id to its thread id via the rollout filename.
 * @returns {string} thread id, or '' when it cannot be determined.
 */
function resolveThreadId(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const cacheKey = `session:${id}`;
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);

  let result = '';
  try {
    const { findRollout } = require('./codex-rollout');
    const file = findRollout(id);
    if (file) {
      const base = path.basename(file, '.jsonl');
      // rollout-<timestamp>-<session_id>[_<thread_id>]
      // The thread id is the trailing UUID when the name carries two of them.
      const uuids = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
      if (uuids.length >= 2) {
        result = uuids[uuids.length - 1];
      } else if (uuids.length === 1 && uuids[0].toLowerCase() !== id.toLowerCase()) {
        result = uuids[0];
      }
    }
  } catch {
    /* optional */
  }
  resolveCache.set(cacheKey, result);
  return result;
}

module.exports = { threadName, resolveThreadId, INDEX_FILE };
