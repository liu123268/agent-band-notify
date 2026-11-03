#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-band-test-'));
const home = path.join(temp, 'home');
fs.mkdirSync(home, { recursive: true });
const env = Object.assign({}, process.env, {
  USERPROFILE: home, HOME: home,
  BAND_NOTIFY_URL: 'http://127.0.0.1:9',
  BAND_NOTIFY_TOPIC: 'offline-test-only',
  BAND_NOTIFY_AGENT_MODULE: '',
  BAND_NOTIFY_AGENT_STATE: path.join(temp, 'state.json'),
  BAND_NOTIFY_AGENT_SEEN: path.join(temp, 'seen.json'),
  BAND_NOTIFY_AGENT_CACHE: path.join(temp, 'cache.json'),
  BAND_NOTIFY_AGENT_LOG: path.join(temp, 'watch.log'),
  BAND_NOTIFY_AGENT_HEARTBEAT: path.join(temp, 'heartbeat.json'),
  BAND_NOTIFY_AUDIT_CODEX_CONFIG: path.join(home, 'config.toml'),
  BAND_NOTIFY_AUDIT_STARTUP: path.join(home, 'Startup'),
  BAND_NOTIFY_AUDIT_TASK: path.join(home, 'no-task'),
});
for (const key of ['BAND_NOTIFY_TOKEN', 'BAND_NOTIFY_SERVER', 'BAND_NOTIFY_CONFIG', 'BAND_NOTIFY_CHAIN',
  'BAND_NOTIFY_CODEX_DIR', 'BAND_NOTIFY_SESSION_DIR', 'BAND_NOTIFY_WORKBUDDY_DIR',
  'BAND_NOTIFY_ZCODE_DIR', 'BAND_NOTIFY_MIMO_DB', 'BAND_NOTIFY_ZCODE_DB']) delete env[key];
const suites = [
  ['tools/test.js', 'all'],
  ['tools/test-agent-watch.js'],
  ['tools/test-workbuddy.js'],
  ['--test', 'tests/portable.test.js'],
  ['--test', 'tests/quickstart.test.js'],
  ['tools/check-vbs.js'],
  ['tools/audit-invariants.js', '--quiet'],
];
let failures = 0;
try {
  for (const args of suites) {
    console.log(`\n=== ${args.join(' ')} ===`);
    const result = spawnSync(process.execPath, args,
      { cwd: ROOT, env, stdio: 'inherit', windowsHide: true, timeout: 240000 });
    if (result.error || result.status !== 0) failures++;
  }
} finally {
  if (temp.startsWith(path.join(os.tmpdir(), 'agent-band-test-'))) fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`\nTest suites: ${suites.length - failures} passed, ${failures} failed.`);
process.exitCode = failures ? 1 : 0;
