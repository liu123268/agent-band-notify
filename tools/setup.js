#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DEFAULTS } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function value(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
  return args[i + 1];
}

function main() {
  if (args.includes('--help')) {
    console.log('node tools/setup.js [--config file] [--topic name] [--server url] [--test]');
    console.log('Creates local config without changing agent settings or sending a message by default.');
    return;
  }
  if (args.includes('--codex')) {
    throw new Error('The watcher reads Codex session files directly; --codex does not modify Codex configuration.');
  }
  const file = path.resolve(value('--config') || process.env.BAND_NOTIFY_CONFIG || path.join(ROOT, 'config.json'));
  let cfg;
  if (fs.existsSync(file)) {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Configuration must be a JSON object');
  } else {
    cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  }
  cfg = Object.assign({}, DEFAULTS, cfg);
  const requested = value('--topic');
  if (requested) cfg.topic = requested;
  if (!cfg.topic || cfg.topic === 'REPLACE_ME') cfg.topic = `agent-${crypto.randomBytes(16).toString('hex')}`;
  if (!/^[A-Za-z0-9_-]{6,}$/.test(cfg.topic)) throw new Error('Use at least six letters, digits, underscores or hyphens for the topic');
  const server = value('--server');
  if (server) cfg.ntfyServer = server.replace(/\/+$/, '');
  const url = new URL(cfg.ntfyServer);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use HTTP or HTTPS');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`Configuration: ${file}`);
  console.log(`Server: ${cfg.ntfyServer}`);
  console.log(`Topic to subscribe on your phone: ${cfg.topic}`);
  console.log('Keep your topic and token private. Existing topics are retained when setup is run again.');
  console.log('Next: subscribe in ntfy, then run node notify.js --test');
  if (args.includes('--test') && !args.includes('--no-test')) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'notify.js'), '--config', file, '--test', '--json'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 35000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('Notification test process failed');
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw new Error('Notification test returned an invalid response'); }
    if (!response.ok) throw new Error(response.error || response.reason || 'Notification was not delivered');
    console.log('The server accepted the test notification. Check the phone and band separately.');
  }
}
try { main(); } catch (error) {
  console.error(`[setup] ${error.message}`);
  process.exitCode = 1;
}
