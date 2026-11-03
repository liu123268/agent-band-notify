#!/usr/bin/env node
'use strict';
/**
 * Generic turn watcher — one process for every AI software that keeps a readable log.
 *
 * The reasoning behind this file is in README ("为什么是读日志而不是官方接口") and in
 * src/agents/index.js. In one line: the machinery is identical for every software, only
 * the four adapter answers differ — so the machinery lives here once, and each software
 * contributes a small adapter under src/agents/.
 *
 * What the engine owns (nothing software-specific):
 *   - enumerating candidate log files from the adapter's `dirs` / `filePattern`
 *   - reading ONLY the bytes appended since last poll (a 200 MB file costs nothing)
 *   - advancing the read offset only past the last COMPLETE line, so a poll that lands
 *     mid-write cannot swallow that event forever
 *   - persisting read offsets and dedup keys, so a restart resumes instead of either
 *     replaying history or silently dropping every turn that finished while it was down
 *   - deciding the message, then spawning notify.js (the single entry point)
 *   - logging every decision, so "why did / didn't it ring" is always answerable
 *
 * Usage:
 *   node tools/agent-watch.js                  # watch everything, in the foreground
 *   node tools/agent-watch.js --agent workbuddy
 *   node tools/agent-watch.js --list           # which adapters are registered
 *   node tools/agent-watch.js --status         # one snapshot of every adapter
 *   node tools/agent-watch.js --once           # single scan, then exit
 *   node tools/agent-watch.js --once --dry-run # show what would be sent, send nothing
 *   node tools/agent-watch.js --install        # hidden per-user autostart
 *
 * Env overrides (used by the test suite):
 *   BAND_NOTIFY_AGENT_STATE / _SEEN / _CACHE  → relocate persisted state
 *   BAND_NOTIFY_AGENT_LOG                     → relocate the log
 *   BAND_NOTIFY_AGENT_MODULE                  → load extra adapters (see src/agents/index.js)
 *   BAND_NOTIFY_SCRIPT                        → the notify.js to spawn
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { append: appendLog } = require('../src/logfile.js');
const agents = require('../src/agents/index.js');
const { resolveNodeBin, nodeBinCandidates } = require('../src/nodebin.js');

const ROOT = path.join(__dirname, '..');
const NOTIFY = process.env.BAND_NOTIFY_SCRIPT || path.join(ROOT, 'notify.js');
const LOG_FILE = process.env.BAND_NOTIFY_AGENT_LOG || path.join(ROOT, 'logs', 'agent-watch.log');
const STATE_FILE =
  process.env.BAND_NOTIFY_AGENT_STATE || path.join(ROOT, 'logs', 'agent-watch-state.json');
const SEEN_FILE = process.env.BAND_NOTIFY_AGENT_SEEN || path.join(ROOT, 'logs', 'agent-watch-seen.json');
const CACHE_FILE =
  process.env.BAND_NOTIFY_AGENT_CACHE || path.join(ROOT, 'logs', 'agent-watch-cache.json');
/**
 * Liveness proof. The single most common failure this project has hit is "the watcher
 * process silently disappeared" (an app restart takes its whole process tree down), and
 * the symptom is indistinguishable from "nothing has finished today". A heartbeat file
 * plus a PID liveness check turns that into a one-line answer in `--status`.
 */
const HEARTBEAT_FILE =
  process.env.BAND_NOTIFY_AGENT_HEARTBEAT || path.join(ROOT, 'logs', 'agent-watch.heartbeat.json');

/** Never read more than this much new data in a single poll, per file. */
const TAIL_BYTES = 1024 * 1024;

// The registered plan task writes its authoritative definition here. Used as the
// evidence that "some autostart is already installed" — the same signal the .vbs
// installer reads, so the two can never disagree about which route is active.
const TASK_XML = 'C:\\Windows\\System32\\Tasks\\band-notify-watchers';
/** Dedup table cap. One key per finished turn, forever. */
const SEEN_CAP = 4000;
/** Cache cap (conversation titles etc.), keyed per adapter. */
const CACHE_CAP = 4000;
/** Largest string handed to notify.js on the command line. */
const ARG_MAX = 500;

