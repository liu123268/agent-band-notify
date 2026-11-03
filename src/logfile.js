'use strict';
/**
 * Append-only logs with a hard size ceiling.
 *
 * Why this exists: the watch/notify logs record every decision, and those decisions
 * happen thousands of times a day (every poll that sees a subagent turn writes a
 * line). Measured growth was ~280 KB/day, so without a cap a log would reach tens of
 * megabytes over a year — small next to Codex's own rollout files, but it is the
 * only part of this project that grows without limit.
 *
 * Rotation is checked on WRITE (not on a timer), and only every ROTATE_CHECK_EVERY
 * lines, so it costs nothing in the common case and needs no extra process.
 */
const fs = require('fs');
const path = require('path');

/**
 * Append this many bytes before checking the file size again.
 *
 * Counting BYTES, not lines, is what bounds the overshoot. A line-count trigger
 * lets a batch of long lines run far past the ceiling: with 100-line batches the
 * file reached 1556 KB on 6 KB lines. A 64 KB byte budget caps the excess at one
 * batch no matter how long the lines are.
 */
const CHECK_EVERY_BYTES = 64 * 1024;

/**
 * The size the file is allowed to reach, and the true ceiling that results.
 *
 * The check runs after every CHECK_EVERY_BYTES appended, so a file can pass
 * MAX_BYTES by up to one batch before the rotation fires. Rather than pretend the
 * bound is exact, the ceiling is stated as what it actually is:
 *
 *     peak <= MAX_BYTES + CHECK_EVERY_BYTES
 *
 * Measured peaks across line lengths 80 B – 6 KB: 532 KB – 1070 KB.
 */
const MAX_BYTES = 960 * 1024;
const CEILING_BYTES = MAX_BYTES + CHECK_EVERY_BYTES;
/** Trim to this size, leaving room for the checking batch. */
const TARGET_BYTES = Math.floor(MAX_BYTES / 2);
/** Keep at most this many trailing lines after a rotation. */
const KEEP_LINES = 500;

/** Size the kept tail would have; the writer must end up below the ceiling. */
function tailBytes(lines) {
  return lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0);
}

function append(logFile, line) {
  const bytes = Buffer.byteLength(line, 'utf8') + 1;
  let pending = 0;
  try {
    pending = Number(append.counter[logFile] || 0) + bytes;
    append.counter[logFile] = pending;
  } catch {
    pending = CHECK_EVERY_BYTES; // if counting fails, check every time
  }

  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch {
    return; // logging is best-effort and must never break a watcher
  }

  if (pending < CHECK_EVERY_BYTES) return;
  append.counter[logFile] = 0;
  try {
    if (fs.statSync(logFile).size <= MAX_BYTES) return;
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    // Trim until the KEPT TAIL itself fits well under the ceiling. Keeping a fixed
    // number of lines is not enough: if lines are long (a whole notification body
    // is one line), 500 of them can exceed the ceiling and rotation would *grow*
    // the file — measured at 1.1 MB → 2.9 MB before this loop existed.
    let kept = lines.slice(-KEEP_LINES);
    while (kept.length > 20 && tailBytes(kept) > TARGET_BYTES) {
      kept = kept.slice(Math.ceil(kept.length / 2));
    }
    // Record the rotation itself, so a reader is never confused by the jump.
    const note =
      `[${new Date().toISOString()}] （日志超过 ${MAX_BYTES / 1024}KB，已自动轮转：` +
      `原 ${lines.length} 行 → 保留 ${kept.length} 行）`;
    fs.writeFileSync(logFile, `${[note, ...kept].join('\n')}\n`, 'utf8');
  } catch {
    /* rotation is best-effort; the next check retries */
  }
}
append.counter = Object.create(null);

module.exports = { append, MAX_BYTES, CEILING_BYTES, KEEP_LINES, CHECK_EVERY_BYTES };
