'use strict';
/** Adapter registry: seven data sources for five desktop agents. Each source has one owner; the shared engine handles persistence and delivery. */
const profiles = [
  require('./workbuddy'),
  require('./workbuddy-approval'),
  require('./zcode'),
  require('./zcode-approval'),
  require('./codex'),
  require('./dsh'),
  require('./mimo'),
];

/**
 * Out-of-tree adapters, for two reasons that both matter:
 *   - the test suite injects a synthetic adapter instead of writing fixtures into the
 *     real `~/.workbuddy` / `~/.zcode` folders;
 *   - a user can prototype an adapter for a software we have not covered yet without
 *     editing this package at all.
 * Comma-separated module paths; a broken path is ignored (never fatal).
 */
if (process.env.BAND_NOTIFY_AGENT_MODULE) {
  for (const spec of process.env.BAND_NOTIFY_AGENT_MODULE.split(',')) {
    const trimmed = spec.trim();
    if (!trimmed) continue;
    try {
      const extra = require(trimmed);
      for (const profile of Array.isArray(extra) ? extra : [extra]) {
        if (profile && profile.id) profiles.push(profile);
      }
    } catch (err) {
      process.stderr.write(`[agents] 无法加载适配器 ${trimmed}: ${err.message}\n`);
    }
  }
}

/** All registered adapters, in a stable order. */
function list() {
  return profiles.slice();
}

/** One adapter by id, or null. */
function get(id) {
  return profiles.find((p) => p.id === id) || null;
}

/**
 * Validate an adapter at load time. A malformed adapter must fail loudly HERE
 * (during `--status`, in the foreground) rather than silently never notifying —
 * "silently never fires" is the single worst failure mode for this project.
 */
function validate(profile) {
  const problems = [];
  if (profile.mode && profile.mode !== 'append' && profile.mode !== 'rewrite') {
    problems.push(`未知 mode: ${profile.mode}`);
  }
  const rewrite = profile.mode === 'rewrite';
  // `turnEnd` and `snapshot` are the two halves of question 2; exactly one applies.
  const hooks = rewrite ? ['snapshot'] : ['turnEnd'];
  for (const field of ['id', 'label', 'dirs', 'filePattern', ...hooks]) {
    if (!profile[field]) problems.push(`缺少 ${field}`);
  }
  if (profile.dirs && !Array.isArray(profile.dirs)) problems.push('dirs 必须是数组');
  if (profile.filePattern && !(profile.filePattern instanceof RegExp)) {
    problems.push('filePattern 必须是正则');
  }
  // Whichever hook applies must be a function — an adapter that declares the wrong one
  // would otherwise load fine and then simply never notify, which is the single worst
  // failure mode this project has.
  for (const hook of ['turnEnd', 'snapshot']) {
    if (profile[hook] && typeof profile[hook] !== 'function') {
      problems.push(`${hook} 必须是函数`);
    }
  }
  if (!rewrite && profile.snapshot) {
    problems.push('append 型适配器不该有 snapshot（引擎不会调用它）');
  }
  if (rewrite && profile.turnEnd) {
    problems.push('rewrite 型适配器不该有 turnEnd（引擎不会调用它）');
  }
  // `selfRead` — 适配器自己打开文件（SQLite 库），引擎不尝试 JSON.parse。
  // 只对 rewrite 型有意义：append 型的字节读位由引擎管，适配器拿到的是行而非文件。
  if (profile.selfRead && !rewrite) {
    problems.push('selfRead 只对 rewrite 型有意义（append 型由引擎管字节读位）');
  }
  if (profile.selfRead !== undefined && typeof profile.selfRead !== 'boolean') {
    problems.push('selfRead 必须是布尔值');
  }
  return problems;
}

module.exports = { list, get, validate, PROFILES_DIR: __dirname };
