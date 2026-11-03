'use strict';
/**
 * Duplicate gate: the same event must reach the phone once.
 *
 * Two independent paths can report one Codex turn — the turn watcher (reads the
 * rollout) and the Stop hook (DSH runs it from ~/.codex/hooks.json). They see the
 * same finished turn and would send the same text. Identical text inside a short
 * window is therefore treated as the same event.
 *
 * Kept in its own module so the rule can be tested without a network.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_WINDOW_MS = 25000;

/** Project root — `src/` sits directly under it (same assumption as src/transport.js). */
const ROOT = path.join(__dirname, '..');

/**
 * Where the last send is remembered (next to the notify log).
 *
 * ⚠️ A relative `logDir` MUST be anchored to the project root, never to the current
 * working directory. `notify.js` is deliberately callable from anywhere — the watcher,
 * Codex's computer-use wrapper, DSH's Stop hook, and a double-clicked `notify.cmd` —
 * so a CWD-relative path splits "already sent" into one file per working directory.
 * The gate then never sees the previous send and stops firing, which is exactly how a
 * single turn gets announced twice. Measured 2026-10-05: a stray
 * `%TEMP%\last-notice.json` existed alongside the real `logs\last-notice.json`.
 * An absolute `logDir` (tests, or a user config) is respected as-is.
 */
function statePath(logDir) {
  const dir = logDir || path.join(ROOT, 'logs');
  return path.join(path.resolve(path.isAbsolute(dir) ? dir : path.join(ROOT, dir)), 'last-notice.json');
}

/**
 * @returns {boolean} true when this exact notice was already sent inside the window
 */
function isDuplicate({ notice, logDir, now = Date.now(), windowMs = DEFAULT_WINDOW_MS }) {
  const key = `${notice && notice.title}\u0000${notice && notice.body}`;
  const file = statePath(logDir);
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first send, or the state was cleared */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key, at: now }), 'utf8');
  } catch {
    /* best effort: if the state cannot be written, the gate simply never fires */
  }
  return Boolean(prev && prev.key === key && now - Number(prev.at) < windowMs);
}

module.exports = { isDuplicate, DEFAULT_WINDOW_MS, statePath };