// ---------------------------------------------------------------- persisted state

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* first run, or unreadable — fall back */
  }
  return fallback;
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 1), 'utf8');
  } catch {
    /* best effort: state is an optimisation, never a correctness requirement */
  }
}

/** file -> byte offset already consumed. */
let state = new Map();
/** "<adapter>#<turn key>" -> first-seen timestamp. */
let seen = new Map();
/** "<adapter>" -> { key: value } — adapter-owned memos (titles, resolved paths…). */
let caches = new Map();

let stateDirty = false;
let seenDirty = false;
const cacheDirty = new Set();

/** (Re)read every persisted store from disk. Called at load, and by tests. */
function reload() {
  state = new Map(
    Object.entries(readJson(STATE_FILE, {}).files || {}).map(([k, v]) => [k, Number(v) || 0]),
  );
  seen = new Map(Object.entries(readJson(SEEN_FILE, {}).turns || {}));
  caches = new Map(Object.entries(readJson(CACHE_FILE, {})));
  stateDirty = false;
  seenDirty = false;
  cacheDirty.clear();
}

function saveState() {
  if (!stateDirty) return;
  const kept = [...state.entries()].slice(-3000); // bounded file, cannot grow forever
  writeJson(STATE_FILE, { files: Object.fromEntries(kept) });
  stateDirty = false;
}

function saveSeen() {
  if (!seenDirty) return;
  const kept = [...seen.entries()].slice(-SEEN_CAP);
  writeJson(SEEN_FILE, { turns: Object.fromEntries(kept) });
  seenDirty = false;
}

function saveCaches() {
  if (!cacheDirty.size) return;
  writeJson(CACHE_FILE, Object.fromEntries(caches));
  cacheDirty.clear();
}

/** Persisted per-adapter memo handed to adapters as `info.cache`. */
function cacheFor(profileId) {
  let store = caches.get(profileId);
  if (!store || typeof store !== 'object') {
    store = {};
    caches.set(profileId, store);
  }
  const entries = new Map(Object.entries(store));
  return {
    get(key) {
      return entries.has(key) ? entries.get(key) : undefined;
    },
    set(key, value) {
      entries.set(key, value);
      let obj = Object.fromEntries(entries);
      const keys = Object.keys(obj);
      if (keys.length > CACHE_CAP) {
        obj = Object.fromEntries(keys.slice(-CACHE_CAP).map((k) => [k, obj[k]]));
      }
      caches.set(profileId, obj);
      cacheDirty.add(profileId);
    },
  };
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendLog(LOG_FILE, line); // append() rotates past its ceiling (src/logfile.js)
  } catch {
    /* best effort */
  }
}

/** True the first time this adapter+turn is seen, ever (survives restarts). */
function claim(profileId, key) {
  if (!key) return true; // nothing to key on; the adapter accepted that risk
  const id = `${profileId}#${key}`;
  if (seen.has(id)) return false;
  seen.set(id, Date.now());
  seenDirty = true;
  return true;
}

reload();

// ---------------------------------------------------------------- file discovery

/** Every file matching an adapter's dirs/pattern. */
function listFiles(profile) {
  const out = [];
  const depth = Number.isFinite(profile.depth) ? profile.depth : 2;
  const walk = (dir, left) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // adapter points at software that is not installed: not an error
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (left > 0) walk(p, left - 1);
      } else if (profile.filePattern.test(entry.name)) {
        try {
          out.push({ file: p, size: fs.statSync(p).size });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  };
  for (const dir of profile.dirs) walk(dir, depth);
  return out;
}

