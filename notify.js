#!/usr/bin/env node
'use strict';
/**
 * band-notify — one notification entry point for every AI agent on this machine.
 *
 * Usage:
 *   node notify.js --test
 *   node notify.js --title "..." --body "..." [--priority 5] [--tags a,b] [--agent codex] [--force]
 *   echo '{"type":"agent-turn-complete","last-assistant-message":"..."}' | node notify.js --from codex
 *   node notify.js --from codex '{"type":"agent-turn-complete"}'      # Codex passes JSON as argv[last]
 *
 * CLI flags always win over payload values. Exit code is always 0 (fail-safe).
 */
const path = require('path');
const { loadConfig, isPlaceholderTopic } = require('./src/config');
const { buildNotice, parseLoose, firstString, looksLikeForwardedCommand } = require('./src/notice');
const { publish, buildPayload, logLine, runChain } = require('./src/transport');

function parseArgs(argv) {
  const opts = { tags: null, passthrough: [] };
  const takesValue = new Set([
    '--title', '--body', '--message', '--priority', '--tags', '--agent',
    '--from', '--source', '--config', '--elapsed-ms', '--duration-ms', '--duration',
    '--kind', '--state', '--conversation', '--preview', '--url', '--session-id',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      opts[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) {
      opts[arg.slice(2)] = true;
    } else {
      opts.passthrough.push(arg);
    }
  }
  return opts;
}

function readStdin(timeoutMs = 900) {
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
      if (data.length > 200000) done();
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, timeoutMs).unref?.();
  });
}

/**
 * Two independent paths can report the same event: the turn watcher (which reads
 * Codex's rollout) and the Stop hook (which DSH runs from ~/.codex/hooks.json).
 * The rule lives in src/dedupe.js so it can be unit-tested; see that file.
 */
const { isDuplicate, DEFAULT_WINDOW_MS: DUPLICATE_WINDOW_MS } = require('./src/dedupe.js');

