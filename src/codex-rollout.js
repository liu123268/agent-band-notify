'use strict';
/**
 * Read Codex conversation data straight from its rollout files.
 *
 * Layout: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<session_id>[_<thread_id>].jsonl
 * Each line is one JSON object. The assistant's replies appear as
 *   { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text }] } }
 *
 * The hook payload only carries the session id, so the file is located by that id.
 * Lookups are cached because this runs on every turn end.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const fileCache = new Map(); // sessionId -> absolute path

function findRollout(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  if (fileCache.has(id)) {
    const cached = fileCache.get(id);
    if (cached && fs.existsSync(cached)) return cached;
  }

  const want = id.toLowerCase();
  let best = null;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(p, depth - 1);
        continue;
      }
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      if (!entry.name.toLowerCase().includes(want)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { file: p, mtime };
    }
  };
  walk(SESSIONS_DIR, 3);

  const file = best ? best.file : null;
  fileCache.set(id, file);
  return file;
}

/** Pull the last assistant text out of a rollout file (reads from the end). */
function lastAssistantMessage(sessionId) {
  const file = findRollout(sessionId);
  if (!file) return '';
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return '';
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const p = o.payload || {};
    if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = (p.content || []).map((c) => c.text || '').join(' ').trim();
      if (text) return text;
    }
    // some builds log it as a plain event
    if (p.role === 'assistant' && typeof p.message === 'string' && p.message.trim()) {
      return p.message.trim();
    }
  }
  return '';
}

module.exports = { findRollout, lastAssistantMessage, SESSIONS_DIR };
