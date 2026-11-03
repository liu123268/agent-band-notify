'use strict';
/**
 * Config loading — zero dependencies, never throws.
 * Precedence: explicit path -> ../config.json (next to src) -> ~/.band-notify/config.json -> defaults
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  transport: 'ntfy',
  ntfyServer: 'https://ntfy.sh',
  topic: '',
  token: '',
  priority: 4,
  tags: ['robot', 'bell'],
  clickUrl: '',
  title: '{stateEmoji} {stateLabel}',
  body: '【{software}】{conversation} · {summary}',
  previewMax: 60,
  conversationMax: 16,
  minSeconds: 0,
  enabled: true,
  skip: false,
  logFile: 'notify.log',
  debug: false,
  chain: [],
};

function candidatePaths(explicit) {
  const out = [];
  if (explicit) out.push(explicit);
  out.push(path.join(__dirname, '..', 'config.json'));
  out.push(path.join(os.homedir(), '.band-notify', 'config.json'));
  return out;
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    // A missing or malformed config must never break the caller (an agent turn).
    if (process.env.BAND_NOTIFY_DEBUG) {
      process.stderr.write(`[band-notify] config read failed: ${file}: ${err.message}\n`);
    }
  }
  return null;
}

function loadConfig(explicitPath) {
  let merged = Object.assign({}, DEFAULTS);
  merged.__source = null;
  for (const file of candidatePaths(explicitPath || process.env.BAND_NOTIFY_CONFIG)) {
    const cfg = readJson(file);
    if (cfg) {
      merged = Object.assign({}, DEFAULTS, cfg);
      merged.__source = file;
      break;
    }
  }
  // Environment configuration also works on a fresh checkout with no config.json.
  if (process.env.BAND_NOTIFY_TOPIC) merged.topic = process.env.BAND_NOTIFY_TOPIC;
  if (process.env.BAND_NOTIFY_SERVER) merged.ntfyServer = process.env.BAND_NOTIFY_SERVER;
  if (process.env.BAND_NOTIFY_TOKEN) merged.token = process.env.BAND_NOTIFY_TOKEN;
  if (process.env.BAND_NOTIFY_MIN_SECONDS) merged.minSeconds = Number(process.env.BAND_NOTIFY_MIN_SECONDS);
  if (process.env.BAND_NOTIFY_ENABLED) merged.enabled = process.env.BAND_NOTIFY_ENABLED !== '0';
  if (process.env.BAND_NOTIFY_SKIP) merged.skip = process.env.BAND_NOTIFY_SKIP !== '0';
  if (process.env.BAND_NOTIFY_CHAIN) {
    try {
      merged.chain = JSON.parse(process.env.BAND_NOTIFY_CHAIN);
    } catch {
      /* ignore malformed override */
    }
  }
  return merged;
}

function isPlaceholderTopic(topic) {
  return !topic || topic === 'REPLACE_ME' || topic.length < 6;
}

module.exports = { loadConfig, DEFAULTS, isPlaceholderTopic };
