#!/usr/bin/env node
'use strict';
/**
 * Ground-truth check for the turn-text heuristics.
 *
 * Runs `looksLikeQuestion` / `looksLikeContinuing` over REAL Codex replies and
 * prints every hit with its trailing text. Reading the hits is the point: a
 * heuristic that was never checked against real messages is a guess.
 *
 *   node tools/check-turn-text.js [--limit n] [--only ask|cont]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { looksLikeQuestion, looksLikeContinuing } = require('../src/turn-text.js');

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 200;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : '';

function walk(dir, depth, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) walk(p, depth - 1, out);
    } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      try {
        out.push({ file: p, mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function metaOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(120000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return JSON.parse(nl === -1 ? text : text.slice(0, nl)).payload || {};
  } catch {
    return {};
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

const files = walk(SESSIONS, 3).sort((a, b) => b.mtime - a.mtime);
const messages = [];
for (const f of files) {
  const meta = metaOf(f.file);
  const kind = meta.parent_thread_id || (meta.thread_source && meta.thread_source !== 'user') ? 'sub' : 'user';
  let lines;
  try {
    lines = fs.readFileSync(f.file, 'utf8').split('\n');
  } catch {
    continue;
  }
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.type !== 'event_msg' || !o.payload || o.payload.type !== 'task_complete') continue;
    const msg = String(o.payload.last_agent_message || '').trim();
    if (!msg || msg.startsWith('{')) continue; // internal payloads already filtered elsewhere
    messages.push({ ts: o.timestamp, kind, msg });
  }
}

const asks = messages.filter((m) => looksLikeQuestion(m.msg));
const conts = messages.filter((m) => looksLikeContinuing(m.msg));

console.log(`共 ${messages.length} 条面向用户的回复（含子代理 ${messages.filter((m) => m.kind === 'sub').length}）`);
console.log(`判定为「提问/等你」: ${asks.length}`);
console.log(`判定为「仍在继续」: ${conts.length}\n`);

function show(list, label, n) {
  console.log(`########## ${label}（最近 ${Math.min(n, list.length)} 条）`);
  for (const m of list.slice(-n)) {
    console.log(`\n[${m.ts}] ${m.kind} len=${m.msg.length}`);
    console.log(`   …${m.msg.replace(/\s+/g, ' ').slice(-320)}`);
  }
}

if (!only || only === 'ask') {
  const userAsks = asks.filter((m) => m.kind === 'user');
  const subAsks = asks.filter((m) => m.kind === 'sub');
  show(userAsks, `提问/等你 · 主线程 ${userAsks.length} 条`, limit);
  console.log(`\n（另有子代理的提问 ${subAsks.length} 条，将被来源过滤掉）`);
}
if (only === 'cont') show(conts, '仍在继续', limit);