/** Bytes appended since `from`, capped, decoded as UTF-8. */
function readNew(file, from, size) {
  const start = Math.max(0, from, size - TAIL_BYTES);
  const length = size - start;
  if (length <= 0) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
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

// ---------------------------------------------------------------- notification

function clipArg(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > ARG_MAX ? `${flat.slice(0, ARG_MAX - 1)}…` : flat;
}

/** Set by run(); tests flip it to capture instead of sending. */
const runtime = { dryRun: false, sent: [] };
/** Resolved once at startup (it costs a PowerShell call) and reused by the heartbeat. */
let parentNameCache = '';

// The node binary used to run `notify.js` is resolved by `src/nodebin.js` (imported above).
// ⚠️ 绝不在这里直接 spawn `process.execPath`：它是**带版本号的**路径，WorkBuddy 一升级
// 就会把那个目录改名/删掉，而**已经在跑的监听不会死**（Windows 让已加载的镜像继续活着）
// → 心跳新鲜、判定照写，但每次 spawn 都是 ENOENT = **判定成功、从未发出**。
// 2026-10-09 19:51 就是这条：Codex 完成一轮，日志 `已通知(任务完成) …` 紧跟
// `推送失败: spawn … ENOENT`，手环没响。逻辑只有一份，在 src/nodebin.js；本文件只做调用。

/**
 * Hand one event to the single notification entry point.
 *
 * The child is detached and never waited on: notify.js exits 0 by design, so there is
 * nothing to learn from its exit code, and a watcher must not be slowed by the network.
 */
function fire(profile, file, desc) {
  const args = [
    NOTIFY,
    '--agent', profile.label,
    '--from', `${profile.id}-watch`,
    '--kind', desc.kind || 'turn-end',
    '--state', desc.state,
  ];
  const conversation = clipArg(desc.conversation);
  const preview = clipArg(desc.text);
  if (conversation) args.push('--conversation', conversation);
  if (preview) args.push('--preview', preview);
  if (desc.priority) args.push('--priority', String(desc.priority));
  if (Number.isFinite(desc.elapsedMs)) {
    args.push('--elapsed-ms', String(Math.round(desc.elapsedMs)));
    args.push('--duration-ms', String(Math.round(desc.elapsedMs)));
  }

  // Fallback only — every adapter sets `desc.log`. Kept in sync with `STATES` in
  // src/notice.js on purpose: an unknown blocking state must never be logged as
  // "任务完成" (the task finished), which is the exact opposite of what it means.
  const label =
    desc.log ||
    (desc.state === 'ask'
      ? '等待回答'
      : desc.state === 'approval'
        ? '等待批准'
        : desc.state === 'wait'
          ? '已暂停'
          : desc.state === 'error'
            ? '出错'
            : '任务完成');
  if (runtime.dryRun) {
    runtime.sent.push(args);
    log(`[dry-run] 会通知(${label}) conversation="${conversation}" preview="${preview}"`);
    console.log(`[would-send] ${JSON.stringify(args)}`);
    return;
  }

  const opts = { detached: true, stdio: 'ignore', windowsHide: true, env: process.env };
  const bin = resolveNodeBin();
  const child = spawn(bin, args, opts);
  child.on('error', (err) => {
    // 运行时可能在**运行中被**删掉 / repoint（WorkBuddy 升级）。重解析一次再试，
    // 把"此后每一条通知都静默丢失"降级成"至多这一条晚一个轮询周期"。
    log(`推送失败: ${err.message}（用的 node: ${bin}）`);
    const retry = resolveNodeBin();
    if (retry === bin) {
      log('推送失败: 已无可用 node 回退 —— 检查 .workbuddy\\binaries\\node\\versions 下还有没有 node.exe');
      return;
    }
    const again = spawn(retry, args, opts);
    again.on('error', (e2) => log(`推送失败(回退重试后): ${e2.message}（用的 node: ${retry}）`));
    again.unref();
    log(`已改用回退 node 重试: ${retry}`);
  });
  child.unref();

  log(
    `已通知(${label}) agent=${profile.id} file=${path.basename(file)} ` +
      `conversation="${conversation}" 摘要长度=${preview.length}` +
      (desc.priority ? ` priority=${desc.priority}` : ''),
  );
}

// ---------------------------------------------------------------- the scan

function parseLine(profile, line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (typeof profile.parse === 'function') return profile.parse(trimmed);
  try {
    return JSON.parse(trimmed);
  } catch {
    // A malformed line is skipped, never fatal: the software owns the file and may
    // already write shapes this adapter does not know.
    return null;
  }
}

/**
 * Turn one adapter descriptor into at most one notification, through the single dedup +
 * fire path. Both scan shapes call this, so a semantics change cannot accidentally apply
 * to only one of them.
 *
 * Returns true when a notification was actually handed to notify.js.
 *
 * `desc.skip` is the adapter saying "this is a real event but deliberately not news" —
 * a subagent finishing one step of a bigger job, an internal safety-classifier turn, a
 * resume replaying history. It is LOGGED even though nothing is sent: the question this
 * project has to be able to answer at any moment is "why did the hand not buzz then?", and
 * a silent filter turns that into a guessing game. Skipping happens BEFORE `claim()`, so a
 * filtered turn does not burn a dedup key.
 */
function deliver(profile, file, desc, extra) {
  if (!desc) return false;

  if (desc.skip) {
    log(
      `跳过 agent=${profile.id} file=${path.basename(file)} 原因=${desc.skip}` +
        (desc.detail ? ` ${desc.detail}` : ''),
    );
    return false;
  }

  if (!desc.conversation && typeof profile.conversation === 'function') {
    desc.conversation = profile.conversation(Object.assign({ file, cwd: desc.cwd }, extra));
  }
  if (!claim(profile.id, desc.key)) {
    log(`跳过重复轮次 agent=${profile.id} key=${String(desc.key).slice(0, 14)}（历史回放）`);
    return false;
  }
  fire(profile, file, desc);
  return true;
}

function scanProfile(profile) {
  // Two storage shapes exist in the wild, and they cannot share a reader:
  //
  //   append  – the software only ever appends whole lines (Codex / WorkBuddy / ZCode).
  //             "What's new" = the bytes past the last offset, so the engine can own the
  //             offset bookkeeping on the adapter's behalf.
  //   rewrite – the software keeps ONE json object per file and rewrites the whole file
  //             whenever any field changes (DSH). There are no "new bytes" worth tracking,
  //             because the same bytes change meaning on every flush.
  //
  // The branch lives here, not in the adapter, so that every adapter still reaches the
  // network through ONE dedup + fire path. A second send path is exactly how this project
  // would start double-notifying.
  if (profile.mode === 'rewrite') return scanSnapshotProfile(profile);

  const files = listFiles(profile);
  const cache = cacheFor(profile.id);
  let tracked = 0;
  let fired = 0;

  for (const { file, size } of files) {
    const key = `${profile.id}|${file}`;
    const offset = state.get(key);
    if (offset === undefined) {
      // First sight: baseline at the current end. History is not news.
      state.set(key, size);
      stateDirty = true;
      continue;
    }
    if (size <= offset) {
      if (size < offset) {
        // A file that got SHORTER was truncated or emptied rather than rotated to a new
        // name — audit-log's spool is emptied the moment it is archived, and it keeps the
        // same path. Rewind to 0, NOT to `size`.
        //
        // Rewinding to `size` reads the truncated file as "already fully consumed", so
        // anything appended in the SAME poll as the truncation (empty → rewrite) is
        // skipped forever, with no log line. Re-reading from 0 is safe because `claim()`
        // dedups by turn identity, and every adapter that never truncates (all the
        // append-only transcripts) never reaches this branch at all.
        state.set(key, 0);
        stateDirty = true;
      }
      tracked += 1;
      continue;
    }

    const text = readNew(file, offset, size);
    tracked += 1;
    if (!text) {
      state.set(key, size);
      stateDirty = true;
      continue;
    }

    // Advance only past the last COMPLETE line. Consuming a half-written line would
    // move the offset past an event that was never parsed, losing it permanently.
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) continue;
    const complete = text.slice(0, lastNewline);
    const consumed = Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
    state.set(key, Math.max(0, size - Buffer.byteLength(text, 'utf8') + consumed));
    stateDirty = true;

    for (const line of complete.split('\n')) {
      const event = parseLine(profile, line);
      if (!event) continue;
      let desc;
      try {
        desc = profile.turnEnd(event, { file, event, cache });
      } catch (err) {
        log(`适配器 ${profile.id} 判定异常: ${err.message}`);
        continue;
      }
      if (!desc) continue;
      if (deliver(profile, file, desc, { event })) fired += 1;
    }
  }
  return { tracked, fired, files: files.length };
}