function recordInvocation(opts) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'invocations.log');
    // Keep the file small: this runs on every notification.
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      /* first run */
    }
    if (lines.length > 300) lines = lines.slice(-200);
    lines.push(
      `[${new Date().toISOString()}] cwd=${process.cwd()}`,
      `  argv=${JSON.stringify(process.argv.slice(2))}`,
      `  test=${Boolean(opts.test)} trace=${Boolean(opts.trace)}`,
    );
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* best effort */
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(opts.config);

  if (opts.url) cfg.ntfyServer = opts.url;
  if (!opts.test && process.env.BAND_NOTIFY_URL) cfg.ntfyServer = process.env.BAND_NOTIFY_URL;

  // DIAGNOSTIC: always record how we were invoked. Codex's computer-use wrapper
  // mangles our arguments, and it reaches us through a path that can bypass
  // notify.cmd, so an opt-in flag is not reliable here.
  recordInvocation(opts);

  // Assemble the raw payload: stdin JSON, then any non-flag argument (Codex style).
  let raw = {};
  const stdinText = await readStdin();
  const argText = opts.passthrough.join(' ');
  if (stdinText.trim()) raw = parseLoose(stdinText);
  if (argText.trim()) {
    const fromArg = parseLoose(argText);
    raw = Object.keys(raw).length ? Object.assign({}, fromArg, raw) : fromArg;
  }

  // When invoked through Codex's computer-use wrapper our flags are stripped, so
  // recover what we can: the caller is Codex by definition of that wrapper.
  const forwarded = looksLikeForwardedCommand(process.argv.slice(2));  const agent = firstString(opts.agent, opts.source, raw.source, forwarded ? 'Codex' : '', 'AI');
  const notice = buildNotice(
    raw,
    {
      agent,
      source: opts.from || (forwarded ? 'codex-notify' : 'cli'),
      kind: opts.kind,
      state: opts.state || (forwarded ? 'done' : undefined),
      conversation: opts.conversation,
      preview: opts.preview,
      elapsedMs: opts['elapsed-ms'] ? Number(opts['elapsed-ms']) : undefined,
      durationMs: opts['duration-ms'] ? Number(opts['duration-ms']) : undefined,
      duration: opts.duration,
      title: opts.title,
      body: opts.body || opts.message,
      priority: opts.priority ? Number(opts.priority) : undefined,
      tags: opts.tags ? String(opts.tags).split(',').map((t) => t.trim()).filter(Boolean) : null,
    },
    cfg,
  );

  if (opts.test) {
    notice.title = opts.title || '🔔 手环提醒测试';
    notice.body = notice.body || '能收到就说明链路通了';
    cfg.title = notice.title;
    cfg.body = notice.body;
  }

  // The "task too short" gate must be evaluated for every mode, including
  // --dry-run, otherwise dry-run reports sends that would never happen.
  const belowThreshold = () => {
    const elapsed = Number(opts['elapsed-ms']);
    return cfg.minSeconds > 0 && Number.isFinite(elapsed) && elapsed / 1000 < cfg.minSeconds;
  };

  if (opts['dry-run']) {
    if (belowThreshold()) {
      logLine(cfg, `skipped: elapsed ${opts['elapsed-ms']}ms < minSeconds ${cfg.minSeconds}`);
      process.stderr.write(`[band-notify] skipped: elapsed ${opts['elapsed-ms']}ms < minSeconds ${cfg.minSeconds}\n`);
      return;
    }
    // Show both the rendered text and the exact JSON that would be POSTed, so the
    // whole contract can be asserted without touching the network.
    const preview = buildPayload(cfg, notice);
    process.stdout.write(`${JSON.stringify({ config: cfg.__source, minSeconds: cfg.minSeconds, notice, payload: preview }, null, 2)}\n`);
    return;
  }

  // Suppressed on purpose: used to silence a notification source that is known to
  // be unreliable (Codex's computer-use wrapper fires early and mangles arguments).
  // The wrapper is auto-detected because Codex rewrites the notify config itself,
  // so a static env var or config edit would not survive.
  if ((cfg.skip || forwarded) && !opts.force && !opts.test) {
    logLine(
      cfg,
      `skipped: unusable source (${forwarded ? 'computer-use wrapper' : 'skip=1'}) title="${notice.title}"`,
    );
    return;
  }

  if (!cfg.enabled && !opts.force) {
    logLine(cfg, 'skipped: disabled in config');
    return;
  }
  // DSH's Stop hook runs inside whatever DSH session is stopping — including the one
  // where the agent is talking TO the user. That fires a "finished" message for the
  // very turn the user is reading, which is pure noise; the watcher covers the
  // user's other conversations. Dropping it also keeps this self-referential.
  const hookSession = opts['session-id'];
  if (hookSession && process.env.DSH_SESSION_ID && hookSession === process.env.DSH_SESSION_ID) {
    logLine(cfg, `skipped: own session (${hookSession})`);
    return;
  }
  if (isPlaceholderTopic(cfg.topic)) {
    logLine(cfg, 'skipped: topic not configured (run: node notify.js --setup)');
    if (!opts.quiet) {
      process.stderr.write('[band-notify] topic 未配置，已跳过。先运行: node notify.js --setup\n');
    }
    return;
  }
  if (belowThreshold()) {
    logLine(cfg, `skipped: elapsed ${opts['elapsed-ms']}ms < minSeconds ${cfg.minSeconds}`);
    return;
  }

  // Last gate before the network: the same event reported twice (hook + watcher).
  if (!opts.force && !opts.test && isDuplicate({ notice, logDir: cfg.logDir || path.join(__dirname, 'logs') })) {
    logLine(cfg, `skipped: duplicate within ${DUPLICATE_WINDOW_MS / 1000}s title="${notice.title}"`);
    return;
  }

  const result = await publish(cfg, notice);
  if (opts.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok && !opts.quiet) {
    process.stderr.write(`[band-notify] 发送失败: ${result.error}\n`);
  }
  // Follow-up commands (e.g. Codex's computer-use listener) only make sense for
  // the agent that owns them, so they are gated on --from.
  if (opts.from === 'codex' || opts.force) runChain(cfg, notice);
}

main()
  .catch((err) => {
    // Never surface a non-zero exit: agents may treat it as a hook failure.
    process.stderr.write(`[band-notify] unexpected error: ${err && err.message}\n`);
  })
  .finally(() => {
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 50).unref?.();
  });
