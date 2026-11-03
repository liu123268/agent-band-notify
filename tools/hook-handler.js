#!/usr/bin/env node
'use strict';
/**
 * Stop-hook handler for BOTH consumers of ~/.codex/hooks.json.
 *
 * Two products read that file and may run this:
 *   * DSH   — via @deepseek-ai/dsh-hooks-codex (parent is the Electron harness)
 *   * Codex — the Codex desktop app itself (parent is ChatGPT.exe)
 *
 * They must not report the same software name, so the caller is detected from the
 * parent process chain, and the notification is labelled accordingly.
 *
 * Extra args passed after this script are forwarded verbatim to notify.js.
 * Exit code is always 0: a non-zero "block" result would force another model turn.
 */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NOTIFY = path.join(ROOT, 'notify.js');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG = path.join(LOG_DIR, 'hook-invocations.log');

function logLine(msg) {
  try {
    // The directory must be created here: this runs before anything else, and a
    // throw on the first log line would take the whole handler down (which shows
    // up as "hook exited with code 1").
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch {
    /* logging is best-effort */
  }
}

/** Walk up the Windows process tree and return the ancestor executable names. */
function ancestorNames(maxDepth = 6) {
  if (process.platform !== 'win32') return [];
  // One snapshot of the whole process table beats one PowerShell spawn per level
  // (the naive version cost ~4s per hook invocation).
  const ps =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name | ' +
    'ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const byId = new Map();
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, name] = line.trim().split('|');
      if (pid) byId.set(Number(pid), { ppid: Number(ppid), name: name || '' });
    }
    const names = [];
    let current = process.pid;
    for (let i = 0; i < maxDepth; i += 1) {
      const entry = byId.get(current);
      if (!entry || !entry.ppid) break;
      const parent = byId.get(entry.ppid);
      if (!parent) break;
      names.push(parent.name);
      current = entry.ppid;
    }
    return names;
  } catch (err) {
    logLine(`process-tree lookup failed: ${err.message}`);
    return [];
  }
}

function detectAgent() {
  if (process.env.BAND_NOTIFY_AGENT) {
    return { label: process.env.BAND_NOTIFY_AGENT, evidence: 'env:BAND_NOTIFY_AGENT' };
  }
  // Walking the process table costs ~1.5s (one CIM query), which is most of a
  // hook's budget. DSH is therefore identified from its OWN environment first and
  // the expensive walk only runs when nothing else identifies the caller.
  const envKeys = Object.keys(process.env).filter((k) => /^DSH_|^DEEPSEEK/i.test(k));
  if (envKeys.length) {
    return { label: 'DSH', evidence: `env:${envKeys.slice(0, 3).join(',')}` };
  }
  const names = ancestorNames();
  const joined = names.join(' ');
  // Codex desktop app runs as ChatGPT.exe; the CLI runs as codex.exe
  if (/ChatGPT\.exe|codex\.exe/i.test(joined)) {
    return { label: 'Codex', evidence: `tree:${joined}` };
  }
  // DSH runs inside the Electron harness
  if (/DeepSeek Harness\.exe|electron\.exe/i.test(joined)) {
    return { label: 'DSH', evidence: `tree:${joined}` };
  }
  return { label: 'DSH', evidence: `fallback:${joined || 'empty'}` };
}

/** Read the hook payload from stdin (the hook protocol passes it there). */
function readStdin(timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100000) done();
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, timeoutMs).unref?.();
  });
}

/**
 * The Stop hook payload carries only the session id, so the conversation name and
 * the assistant's reply are read from Codex's rollout file for that session.
 *
 * ONLY for a Codex caller. A DSH turn has a DSH session id, which does not exist in
 * Codex's index; the lookup then falls back to "the most recent Codex thread" and
 * prints a CODEX title and CODEX reply text on a DSH notification. That is exactly
 * the mix-up this guard prevents.
 */
function codexContext(payloadText, label) {
  if (label !== 'Codex') return {};
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return {};
  }
  const sessionId = payload.session_id || payload.sessionId || '';
  if (!sessionId) return {};
  const out = {};
  try {
    const { threadName } = require('../src/codex-threads.js');
    const name = threadName(sessionId);
    if (name) out.conversation = name;
  } catch {
    /* optional */
  }
  try {
    const { lastAssistantMessage } = require('../src/codex-rollout.js');
    const last = lastAssistantMessage(sessionId);
    if (last) out.preview = last;
  } catch {
    /* optional */
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  const { label, evidence } = detectAgent();
  const extra = process.argv.slice(2);

  // The hook payload arrives on stdin; forward it to the notifier as the trailing
  // JSON argument so the message can name the conversation and summarise the turn.
  const payload = (await readStdin()).trim();
  const stdinMs = Date.now() - startedAt;
  const context = codexContext(payload, label);
  // The timings are in the log on purpose: a hook has a small time budget, and the
  // only way to know which stage blew it is to measure it in the real run.
  logLine(
    `agent=${label} evidence=${evidence} args=${extra.join(' ')} stdin=${payload.slice(0, 200)}` +
      ` resolveMs=${Date.now() - startedAt - stdinMs} stdinMs=${stdinMs} session=${process.env.DSH_SESSION_ID || '-'}` +
      ` resolved=${JSON.stringify({ conversation: context.conversation || '', preview: (context.preview || '').slice(0, 40) })}`,
  );

  const argv = [
    NOTIFY,
    '--from', 'hook',
    '--agent', label,
    '--kind', 'stop-hook',
    '--state', 'done',
    ...extra,
  ];
  // DSH exports the session it is running; forwarding it lets the notifier drop
  // the hook fired by the agent's OWN conversation (the watcher already covers the
  // user's other conversations).
  if (process.env.DSH_SESSION_ID) argv.push('--session-id', process.env.DSH_SESSION_ID);
  if (context.conversation) argv.push('--conversation', context.conversation);
  if (context.preview) argv.push('--preview', context.preview);
  if (payload.startsWith('{') || payload.startsWith('[')) argv.push(payload);

  const res = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    timeout: 25000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.stdout) logLine(`notify stdout: ${res.stdout.trim().slice(0, 300)}`);
  if (res.stderr) logLine(`notify stderr: ${res.stderr.trim().slice(0, 300)}`);
  logLine(
    `notify exit=${res.status}${res.error ? ` error=${res.error.message}` : ''} totalMs=${Date.now() - startedAt}`,
  );
}

main()
  .catch((err) => logLine(`unexpected error: ${err && err.message}`))
  .finally(() => {
    // Never let a hook failure become a "block" decision.
    process.exitCode = 0;
  });