/**
 * Scan a profile whose files are rewritten in place rather than appended to.
 *
 * The engine deliberately does not try to be clever: it cannot know which field of an
 * arbitrary JSON object means "a turn finished". So the adapter's `snapshot()` receives the
 * parsed file plus `info.cache` (a persisted per-adapter memo) and returns the same
 * descriptor shape `turnEnd()` returns.
 *
 * Two things the adapter therefore has to own, because only it can:
 *
 *   - "first sight of a file is not news". There is no offset to baseline, so an adapter
 *     that would otherwise announce the newest turn of a file it has never seen must stay
 *     silent on first sight and remember that file in `info.cache`.
 *   - one turn can be observed closing several times (DSH rewrites its cache in bursts).
 *     `claim()` is what makes that harmless — same as in append mode, so the guarantee
 *     "one finished turn = at most one notification" holds for both shapes.
 */
function scanSnapshotProfile(profile) {
  const files = listFiles(profile);
  const cache = cacheFor(profile.id);
  let tracked = 0;
  let fired = 0;

  for (const { file, size } of files) {
    // `selfRead` adapters open the file themselves and receive `null` instead of a parsed
    // object (SQLite databases are the reason: `JSON.parse` fails on every poll, so without
    // this the adapter would never be called at all — it would look "connected" in the
    // registry while staying permanently silent). The engine still owns file discovery,
    // per-file caching, dedup and the ONE send path, so `selfRead` changes nothing about
    // how a notice is delivered.
    let json = null;
    if (!profile.selfRead) {
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      } catch {
        // Mid-write, or not JSON at all. Neither is an error: the software owns this file and
        // the next poll re-reads it. Skipping keeps one half-written file from silencing the
        // other adapters.
        continue;
      }
    }
    tracked += 1;

    let descs;
    try {
      descs = profile.snapshot(json, { file, size, cache });
    } catch (err) {
      log(`适配器 ${profile.id} 判定异常: ${err.message}`);
      continue;
    }
    if (!descs) continue;

    for (const desc of Array.isArray(descs) ? descs : [descs]) {
      if (!desc) continue;
      if (deliver(profile, file, desc, { json })) fired += 1;
    }
  }
  return { tracked, fired, files: files.length };
}

