'use strict';
/**
 * Transport layer: publish one notification.
 * All failures are swallowed and logged — a notification must never break the agent.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const TIMEOUT_MS = 8000;
const RETRIES = 2;

function logLine(cfg, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (cfg.debug) process.stderr.write(`[band-notify] ${message}\n`);
  try {
    const root = path.join(__dirname, '..');
    const logsDir = path.join(root, 'logs');
    const file = path.isAbsolute(cfg.logFile)
      ? cfg.logFile
      : path.join(cfg.logDir ? path.join(root, cfg.logDir) : logsDir, cfg.logFile || 'notify.log');
    // Rotates on size, so notify.log cannot grow forever (see src/logfile.js).
    require('./logfile.js').append(file, line);
  } catch {
    /* logging is best-effort */
  }
}

function buildPayload(cfg, { title, body, priority, tags }) {
  return {
    topic: cfg.topic,
    title: title,
    message: body || '',
    priority: Number.isFinite(priority) ? priority : Number(cfg.priority) || 4,
    tags: Array.isArray(tags) && tags.length ? tags : cfg.tags,
    ...(cfg.clickUrl ? { click: cfg.clickUrl } : {}),
  };
}

function sendOnce(cfg, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(cfg.ntfyServer.replace(/\/+$/, ''));
    } catch (err) {
      reject(new Error(`bad ntfyServer: ${err.message}`));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'User-Agent': 'band-notify/1.0',
    };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

    const transport = url.protocol === 'http:' ? http : https;
    if (process.env.BAND_NOTIFY_TRACE_REQUEST) {
      process.stderr.write(
        `[band-notify] POST ${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'http:' ? 80 : 443)}${url.pathname} ` +
          `bytes=${body.length}\n`,
      );
    }
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname.replace(/\/+$/, '')}/`,
        method: 'POST',
        headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, text });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function publish(cfg, notice) {
  const payload = buildPayload(cfg, notice);
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await sendOnce(cfg, payload);
      // Log the body too, not just the title: titles repeat ("✅ 已完成"), so only
      // the body identifies which notification a user is looking at on the phone.
      const body = String(payload.message || '').replace(/\s+/g, ' ');
      logLine(cfg, `sent ok topic=${cfg.topic} title="${payload.title}" body="${body}" http=${res.status}`);
      return { ok: true, payload };
    } catch (err) {
      lastErr = err;
      logLine(cfg, `attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < RETRIES) await sleep(600 * (attempt + 1));
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'unknown error', payload };
}

/** Run configured follow-up commands (used to keep the Codex computer-use listener alive). */
function runChain(cfg, notice) {
  const chain = Array.isArray(cfg.chain) ? cfg.chain : [];
  if (!chain.length) return;
  const { spawn } = require('child_process');
  for (const entry of chain) {
    try {
      const parts = Array.isArray(entry) ? entry : [entry];
      const [cmd, ...args] = parts;
      if (!cmd) continue;
      const child = spawn(cmd, args.map((a) => String(a)), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (err) => logLine(cfg, `chain "${cmd}" failed: ${err.message}`));
      child.unref();
      logLine(cfg, `chain started: ${cmd}`);
    } catch (err) {
      logLine(cfg, `chain error: ${err.message}`);
    }
  }
}

module.exports = { publish, buildPayload, logLine, runChain };
