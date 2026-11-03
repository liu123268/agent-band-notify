#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { loadConfig, isPlaceholderTopic } = require('../src/config');
const cfg = loadConfig();
const [major, minor] = process.versions.node.split('.').map(Number);
let failed = 0;
function check(name, ok, detail) {
  console.log(`[${ok ? 'OK' : 'FAIL'}] ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
}
check('Node.js >= 22.13', major > 22 || (major === 22 && minor >= 13), process.version);
check('Configuration', Boolean(cfg.__source) || Boolean(process.env.BAND_NOTIFY_TOPIC), cfg.__source || 'environment/defaults');
check('Private topic configured', !isPlaceholderTopic(cfg.topic));
try {
  const url = new URL(cfg.ntfyServer);
  check('Server URL', ['http:', 'https:'].includes(url.protocol), url.origin);
} catch { check('Server URL', false); }
try {
  check('Built-in SQLite support', Boolean(require('node:sqlite').DatabaseSync));
} catch { check('Built-in SQLite support', false); }
const agents = require('../src/agents');
check('Registered adapters', agents.list().every(p => !agents.validate(p).length), String(agents.list().length));
for (const p of agents.list()) {
  const found = p.dirs.some(dir => fs.existsSync(dir));
  console.log(`[${found ? 'FOUND' : 'INFO'}] ${p.id}: ${found ? 'data directory available' : 'software data not found; optional adapter stays idle'}`);
}
console.log('This check does not send a message or change any agent configuration.');
console.log('Delivery test: node notify.js --test (after subscribing on the phone).');
process.exitCode = failed ? 1 : 0;