// ---------------------------------------------------------------- commands

/**
 * Usage text. Exists so `--help` is **not** silently treated as "no flags given" —
 * an unknown flag used to fall straight through into the foreground watcher loop, which
 * means anyone poking at the CLI (`--help`, a typo) would start a SECOND persistent
 * watcher. Two watchers = every notification sent twice, which this project treats as a
 * top-tier failure. 2026-10-09: hit exactly that while reviewing.
 */
function printUsage() {
  console.log(
    [
      '用法：node tools/agent-watch.js [选项]',
      '',
      '  （不带选项）        前台常驻监听（正常启动方式：双击「一键启动.vbs」）',
      '  --agent <id>        只监听某个适配器（workbuddy / zcode / codex / dsh / mimo …）',
      '  --list              列出已注册的适配器',
      '  --status            打印每个适配器的快照（--quiet 只走退出码）',
      '  --once              只扫一轮就退出',
      '  --once --dry-run    只显示"会发什么"，不真发',
      '  --install           注册隐藏的登录自启（已有计划任务时会拒绝）',
      '  --help, -h          显示这段说明',
      '',
      '⚠️ 不加 --once 就是常驻。要停掉常驻进程请用「一键启动.vbs」（它会先停后起）。',
    ].join('\n'),
  );
}

function pickProfiles(selected) {
  const all = agents.list();
  if (!selected) return all;
  const wanted = all.filter((p) => p.id === selected);
  if (!wanted.length) {
    console.error(`[agent-watch] 没有这个适配器: ${selected}`);
    console.error(`[agent-watch] 已注册: ${all.map((p) => p.id).join(', ')}`);
  }
  return wanted;
}

function printList() {
  console.log(`已注册 ${agents.list().length} 个适配器（加一个新软件 = 在 src/agents/ 加一个文件）:\n`);
  for (const p of agents.list()) {
    const files = listFiles(p).length;
    console.log(`  ${p.id.padEnd(12)} ${p.label.padEnd(12)} 日志文件 ${String(files).padStart(4)} 个`);
    for (const d of p.dirs) console.log(`      └─ ${d}`);
    for (const problem of agents.validate(p)) console.log(`      ⚠ ${problem}`);
  }
}

/**
 * Human line for --status: is a watcher alive, and how long since it last checked?
 *
 * With `quiet` it prints NOTHING and just answers "is a watcher alive?" as a boolean.
 * start-agent-watch.cmd uses that to stay idempotent: two watchers would send every
 * notification TWICE, and the launcher is reachable both by double-click and by the
 * logon autostart, so "start me again" is a normal thing to happen.
 */
function printStatus(selected, opts = {}) {
  if (opts.quiet) {
    const entries = readBeats().sort((a, b) => b.at - a.at);
    return entries.some((e) => pidAlive(e.pid) && Date.now() - e.at < 2 * 3600 * 1000);
  }
  console.log(`监听进程: ${heartbeatLine()}`);
  for (const p of pickProfiles(selected)) {
    const files = listFiles(p);
    const tracked = files.filter(({ file }) => state.has(`${p.id}|${file}`)).length;
    console.log(`\n=== ${p.id} (${p.label}) ===`);
    console.log(`日志目录: ${p.dirs.join('  |  ')}`);
    console.log(
      p.mode === 'rewrite'
        ? `匹配文件: ${files.length} 个（整文件快照，无需读取位置）`
        : `匹配文件: ${files.length} 个（已跟踪 ${tracked} 个读取位置）`,
    );
    for (const problem of agents.validate(p)) console.log(`⚠ 适配器问题: ${problem}`);
    for (const { file, size } of files.sort((a, b) => b.size - a.size).slice(0, 3)) {
      console.log(`  ${path.basename(file).slice(0, 46)}…  ${(size / 1024).toFixed(0)} KB`);
    }
    // Optional per-adapter diagnostic. Worth the extra seam: the question this project
    // keeps needing to answer is "would it have notified?", and for a watcher that filters
    // most of what it reads (Codex silences ~75% of rollouts) that must be inspectable
    // WITHOUT waiting for a notification to fail.
    if (typeof p.diagnose === 'function') {
      try {
        for (const line of p.diagnose({ listFiles, cache: cacheFor(p.id) }) || []) console.log(line);
      } catch (err) {
        console.log(`  ⚠ 诊断失败: ${err.message}`);
      }
    }
    for (const d of p.dirs.filter((d) => !fs.existsSync(d))) {
      console.log(`  （目录不存在，软件可能没装/没用过: ${d}）`);
    }
  }
  let tail = [];
  try {
    tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-6);
  } catch {
    /* no log yet */
  }
  if (tail.length) {
    console.log('\n最近判定:');
    for (const line of tail) console.log(`  ${line}`);
  }
  // A diagnostic may warm the per-adapter cache (reading 373 rollout headers to report
  // which sources will notify is the same work the first real scan would otherwise redo).
  // Persisting it here is the one side effect `--status` has, and it only ever saves work.
  saveCaches();
}

/**
 * Who launched this process decides how long it lives. A watcher started from inside
 * another app's process tree dies when that app restarts; one started by wscript.exe
 * from the Startup folder does not. Recording the parent makes that visible.
 */
function parentName() {
  if (process.platform !== 'win32') return '';
  try {
    const { execFileSync } = require('child_process');
    const ps =
      `$p=(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").ParentProcessId;` +
      `(Get-CimInstance Win32_Process -Filter "ProcessId=$p").Name`;
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** Normalised heartbeat entries, tolerating the single-record shape of earlier versions. */
function readBeats() {
  try {
    const raw = readJson(HEARTBEAT_FILE, null);
    if (!raw) return [];
    const source = raw.beats && typeof raw.beats === 'object' ? raw.beats : null;
    const list = source
      ? Object.entries(source).map(([pid, at]) => ({ pid: Number(pid), at: Number(at) }))
      : [{ pid: Number(raw.pid), at: Number(raw.at) }]; // legacy single record
    return list.filter((e) => Number.isFinite(e.pid) && Number.isFinite(e.at));
  } catch {
    return [];
  }
}

/**
 * Record this process as alive.
 *
 * The file holds a MAP of pid -> last beat rather than a single record, because more
 * than one watcher can legitimately exist (a long-running one plus a `--once`/`--dry-run`
 * run), and because a short-lived run must never be able to make `--status` report the
 * long-running watcher as dead. Entries whose process is gone are pruned here, so the
 * file stays small and the answer stays honest.
 */
function beat() {
  const alive = {};
  for (const { pid, at } of readBeats()) {
    if (pid === process.pid) continue;
    // Keep only processes that still exist and beat within the last 2 hours.
    if (pidAlive(pid) && Date.now() - at < 2 * 3600 * 1000) alive[pid] = at;
  }
  alive[process.pid] = Date.now();
  writeJson(HEARTBEAT_FILE, { beats: alive });
}

/** "is that PID still running?" without spawning anything. */
function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM'); // exists, owned by someone else
  }
}

/** Human line for --status: is a watcher alive, and how long since it last checked? */
function heartbeatLine() {
  const entries = readBeats().sort((a, b) => b.at - a.at);
  if (!entries.length) return '未启动（没有任何心跳记录）→ 双击 一键启动.vbs';

  const live = entries.find((e) => pidAlive(e.pid));
  if (live) {
    const ageSec = Math.round((Date.now() - live.at) / 1000);
    return ageSec > 120
      ? `心跳异常（进程 ${live.pid} 还在，但已 ${ageSec} 秒没动）`
      : `运行中（进程 ${live.pid}，${ageSec} 秒前的心跳）`;
  }
  const last = entries[0];
  const ageSec = Math.round((Date.now() - last.at) / 1000);
  return `已停止（进程 ${last.pid} 不在了；最后心跳 ${ageSec} 秒前）→ 双击 一键启动.vbs 拉起来`;
}

function installAutostart() {
  // 只允许一套自启机制。当前这台机器装的是「任务计划程序 → band-notify-watchers」，
  // 它每分钟调用 tools\watchdog.vbs 去"读进程表 → 拉起缺失的监听"。
  // 如果这里再往启动文件夹塞一份，两套会在同一秒各判一次"没在跑"、各拉起一个监听进程
  // → 每条通知发两遍。这是本项目明文禁止的组合，所以宁可拒绝安装。
  if (fs.existsSync(TASK_XML)) {
    console.error('[install] 拒绝安装：检测到计划任务 band-notify-watchers（当前的自启方案）。');
    console.error('[install]   再装启动文件夹会变成两套自启，同一秒各拉起一个监听 → 每条通知发两遍。');
    console.error('[install]   要改用启动文件夹方案，请先删除该计划任务；否则本来就已经装好了，无需再装。');
    return;
  }
  const startup = path.join(
    os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  );
  const vbs = path.join(startup, 'band-notify-agent-watch.vbs');
  const launcher = path.join(__dirname, '..', 'start-agent-watch.cmd');
  // The autostart entry runs start-agent-watch.cmd rather than naming a Node binary.
  // Two reasons, both learned the hard way:
  //   1. `process.execPath` is a VERSIONED path (…\node\versions\22.22.2-3\node.exe).
  //      A WorkBuddy update repoints it and the entry then fails silently at every
  //      logon — with no window and no log, so it looks exactly like "no AI activity".
  //   2. One code path instead of two: the file you double-click and the file logon
  //      runs are then the same file, so a manual double-click also tests the autostart.
  // NOTE: this Startup route is the FALLBACK. The registered plan task is preferred
  // (it survives logoff, and its liveness is visible in taskschd.msc instead of being
  // an invisible startup folder entry).
  const cmd = `"${launcher}"`;
  try {
    fs.mkdirSync(startup, { recursive: true });
    fs.writeFileSync(
      vbs,
      `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "cmd /c ${cmd.replace(/"/g, '""')}", 0, False\r\n`,
      'utf8',
    );
    console.log(`[install] 已写入开机自启: ${vbs}`);
    console.log(`[install] 它调的是 ${launcher}（自己解析 node，路径失效也能回退）`);
  } catch (err) {
    console.error(`[install] 写自启文件失败: ${err.message}`);
    return;
  }
  try {
    const child = spawn('cmd.exe', ['/c', launcher], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    console.log('[install] 已尝试在后台启动一次');
  } catch (err) {
    console.log(`[install] 自启文件已写好，但本次启动失败（${err.message}）`);
    console.log('[install] 立刻手动跑一次，或双击 一键启动.vbs');
  }
}

/**
 * Run one configuration of the watcher. Exported so the test suite can drive it
 * in-process (this environment cannot spawn a second Node as a child).
 *
 * @param {string[]} argvList e.g. ['--agent','workbuddy','--once','--dry-run']
 */
function run(argvList) {
  const flags = new Set(argvList);
  const flagValue = (name) => {
    const i = argvList.indexOf(name);
    return i === -1 ? null : argvList[i + 1];
  };
  runtime.dryRun = flags.has('--dry-run');
  runtime.sent = [];
  const once = flags.has('--once');
  const selected = flagValue('--agent');

  if (flags.has('--help') || flags.has('-h')) return printUsage();
  if (flags.has('--list')) return printList();
  if (flags.has('--status')) return printStatus(selected, { quiet: flags.has('--quiet') });
  if (flags.has('--install')) return installAutostart();

  const profiles = pickProfiles(selected);
  if (!profiles.length) return undefined;

  const worst = Math.min(...profiles.map((p) => p.pollMs || 2000));
  parentNameCache = parentName();
  log(
    `通用监听启动 (poll=${worst}ms) 适配器=${profiles.map((p) => p.id).join(', ')}` +
      `${runtime.dryRun ? ' [dry-run]' : ''}`,
  );
  log(`进程 PID=${process.pid} 父进程=${parentNameCache || '(未知)'}`);
  log(`已恢复读取位置: ${state.size} 个文件；已记住 ${seen.size} 个轮次`);
  beat();

  let total = 0;
  for (const p of profiles) {
    const r = scanProfile(p);
    total += r.tracked;
    log(`  ${p.id}: ${r.files} 个文件，跟踪 ${r.tracked} 个（停机期间的完成轮次会被补发）`);
  }
  saveState();
  saveSeen();
  saveCaches();
  log(`已建立基线，共跟踪 ${total} 个文件，此后新完成的轮次都会触发提醒`);
  beat();

  if (once) return undefined;

  let busy = false;
  let lastBeat = 0;
  let lastBeatLog = Date.now();
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      for (const p of profiles) scanProfile(p);
      saveState();
      saveSeen();
      saveCaches();
      // Heartbeat file every 30 s (cheap); one human-readable log line every 10 min, so
      // "is it alive" is answerable both from a file and from the log, and the log's
      // growth stays bounded.
      if (now - lastBeat > 30000) {
        lastBeat = now;
        beat();
      }
      if (now - lastBeatLog > 600000) {
        lastBeatLog = now;
        log(`心跳：仍在监听（跟踪 ${state.size} 个文件，已记住 ${seen.size} 个轮次）`);
      }
    } catch (err) {
      log(`扫描异常: ${err.message}`);
    } finally {
      busy = false;
    }
  }, worst);
  timer.unref?.();
  setInterval(() => {}, 1 << 30); // keep the process alive
  return undefined;
}

module.exports = {
  run,
  scanProfile,
  scanSnapshotProfile,
  listFiles,
  claim,
  saveState,
  saveSeen,
  saveCaches,
  reload,
  runtime,
  beat,
  heartbeatLine,
  pidAlive,
  resolveNodeBin,
  nodeBinCandidates,
  /** read-only view for tests/diagnostics */
  peek: () => ({ state: new Map(state), seen: new Map(seen), caches: new Map(caches) }),
};

if (require.main === module) {
  const result = run(process.argv.slice(2));
  // `--status --quiet` is the only path that returns a boolean. It doubles as an exit
  // code so start-agent-watch.cmd can ask "is one already running?" WITHOUT having to
  // parse Chinese console text in a .cmd (which is OEM-code-page fragile).
  if (result === true) process.exit(0);
  if (result === false) process.exit(1);
}
