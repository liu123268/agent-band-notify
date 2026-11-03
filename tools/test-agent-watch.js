#!/usr/bin/env node
'use strict';
/**
 * Tests for the generic watcher engine and its adapters.
 *
 * Two kinds of test, deliberately:
 *
 *  1. REAL-DATA INVARIANTS — the adapter's key assumption is re-checked against the
 *     software's actual log files on this machine. This is what catches "the software
 *     changed its format" before it becomes a wrong or missing notification.
 *     (The WorkBuddy adapter claims: an assistant message carrying a `message` field
 *     is ALWAYS the end of a turn. That is asserted over every real transcript.)
 *
 *  2. ENGINE BEHAVIOUR — with a synthetic adapter in a temp directory, so the real
 *     `~/.workbuddy` and `~/.zcode` folders are never written to and no notification
 *     is ever sent (`--dry-run`, which records instead of spawning).
 *
 *   node tools/test-agent-watch.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// The sandbox must exist and be advertised in the environment BEFORE the engine and
// the adapter registry are required: both read their configuration at load time,
// exactly like the real watcher does when it starts.
// ---------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(__dirname, 'agent-watch.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-engine-'));
const sessions = path.join(tmpRoot, 'sessions');
const logs = path.join(tmpRoot, 'logs');
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(logs, { recursive: true });
const sessionFile = path.join(sessions, 's1.jsonl');
const adapterFile = path.join(tmpRoot, 'test-adapter.js');

fs.writeFileSync(
  adapterFile,
  `'use strict';
module.exports = {
  id: 'testagent',
  label: 'TestAgent',
  dirs: [process.env.TEST_SESSIONS],
  depth: 1,
  filePattern: /\\.jsonl$/,
  mode: 'append',
  turnEnd(ev) {
    if (!ev || ev.type !== 'turn-end') return null;
    return {
      key: String(ev.id),
      state: ev.ask ? 'ask' : 'done',
      priority: ev.ask ? 4 : 0,
      text: ev.text || '',
      conversation: ev.conversation || '',
      kind: 'turn-end',
      log: ev.ask ? '等待回答' : '任务完成',
    };
  },
  conversation() { return '兜底名字'; },
};
`,
  'utf8',
);

// A second synthetic adapter, in 'rewrite' mode: one JSON object per file, rewritten in
// place. This is the shape DSH uses, and it needs a different engine path, so it is
// exercised here on synthetic data rather than only on the real DSH sessions.
const rewriteFile = path.join(tmpRoot, 'test-rewrite-adapter.js');
const rewriteDir = path.join(tmpRoot, 'rewrite');
fs.mkdirSync(rewriteDir, { recursive: true });
fs.writeFileSync(
  rewriteFile,
  `'use strict';
module.exports = {
  id: 'testrewrite',
  label: 'TestRewrite',
  dirs: [process.env.TEST_REWRITE_DIR],
  depth: 0,
  filePattern: /\\.json$/,
  mode: 'rewrite',
  snapshot(json, info) {
    // Mirrors the contract documented on DSH: the engine cannot baseline a rewritten file
    // (there is no offset to remember), so the ADAPTER stays silent on first sight.
    const seenKey = 'seen:' + info.file;
    if (!info.cache.get(seenKey)) {
      info.cache.set(seenKey, 1);
      return null;
    }
    if (!json || json.done !== true) return null;
    return {
      key: String(json.turn),
      state: 'done',
      priority: 0,
      text: json.text || '',
      conversation: '重写型会话',
      kind: 'turn-end',
      log: '任务完成',
    };
  },
};
`,
  'utf8',
);

// A third and fourth synthetic adapter, this pair being a CONTROLLED EXPERIMENT for
// `selfRead`. Both watch the SAME non-JSON file with the same file pattern; the only
// difference is the `selfRead` flag. That is what isolates the engine change: if the
// flag does nothing, both behave identically and the test below fails.
const selfReadDir = path.join(tmpRoot, 'selfread');
fs.mkdirSync(selfReadDir, { recursive: true });
const selfReadFile = path.join(tmpRoot, 'test-selfread-adapter.js');
const noSelfReadFile = path.join(tmpRoot, 'test-noselfread-adapter.js');

fs.writeFileSync(
  selfReadFile,
  `'use strict';
module.exports = {
  id: 'testselfread',
  label: 'TestSelfRead',
  dirs: [process.env.TEST_SELFREAD_DIR],
  depth: 0,
  filePattern: /\\.blob$/,
  mode: 'rewrite',
  selfRead: true,
  snapshot(json, info) {
    // The engine must hand a selfRead adapter \`null\` — it must not have tried to parse.
    if (json !== null) return null;
    let content = '';
    try { content = require('fs').readFileSync(info.file, 'utf8'); } catch { return null; }
    const seenKey = 'seen:' + info.file;
    if (!info.cache.get(seenKey)) { info.cache.set(seenKey, 1); return null; }
    if (!content.includes('PENDING')) return null;
    return { key: 'selfread-1', state: 'approval', priority: 4, text: content,
             conversation: '自读型', kind: 'ask-approval', log: '等待批准' };
  },
};
`,
  'utf8',
);

fs.writeFileSync(
  noSelfReadFile,
  `'use strict';
// Same file, same pattern, no selfRead: the engine will try to JSON.parse the blob,
// fail on every poll and never call snapshot. That is the OLD behaviour, kept here so
// the experiment has a control group.
module.exports = {
  id: 'testnoselfread',
  label: 'TestNoSelfRead',
  dirs: [process.env.TEST_SELFREAD_DIR],
  depth: 0,
  filePattern: /\\.blob$/,
  mode: 'rewrite',
  snapshot() {
    return { key: 'should-never-fire', state: 'approval', priority: 4, text: '不该出现',
             conversation: '不该出现', kind: 'ask-approval', log: '等待批准' };
  },
};
`,
  'utf8',
);

process.env.BAND_NOTIFY_AGENT_MODULE = [adapterFile, rewriteFile, selfReadFile, noSelfReadFile].join(',');
process.env.TEST_SESSIONS = sessions;
process.env.TEST_REWRITE_DIR = rewriteDir;
process.env.TEST_SELFREAD_DIR = selfReadDir;
process.env.BAND_NOTIFY_AGENT_STATE = path.join(logs, 'state.json');
process.env.BAND_NOTIFY_AGENT_SEEN = path.join(logs, 'seen.json');
process.env.BAND_NOTIFY_AGENT_CACHE = path.join(logs, 'cache.json');
process.env.BAND_NOTIFY_AGENT_LOG = path.join(logs, 'watch.log');
// Must be redirected too: otherwise the heartbeat tests would overwrite the real
// watcher's liveness record, i.e. a test run would make the running watcher look dead.
process.env.BAND_NOTIFY_AGENT_HEARTBEAT = path.join(logs, 'hb.json');

const engine = require(ENGINE);
const workbuddy = require('../src/agents/workbuddy.js');
const zcode = require('../src/agents/zcode.js');
const codex = require('../src/agents/codex.js');
const dsh = require('../src/agents/dsh.js');
const workbuddyApproval = require('../src/agents/workbuddy-approval.js');
const notice = require('../src/notice.js');
const opencodePerms = require('../src/agents/opencode-permissions.js');
const zcodeApproval = require('../src/agents/zcode-approval.js');
const mimo = require('../src/agents/mimo.js');
const agents = require('../src/agents/index.js');

// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    if (/跳过（不算失败）/.test(err.message)) {
      skipped += 1;
      console.log(`  - SKIP ${name}: ${err.message}`);
      return;
    }
    failed += 1;
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

/** Adapters need a `cache`; the engine normally supplies a persisted one. */
function memCache(store = {}) {
  return {
    get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined),
    set: (k, v) => {
      store[k] = v;
    },
  };
}

/** Drive the engine exactly as the command line does, but without a child process. */
function runEngine(argv = [], agent = 'testagent') {
  const original = console.log;
  console.log = () => {};
  try {
    // `agent` is a parameter, not just an argv entry: flagValue() takes the FIRST --agent,
    // so appending a second one would be silently ignored and the test would pass having
    // scanned the wrong adapter.
    return engine.run(['--agent', agent, '--once', '--dry-run', ...argv]);
  } finally {
    console.log = original;
  }
}

function capture(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

/** Simulates a watcher restart: forget in-memory state, re-read what is on disk. */
const restart = () => engine.reload();
const sent = () => engine.runtime.sent;

// ------------------------------------------------------------------ adapters: unit

group('WorkBuddy 适配器 · 判定规则');

test('中间轮次的 assistant 文字（无 message 字段）不算结束', () => {
  const ev = {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: '环境就绪，现在渲染图片。' }],
  };
  assert.strictEqual(workbuddy.turnEnd(ev, { file: 'x', cache: memCache() }), null);
});

test('带 message/usage 的 assistant 文字 = 轮次结束', () => {
  const ev = {
    id: 'm1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    message: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    content: [{ type: 'output_text', text: '已经改好了。' }],
    cwd: 'D:\\dsh-workspace\\band-notify',
    sessionId: 's1',
  };
  const d = workbuddy.turnEnd(ev, { file: 'x', cache: memCache() });
  assert.ok(d, '应判定为轮次结束');
  assert.strictEqual(d.state, 'done');
  assert.strictEqual(d.key, 'm1');
  assert.strictEqual(d.text, '已经改好了。');
});

test('结尾带提问 → 仍然是 ✅ 已完成（WorkBuddy 不再猜文字，2026-10-06 反转）', () => {
  // 这条断言原来锁的是"结尾是问句就报 ❓"。2026-10-06 反转，理由是实测：
  // 162 条真实 WorkBuddy 轮次里 61.7% 被判 ❓，而同期真正的 AskUserQuestion 只有 14 次，
  // 且 0% 的标记轮次被真的回答过。WorkBuddy 在这里当老师用，课末苏格拉底反问是
  // **收尾**不是**交回控制权**。精确信号见 test-workbuddy.js 的 askPending。
  const ev = {
    id: 'm2',
    type: 'message',
    role: 'assistant',
    message: { usage: {} },
    content: [{ type: 'output_text', text: '你希望我用哪种方案，A 还是 B？' }],
  };
  const d = workbuddy.turnEnd(ev, { file: 'x', cache: memCache() });
  assert.strictEqual(d.state, 'done');
  assert.strictEqual(d.priority, 0);
});

test('设 BAND_NOTIFY_ASK_FROM_TEXT=0 → 退回"只有 DSH 能报 ❓"', () => {
  const ev = {
    id: 'm3',
    type: 'message',
    role: 'assistant',
    message: { usage: {} },
    content: [{ type: 'output_text', text: '你希望我用哪种方案，A 还是 B？' }],
  };
  process.env.BAND_NOTIFY_ASK_FROM_TEXT = '0';
  try {
    const d = workbuddy.turnEnd(ev, { file: 'x', cache: memCache() });
    assert.strictEqual(d.state, 'done');
    assert.strictEqual(d.priority, 0);
  } finally {
    delete process.env.BAND_NOTIFY_ASK_FROM_TEXT;
  }
});

test('用户消息 / 工具调用不算结束', () => {
  const cache = memCache();
  assert.strictEqual(workbuddy.turnEnd({ type: 'message', role: 'user' }, { file: 'x', cache }), null);
  assert.strictEqual(workbuddy.turnEnd({ type: 'function_call', name: 'Read' }, { file: 'x', cache }), null);
});

test('会话标题从 ai-title 读取并写进缓存', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-title-'));
  const file = path.join(tmp, 's.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session-meta', sessionId: 's' }),
      JSON.stringify({ type: 'ai-title', aiTitle: '理解 ntfy 与通用 agent 集成' }),
      JSON.stringify({ type: 'message', role: 'user', content: [] }),
    ].join('\n') + '\n',
  );
  const cache = memCache();
  const ev = {
    id: 'm3',
    type: 'message',
    role: 'assistant',
    message: { usage: {} },
    content: [{ type: 'output_text', text: '好。' }],
  };
  const d = workbuddy.turnEnd(ev, { file, cache });
  assert.strictEqual(d.conversation, '理解 ntfy 与通用 agent 集成');
  // Second call must not re-read the file.
  fs.unlinkSync(file);
  assert.strictEqual(workbuddy.turnEnd(ev, { file, cache }).conversation, '理解 ntfy 与通用 agent 集成');
  fs.rmSync(tmp, { recursive: true, force: true });
});

group('ZCode 适配器 · 判定规则');

test('turn.started / turn.phase.completed 不算结束', () => {
  const cache = memCache();
  assert.strictEqual(zcode.turnEnd({ event: 'turn.started', sessionId: 'sess_a' }, { file: 'x', cache }), null);
  assert.strictEqual(
    zcode.turnEnd(
      { event: 'turn.phase.completed', sessionId: 'sess_a', context: { phase: 'regular_turn_loop' } },
      { file: 'x', cache },
    ),
    null,
  );
});

test('turn.completed = 轮次结束，key 用 turnId', () => {
  const ev = {
    event: 'turn.completed',
    sessionId: 'sess_19239d85-1dbd-41bb-aa6b-bd9a0288d29d',
    turnId: 'turn_abc',
    status: 'completed',
    durationMs: 296513,
    context: { toolCallCount: 4 },
  };
  const d = zcode.turnEnd(ev, { file: 'x', cache: memCache() });
  assert.ok(d);
  assert.strictEqual(d.key, 'turn_abc');
  assert.strictEqual(d.state, 'done');
  assert.strictEqual(d.elapsedMs, 296513);
  assert.strictEqual(d.conversation, '19239d85');
});

test('子代理会话静默', () => {
  const ev = { event: 'turn.completed', sessionId: 'sess_subagent_agent_1', turnId: 't1' };
  assert.strictEqual(zcode.turnEnd(ev, { file: 'x', cache: memCache() }), null);
});

test('turn.failed / status 非 completed → ⚠️ 出错了，优先级 5', () => {
  const d = zcode.turnEnd({ event: 'turn.failed', sessionId: 'sess_a', turnId: 't9' }, { file: 'x', cache: memCache() });
  assert.strictEqual(d.state, 'error');
  assert.strictEqual(d.priority, 5);
});

test('结尾是问句 → ❓ 等你回答；BAND_NOTIFY_ASK_FROM_TEXT=0 时退回 ✅ 已完成', () => {
  // ZCode 没有任何"正在问用户"的字段，只能靠结尾文字猜。但"猜"必须在代码里真的接上：
  // 2026-10-05 的事故形态是 README 写着「Codex / ZCode 靠结尾文字猜 ❓」，而 zcode.js
  // 压根没调用策略层 → ZCode 永远只报 ✅ 已完成。这条锁的就是那根线，外加用户要的
  // 那个"一个环境变量管住所有软件的猜"的 opt-out。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-zcode-'));
  const sessionId = 'sess_19239d85-1dbd-41bb-aa6b-bd9a0288d29d';
  const rollout = path.join(dir, `model-io-${sessionId}.jsonl`);
  const ev = { event: 'turn.completed', sessionId, turnId: 'turn_q1', status: 'completed' };
  const write = (text) =>
    fs.writeFileSync(rollout, `${JSON.stringify({ turnId: 'turn_q1', response: { text } })}\n`, 'utf8');
  const stateNow = () => zcode.turnEnd(ev, { file: 'x', cache: memCache() });

  const prevDir = process.env.BAND_NOTIFY_ZCODE_ROLLOUT_DIR;
  const prevAsk = process.env.BAND_NOTIFY_ASK_FROM_TEXT;
  process.env.BAND_NOTIFY_ZCODE_ROLLOUT_DIR = dir;
  try {
    write('已经改好了。要不要我现在就重启监听？');
    const asked = stateNow();
    assert.ok(asked, '应该产出描述符');
    assert.strictEqual(asked.state, 'ask', '结尾是问句 → ❓ 等你回答');
    assert.strictEqual(asked.priority, 4);

    write('已经改好了，重启完成。');
    assert.strictEqual(stateNow().state, 'done', '陈述句仍应是 ✅ 已完成');

    process.env.BAND_NOTIFY_ASK_FROM_TEXT = '0';
    write('已经改好了。要不要我现在就重启监听？');
    assert.strictEqual(stateNow().state, 'done', 'BAND_NOTIFY_ASK_FROM_TEXT=0 时不许猜');
  } finally {
    if (prevDir === undefined) delete process.env.BAND_NOTIFY_ZCODE_ROLLOUT_DIR;
    else process.env.BAND_NOTIFY_ZCODE_ROLLOUT_DIR = prevDir;
    if (prevAsk === undefined) delete process.env.BAND_NOTIFY_ASK_FROM_TEXT;
    else process.env.BAND_NOTIFY_ASK_FROM_TEXT = prevAsk;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------- Codex / DSH adapter units
//
// Both adapters were migrated out of the standalone tools/codex-watch.js and
// tools/dsh-watch.js. The scenarios below are the ones that cost real debugging to
// discover, so they are pinned here rather than living only in the retired scripts.

/** A rollout as Codex writes it: session_meta first, then events. */
function codexRollout(identity, ...events) {
  return [
    JSON.stringify({ type: 'session_meta', payload: Object.assign({ cwd: 'D:\\proj' }, identity) }),
    ...events.map((e) => JSON.stringify(e)),
  ].join('\n');
}

function codexTurnEnd(event, identity, cache = memCache()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-codex-'));
  const file = path.join(tmp, 'rollout-2026-10-05T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.writeFileSync(file, codexRollout(identity), 'utf8');
  try {
    return codex.turnEnd(event, { file, event, cache });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const USER_THREAD = { thread_source: 'user', source: 'vscode' };
const taskComplete = (payload) => ({ type: 'event_msg', payload: Object.assign({ type: 'task_complete' }, payload) });

group('Codex 适配器 · 判定规则');

test('task_complete + 用户线程 + 真回复 → 通知，key 用 turn_id', () => {
  const d = codexTurnEnd(
    taskComplete({ turn_id: 't-1', last_agent_message: '已经把 gitignore 检查完了。' }),
    USER_THREAD,
  );
  assert.ok(d, '应判定为轮次结束');
  assert.strictEqual(d.key, 't-1');
  assert.strictEqual(d.state, 'done');
  assert.strictEqual(d.conversation, ''); // resolved later from the thread index
  assert.ok(/gitignore/.test(d.text));
});

test('task_complete 结尾带提问 → 仍然是 ✅ 已完成（Codex 不再猜文字，2026-10-08）', () => {
  // 2026-10-08 15:20 现场：一轮已经干完了（文档复核完、提交信息都拟好了、明确写着"尚未执行提交"），
  // 结尾一句"So 你觉得这样的结果符合你的预期吗，还是其中有一项你希望换成更有用的内容？"
  // 被推成 ❓ 等你回答。用户原话："20分codex完成任务。但是识别出来是等我回答。"
  // 而那个会话 request_user_input_async 调用 **0 次** —— 精确信号根本没响。
  // 行为学实测：253 条被标记的 Codex 轮次里只有 11 条（4%）真被回答过。
  const d = codexTurnEnd(
    taskComplete({
      turn_id: 't-8',
      last_agent_message: '文档复核完了，提交信息已拟好，尚未执行提交。你觉得这样的结果符合你的预期吗？',
    }),
    USER_THREAD,
  );
  assert.strictEqual(
    d.state,
    'done',
    '文字不再参与判定 —— 真正的提问由 request_user_input_async 在调用那一刻通知',
  );
  assert.strictEqual(d.priority, 0);
});

test('request_user_input_async → 立刻判 ❓（Codex 的一等提问信号，2026-10-07 实测）', () => {
  // src/turn-text.js 曾说"Codex 没有 ask 事件，request_user_input_async 只出现在指令文本里"
  // —— 那句话是错的。真实 rollout 里它是 function_call，一晚调了两次，两次都没发通知。
  // delivery=async（紧跟 {"accepted":true}），所以"轮次结束"永远看不到它：
  // 必须在调用那一刻通知。Codex 用 title，WorkBuddy 用 question。
  const ev = {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: 'call_W25sDfGx4bMbE1nUD7M8RHJ0',
      arguments: JSON.stringify({
        questions: [{ title: '是否允许现在发布到现有云主机？', options: ['允许', '暂不改'] }],
      }),
    },
  };
  const d = codexTurnEnd(ev, USER_THREAD);
  assert.ok(d, '必须产出通知描述符');
  assert.strictEqual(d.state, 'ask');
  assert.strictEqual(d.priority, 4);
  assert.strictEqual(d.kind, 'ask-pending');
  assert.strictEqual(d.key, 'ask:call_W25sDfGx4bMbE1nUD7M8RHJ0', '去重键必须用 call_id');
  assert.ok(d.text.includes('是否允许现在发布'), '正文要带问题原文，实际: ' + d.text);
  assert.ok(!d.text.includes('暂不改'), '选项不进正文（否则超 previewMax 被截断）');
});

test('提问的后续行（function_call_output / item_completed）→ 不重复通知', () => {
  assert.strictEqual(
    codexTurnEnd(
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_x', output: '{"accepted":true}' } },
      USER_THREAD,
    ),
    null,
  );
  // item_completed 是 event_msg，带着同样的 questions —— 不能再发一条
  assert.strictEqual(
    codexTurnEnd(
      { type: 'event_msg', payload: { type: 'item_completed', item: { questions: [{ title: 'x' }] } } },
      USER_THREAD,
    ),
    null,
  );
});

test('子代理调 request_user_input_async → 静默（不许子代理的提问打扰用户）', () => {
  const ev = {
    type: 'response_item',
    payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call_sub', arguments: '{"questions":[]}' },
  };
  assert.strictEqual(
    codexTurnEnd(ev, { thread_source: 'guardian_review', parent_thread_id: '01a1162b-63f0-7c82-9442-f6665c52668a' }),
    null,
  );
});

// ── Codex「等你批准」（2026-10-09 新增）────────────────────────────────────────
// ⚠️ 本机**从未产生过** approval 事件：415 个 rollout 精确搜 `"exec_approval_request"`
//    只命中一段被粘贴的 Rust 源码；最近 45 个文件的 event_msg 里只有
//    item_completed / token_count / thread_settings_applied / task_started /
//    task_complete / turn_aborted。原因写在同一个文件里：
//        approval_policy: "on-request"     approvals_reviewer: "auto_review"
//    —— 审批由 Codex 自己的审查器做了，不打扰人。
//    所以下面这些样本按 **官方 protocol.rs / approvals.rs 的 EventMsg 形状**构造
//    （`#[serde(tag="type", rename_all="snake_case")]` → type 字符串就是变体的 snake_case），
//    不是凭印象编的。用户明确要求「虽然几乎遇不到，功能也要做出来」。

const approvalEvent = (payload) =>
  ({ type: 'event_msg', payload: Object.assign({ type: 'exec_approval_request' }, payload) });

test('exec_approval_request → ❓ 等你批准，正文带命令', () => {
  const d = codexTurnEnd(
    approvalEvent({
      approval_id: 'appr-1',
      call_id: 'call_abc',
      turn_id: 't-9',
      command: ['rm', '-rf', 'D:\\proj\\tmp'],
      cwd: 'D:\\proj',
      reason: null,
    }),
    USER_THREAD,
  );
  assert.ok(d, '请求批准必须报 —— 这正是这个分支存在的理由');
  assert.strictEqual(d.state, 'approval');
  assert.strictEqual(d.kind, 'ask-approval');
  assert.strictEqual(d.priority, 4, '阻塞态必须高优先级');
  assert.strictEqual(d.key, 'approval:appr-1:exec_approval_request', '优先用协议自己的 approval_id');
  assert.ok(/rm -rf/.test(d.text), '正文要带命令，实际: ' + d.text);
});

test('apply_patch_approval_request → 正文说清要改几个文件', () => {
  const d = codexTurnEnd(
    approvalEvent({
      type: 'apply_patch_approval_request',
      call_id: 'call_p1',
      turn_id: 't-10',
      changes: { 'D:\\proj\\a.ts': { type: 'add' }, 'D:\\proj\\b.ts': { type: 'update' } },
    }),
    USER_THREAD,
  );
  assert.ok(d);
  assert.strictEqual(d.state, 'approval');
  assert.strictEqual(d.key, 'approval:call_p1:apply_patch_approval_request');
  assert.strictEqual(d.text, '要修改 2 个文件，等你批准');
});

test('request_permissions / elicitation_request → 同样判 ❓ 等你批准', () => {
  const perm = codexTurnEnd(
    approvalEvent({ type: 'request_permissions', id: 'perm-1', reason: '需要写 D:\\other' }),
    USER_THREAD,
  );
  assert.ok(perm);
  assert.strictEqual(perm.state, 'approval');
  assert.strictEqual(perm.key, 'approval:perm-1:request_permissions');
  assert.ok(perm.text.includes('D:\\other'), perm.text);

  const elicit = codexTurnEnd(
    approvalEvent({ type: 'elicitation_request', id: 7, server_name: 'github-mcp', request: { mode: 'form' } }),
    USER_THREAD,
  );
  assert.ok(elicit);
  assert.strictEqual(elicit.state, 'approval');
  assert.ok(elicit.text.includes('github-mcp'), elicit.text);
});

test('协议字段全缺时也要给出一句人话（正文绝不能为空）', () => {
  const d = codexTurnEnd(approvalEvent({ call_id: 'call_bare' }), USER_THREAD);
  assert.ok(d);
  assert.strictEqual(d.state, 'approval');
  assert.ok(d.text && d.text.trim().length > 0, '正文不能为空');
});

test('子代理的请求批准 → 静默（与提问共用同一条来源过滤）', () => {
  assert.strictEqual(codexTurnEnd(approvalEvent({ call_id: 'call_sub_appr' }), { thread_source: 'guardian_review' }), null);
});

test('普通 event_msg 不会被误判成「等你批准」', () => {
  for (const type of ['item_completed', 'token_count', 'thread_settings_applied', 'task_started']) {
    assert.strictEqual(codexTurnEnd({ type: 'event_msg', payload: { type } }, USER_THREAD), null, `${type} 不该报`);
  }
});

test('子代理线程 / 守护评审 → 明明完成了也不通知', () => {
  const sub = codexTurnEnd(
    taskComplete({ turn_id: 't-2', last_agent_message: '已完成第 2 项检查。' }),
    { thread_source: 'subagent', parent_thread_id: '01a100d3-f758-78b1-b273-76ecf38d39bd', agent_nickname: 'Meitner' },
  );
  assert.ok(sub && sub.skip, '应返回 skip（并写进日志），而不是悄悄消失');
  assert.ok(/非用户线程/.test(sub.skip));

  const guardian = codexTurnEnd(
    taskComplete({ turn_id: 't-3', last_agent_message: '评审通过，没有发现问题。' }),
    { thread_source: 'guardian_review' },
  );
  assert.ok(guardian && guardian.skip);
});

test('首次读取失败不能被永久记住（否则那个子代理 rollout 会一直误报完成）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-codex-'));
  const file = path.join(tmp, 'rollout-2026-10-05T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  const cache = memCache();
  try {
    // 1) The poll lands on a rollout that exists but has not been written yet, so
    //    reading the session_meta fails. That case must stay permissive: an unreadable
    //    identity must never swallow a genuine completion.
    fs.writeFileSync(file, '', 'utf8');
    const blind = codex.turnEnd(
      taskComplete({ turn_id: 't-blind', last_agent_message: '这一步到底该不该响？' }),
      { file, event: null, cache },
    );
    assert.ok(blind && !blind.skip, '读不到元数据时应按"可能是用户线程"放行');
    // ...and the failure must not have been written into the memo at all, which is the
    // mechanism that made it permanent.
    assert.strictEqual(cache.get(`kind:${file}`), undefined, '读取失败不得进入缓存');

    // 2) The same file is then written with its real identity: a subagent thread.
    fs.writeFileSync(
      file,
      codexRollout({ thread_source: 'subagent', parent_thread_id: '01a100d3-f758-78b1-b273-76ecf38d39bd' }),
      'utf8',
    );
    const after = codex.turnEnd(
      taskComplete({ turn_id: 't-after', last_agent_message: '已完成第 2 项检查。' }),
      { file, event: null, cache },
    );
    // If that first failure had been memoised, this would still be permissive and every
    // subagent step would arrive as "✅ 已完成" — the exact bug this filter exists for.
    assert.ok(after && after.skip, '元数据补上后必须立刻纠正为子代理，不能被旧的失败结果锁住');
    assert.ok(/非用户线程/.test(after.skip), after.skip);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('安全检查器 / 空回复 → 跳过（它们是 task_complete，但不是回复）', () => {
  const cls = codexTurnEnd(
    taskComplete({
      turn_id: 't-4',
      last_agent_message: '{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"只读"}',
    }),
    USER_THREAD,
  );
  assert.ok(cls && cls.skip);
  assert.ok(/安全检查器/.test(cls.skip));

  const empty = codexTurnEnd(taskComplete({ turn_id: 't-5', last_agent_message: '' }), USER_THREAD);
  assert.ok(empty && empty.skip);
});

test('turn_aborted 默认静默（用户按停止和崩溃是同一个事件）', () => {
  const d = codexTurnEnd({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't-6' } }, USER_THREAD);
  assert.ok(d && d.skip);
  assert.ok(/中断轮次/.test(d.skip));
});

test('额度用尽 → ⚠️ 出错了 + 优先级 5（空回复也不能被吞掉）', () => {
  const d = codexTurnEnd(
    taskComplete({
      turn_id: 't-7',
      last_agent_message: '',
      error: { message: "You've hit your usage limit. Try again at Oct 4th.", codex_error_info: 'usage_limit_exceeded' },
    }),
    USER_THREAD,
  );
  assert.ok(d && !d.skip);
  assert.strictEqual(d.state, 'error');
  assert.strictEqual(d.priority, 5);
  assert.ok(/usage limit/i.test(d.text));
});

test('非 event_msg / 无关 payload 一律不算结束', () => {
  const cache = memCache();
  assert.strictEqual(codexTurnEnd({ type: 'response_item', payload: { type: 'reasoning' } }, USER_THREAD, cache), null);
  assert.strictEqual(codexTurnEnd({ type: 'event_msg', payload: { type: 'task_started' } }, USER_THREAD, cache), null);
});

test('线程身份读一次就进缓存，不会每次重读文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-codex-cache-'));
  const file = path.join(tmp, 'rollout-2026-10-05T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.writeFileSync(file, codexRollout(USER_THREAD), 'utf8');
  const cache = memCache();
  const ev = taskComplete({ turn_id: 't-8', last_agent_message: '好。' });
  assert.strictEqual(codex.turnEnd(ev, { file, event: ev, cache }).key, 't-8');
  fs.unlinkSync(file); // second call must not need the file at all
  assert.strictEqual(codex.turnEnd(ev, { file, event: ev, cache }).key, 't-8');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------- DSH

/** A DSH session cache file with just the fields the adapter reads. */
function dshSession({ open = null, lastTurn = 1, title = '测试会话', response = '已经做完了', ...rest } = {}) {
  return Object.assign(
    {
      record: {
        identity: { cwd: 'D:\\dsh-workspace' },
        rows: {
          turnBoundary: { val: { openTurnStartSeq: open, lastTurn } },
          sessionStats: { val: { turns: lastTurn } },
          title: { val: title },
          turnOutline: { val: { turns: response ? [{ response }] : [] } },
        },
      },
    },
    rest,
  );
}

group('DSH 适配器 · 判定规则（整文件快照）');

test('第一次见到会话文件 → 不出声（历史不是新闻）', () => {
  const cache = memCache();
  const json = dshSession({ lastTurn: 54, title: '旧会话' });
  assert.strictEqual(dsh.snapshot(json, { file: 'session-a.json', json, cache }), null);
});

test('看着一轮开→关 → 通知 1 次，且正文是真回复而不是状态词', () => {
  const cache = memCache();
  const file = 'session-a.json';
  dsh.snapshot(dshSession({ open: 100, lastTurn: 1 }), { file, json: {}, cache });

  const json = dshSession({ open: null, lastTurn: 2, response: '量完了，顺手修掉了一个真问题。' });
  const d = dsh.snapshot(json, { file, json, cache });
  assert.ok(d, '轮次结束应通知');
  assert.strictEqual(d.key, `session-a#2`);
  assert.strictEqual(d.state, 'done');
  // The retired watcher computed this text and then threw it away, sending the constant
  // "已经做完了" as the notification body instead. Pin the real text.
  assert.ok(/量完了/.test(d.text), `正文应是回复原文，实际="${d.text}"`);
});

test('同一轮被反复观察到闭合 → 报的是同一个轮次身份（去重交给引擎）', () => {
  const cache = memCache();
  const file = 'session-b.json';
  const keys = [];
  const observe = (open, lastTurn) => {
    const json = dshSession({ open, lastTurn });
    const d = dsh.snapshot(json, { file, json, cache });
    if (d) keys.push(d.key);
  };
  observe(200, 1); // 开
  observe(null, 2); // 关 → 第一次
  observe(200, 2); // DSH 重写缓存时把边界又标成开
  observe(null, 2); // 再关
  observe(200, 2); // 又来一次
  observe(null, 2);

  // The adapter's job is to NAME the turn, not to count it: every observation of turn 2
  // must carry the same identity, and the engine's dedup table (below) is what turns that
  // into exactly one buzz. Splitting the job this way is deliberate — a second dedup inside
  // the adapter would be a second source of truth for "have we sent this already".
  assert.deepStrictEqual(keys, ['session-b#2', 'session-b#2', 'session-b#2']);
});

test('基线那一轮事后被重写成"刚闭合" → 不当成新闻（恢复会话会重放历史）', () => {
  const cache = memCache();
  const file = 'session-c.json';
  // 基线时这一轮已经完成
  assert.strictEqual(dsh.snapshot(dshSession({ open: null, lastTurn: 9 }), { file, json: {}, cache }), null);
  // 之后缓存被重写：同一轮先显示为在途、再显示为闭合
  assert.strictEqual(dsh.snapshot(dshSession({ open: 300, lastTurn: 9 }), { file, json: {}, cache }), null);
  assert.strictEqual(dsh.snapshot(dshSession({ open: null, lastTurn: 9 }), { file, json: {}, cache }), null);
  // 真正的新一轮仍然要通知
  const d = dsh.snapshot(dshSession({ open: null, lastTurn: 10 }), { file, json: {}, cache });
  assert.ok(d && d.key.endsWith('#10'));
});

test('状态读 DSH 自己的字段：提问 / 计划 / 出错 / 暂停', () => {
  const stateOf = (rest) => {
    const cache = memCache();
    const file = 'session-d.json';
    dsh.snapshot(dshSession({ open: 1, lastTurn: 1 }), { file, json: {}, cache });
    const json = dshSession(Object.assign({ open: null, lastTurn: 2 }, rest));
    return dsh.snapshot(json, { file, json, cache });
  };

  const ask = stateOf({
    record: {
      identity: { cwd: '' },
      rows: {
        turnBoundary: { val: { openTurnStartSeq: null, lastTurn: 2 } },
        sessionStats: { val: { turns: 2 } },
        title: { val: 't' },
        userQuestions: { val: { questions: { active: [{ id: 'q1' }] } } },
      },
    },
  });
  assert.strictEqual(ask.state, 'ask');
  assert.strictEqual(ask.priority, 4);

  // plan 是「要你点一下头」，不是「要你给个答案」——所以是 approval 不是 ask。
  // 这条断言就是为「plan 到底算不算批准」这件事锁的：谁把 dsh.js 改回 ask，这里先红。
  const planning = stateOf({
    record: {
      identity: { cwd: '' },
      rows: {
        turnBoundary: { val: { openTurnStartSeq: null, lastTurn: 2 } },
        sessionStats: { val: { turns: 2 } },
        title: { val: 't' },
        plan: { val: { active: true } },
      },
    },
  });
  assert.strictEqual(planning.state, 'approval', '计划待审 = 等你批准，不是等你回答');
  assert.strictEqual(planning.kind, 'ask-approval');
  assert.strictEqual(planning.priority, 4, '阻塞态必须高优先级');

  const paused = stateOf({
    record: {
      identity: { cwd: '' },
      rows: {
        turnBoundary: { val: { openTurnStartSeq: null, lastTurn: 2 } },
        sessionStats: { val: { turns: 2 } },
        title: { val: 't' },
        goal: { val: { current: { id: 'g1' } } },
      },
    },
  });
  assert.strictEqual(paused.state, 'wait', '目标暂停 = 等待中，不是完成');

  const broken = stateOf({
    record: {
      identity: { cwd: '' },
      rows: {
        turnBoundary: { val: { openTurnStartSeq: null, lastTurn: 2 } },
        sessionStats: { val: { turns: 2 } },
        title: { val: 't' },
        goal: { val: { failure: 'boom' } },
      },
    },
  });
  assert.strictEqual(broken.state, 'error');
  assert.strictEqual(broken.priority, 5);
});

// --------------------- 通知格式契约（进程内，不 spawn —— 本环境唯一跑得动的形式）

group('通知格式契约 · 进程内复核');

/**
 * 对照基准是 **`logs/notify.log` 里真实发出过的正文**（逐字抄下来的）。
 *
 * 为什么单独有这个组：`tools/test.js` 的格式用例要 spawn 子进程，在本环境会被回收跑不动，
 * 于是"通知长什么样"这件事**一度没有任何能在本环境跑动的锁** —— 而改 `notice.js` 的
 * `STATES` 或改 `config.json` 的模板，恰恰会**静默改变每一条通知的样子**。加一个状态不该
 * 让已有的通知变样，这个组就是钉这件事的。
 */
test('WorkBuddy / Codex 的正文格式，与真实发出过的通知逐字一致', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const cases = [
    // 这两条是 logs/notify.log 里的原文，不是编出来的期望值
    ['WorkBuddy', '端到端验证', '端到端验证完成：这条通知是引擎真实发出来的。'],
    ['Codex', 'demo-app', '已经把 gitignore 检查完了，建议加 3 行忽略规则。'],
  ];
  for (const [agent, conversation, preview] of cases) {
    const r = notice.buildNotice({}, { agent, state: 'done', conversation, preview }, cfg);
    assert.strictEqual(r.title, '✅ 已完成', agent + ' 的标题变了');
    assert.strictEqual(
      r.body,
      `【${agent}】${conversation} · ${preview}`,
      agent + ' 的正文格式变了（基准是 logs/notify.log 里真实发出过的记录）',
    );
  }
});

test('新增 approval 之后，其余状态的渲染一个字都没动', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const titleOf = (state) =>
    notice.buildNotice({}, { agent: 'WorkBuddy', state, conversation: '端到端验证', preview: '做完了' }, cfg).title;
  assert.strictEqual(titleOf('done'), '✅ 已完成');
  assert.strictEqual(titleOf('ask'), '❓ 等你回答');
  assert.strictEqual(titleOf('error'), '⚠️ 出错了');
  assert.strictEqual(titleOf('wait'), '⏸️ 已暂停');
  // 新增的那一个，与 ask 共用 ❓ 但标签必须不同
  assert.strictEqual(titleOf('approval'), '❓ 等你批准');
  assert.notStrictEqual(titleOf('approval'), titleOf('ask'));
});

group('适配器契约');

test('validate 能挑出写坏的适配器', () => {
  assert.ok(agents.validate({ id: 'x' }).length >= 4);
  assert.deepStrictEqual(agents.validate(workbuddy), []);
  assert.deepStrictEqual(agents.validate(zcode), []);
  assert.deepStrictEqual(agents.validate(codex), []);
  assert.deepStrictEqual(agents.validate(dsh), []);
});

test('rewrite 型适配器要 snapshot、不要 turnEnd（反之亦然）', () => {
  const base = { id: 'x', label: 'X', dirs: ['/nope'], filePattern: /x/, mode: 'rewrite' };
  assert.ok(agents.validate(base).some((p) => /snapshot/.test(p)));
  assert.deepStrictEqual(agents.validate(Object.assign({}, base, { snapshot: () => null })), []);
  assert.ok(
    agents.validate(Object.assign({}, base, { snapshot: () => null, turnEnd: () => null })).some((p) =>
      /turnEnd/.test(p),
    ),
  );
  assert.ok(agents.validate({ id: 'x', label: 'X', dirs: ['/nope'], filePattern: /x/, mode: 'weird' }).length);
});

test('注册表里没有重复 id', () => {
  const ids = agents.list().map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.includes('testagent'), '环境变量注入的适配器应已注册');
  // WorkBuddy / ZCode 的旧独立监听器早已退役，适配器是唯一来源，必须常开。
  for (const id of ['workbuddy', 'zcode']) assert.ok(ids.includes(id), `缺少 ${id}`);
});

test('codex / dsh 必须同开同关（半开 = 一个发两遍、一个正常）', () => {
  const ids = agents.list().map((p) => p.id);
  assert.strictEqual(
    ids.includes('codex'),
    ids.includes('dsh'),
    '两个适配器是一次迁移的两个半截，必须一起启用或一起停用',
  );
});

test('适配器模块本身始终可加载、契约完整', () => {
  // These two were migrated out of tools/codex-watch.js and tools/dsh-watch.js. The
  // migration is DONE (both are registered — see the assertion above), and the standalone
  // watchers now refuse to start unless BAND_NOTIFY_LEGACY_WATCHER=1, so "two processes
  // reporting the same software" cannot happen. What this test adds is that the modules
  // stay loadable and well-formed, so the real-data regressions below always have
  // something to run against.
  assert.deepStrictEqual(agents.validate(codex), []);
  assert.deepStrictEqual(agents.validate(dsh), []);
  assert.strictEqual(codex.mode, 'append');
  assert.strictEqual(dsh.mode, 'rewrite');
});

// ------------------------------------------------------- real data (read-only)

function listFilesRec(dir, depth, matcher, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) listFilesRec(p, depth - 1, matcher, out);
    } else if (matcher.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

group('真实数据回归 · WorkBuddy（只读）');

test('每个带 message 字段的 assistant 消息后面绝不会跟工具调用', () => {
  const files = listFilesRec(workbuddy.dirs[0], 2, /\.jsonl$/i)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 120);
  if (!files.length) throw new Error('本机没有 WorkBuddy 会话文件，跳过（不算失败）');

  let checked = 0;
  let violated = 0;
  for (const { f } of files) {
    let events;
    try {
      events = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      continue; // a file being written right now
    }
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e.type !== 'message' || e.role !== 'assistant' || !e.message) continue;
      checked += 1;
      const next = events[i + 1];
      if (!next) continue;
      if (next.type === 'function_call' || next.type === 'function_call_result' || next.type === 'reasoning') {
        violated += 1;
      }
    }
  }
  assert.ok(checked > 20, `样本太少（${checked} 条），结论不可信`);
  assert.strictEqual(violated, 0, `有 ${violated}/${checked} 条带 message 的消息后面紧跟工具调用`);
  console.log(`      → 校验了 ${checked} 条真实轮次结束标记，全部符合`);
});

group('真实数据回归 · ZCode（只读）');

test('turn.completed 的数量与适配器判定数量一致', () => {
  const files = listFilesRec(zcode.dirs[0], 1, /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/);
  if (!files.length) throw new Error('本机没有 ZCode 日志，跳过（不算失败）');

  let expected = 0;
  let got = 0;
  let unexpected = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        continue;
      }
      const isEnd =
        (ev.event === 'turn.completed' || ev.event === 'turn.failed') && !/subagent/i.test(String(ev.sessionId || ''));
      if (isEnd) expected += 1;
      const d = zcode.turnEnd(ev, { file: f, cache: memCache() });
      if (d) got += 1;
      else if (isEnd) unexpected += 1;
    }
  }
  assert.strictEqual(got, expected, `判定 ${got} 条，实际结束事件 ${expected} 条`);
  assert.strictEqual(unexpected, 0);
  console.log(`      → 校验了 ${expected} 个真实轮次结束事件`);
});

/** First `bytes` of a file, without reading a 200 MB rollout into memory to do it. */
function readHead(file, bytes = 120000) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
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

group('真实数据回归 · Codex（只读）');

test('"会通知"的数量 == 按规则独立数出来的数量，且绝不来自子代理线程', () => {
  const files = listFilesRec(codex.dirs[0], 3, /^rollout-.*\.jsonl$/)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 60);
  if (!files.length) throw new Error('本机没有 Codex rollout，跳过（不算失败）');

  let expected = 0;
  let got = 0;
  let fromNonUser = 0;
  let bytes = 0;

  for (const { f } of files) {
    // Identity read straight from the first line — computed here, NOT via the adapter, so
    // a bug in the adapter's own metadata parsing cannot hide behind itself.
    let identity = {};
    try {
      identity = JSON.parse(readHead(f).split('\n')[0]).payload || {};
    } catch {
      continue;
    }
    const source = String(identity.thread_source || identity.source || '');
    const userThread = !identity.parent_thread_id && source === 'user';

    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    bytes += Buffer.byteLength(text, 'utf8');

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (ev.type !== 'event_msg') continue;
      const p = ev.payload || {};
      if (p.type !== 'task_complete') continue;

      const msg = String(p.last_agent_message || '').trim();
      const looksJson = msg.startsWith('{') && msg.endsWith('}');
      const hasError = p.error && typeof p.error === 'object';
      // The honest rule, in one line: the user's own thread, and either something broke
      // (worth knowing even with an empty message) or a real, non-machine reply.
      const announceable = userThread && (hasError || (Boolean(msg) && !looksJson));
      if (announceable) expected += 1;

      const d = codex.turnEnd(ev, { file: f, event: ev, cache: memCache() });
      if (d && !d.skip) {
        got += 1;
        if (!userThread) fromNonUser += 1;
      }
    }
  }

  assert.ok(expected > 5, `样本太少（${expected} 条），结论不可信`);
  assert.strictEqual(got, expected, `适配器判定 ${got} 条，独立数出 ${expected} 条`);
  assert.strictEqual(fromNonUser, 0, '有子代理/守护线程被当成用户轮次通知了');
  console.log(
    `      → 扫了 ${files.length} 个真实 rollout（${(bytes / 1048576).toFixed(0)}MB），会通知 ${expected} 轮`,
  );
});

test('「等你批准」判定数 == 日志里 approval 类 event_msg 数（可证伪等式）', () => {
  const files = listFilesRec(codex.dirs[0], 3, /^rollout-.*\.jsonl$/)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 45);
  if (!files.length) throw new Error('本机没有 Codex rollout，跳过（不算失败）');

  // 右边独立于适配器：取自官方 protocol.rs 里 EventMsg 的 snake_case tag。
  const APPROVAL = /^(exec_approval_request|apply_patch_approval_request|request_permissions|elicitation_request)$/;
  let expected = 0;
  let got = 0;
  let noise = 0;
  const cache = memCache();

  for (const { f } of files) {
    // 线程身份独立算一遍（不用适配器自己的 threadKind），否则适配器的过滤 bug 会自我掩护。
    let identity = {};
    try {
      identity = JSON.parse(readHead(f).split('\n')[0]).payload || {};
    } catch {
      continue;
    }
    const source = String(identity.thread_source || identity.source || '');
    const userThread = !identity.parent_thread_id && source === 'user';

    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type !== 'event_msg') continue;
      const type = String((ev.payload && ev.payload.type) || '');
      if (!APPROVAL.test(type)) continue;
      if (userThread) expected += 1;
      const d = codex.turnEnd(ev, { file: f, event: ev, cache });
      if (d && d.state === 'approval') {
        got += 1;
        if (!userThread) noise += 1;
      }
    }
  }

  assert.strictEqual(got, expected, `适配器判定 ${got} 条，日志里客观存在 ${expected} 条`);
  assert.strictEqual(noise, 0, '子代理/守护线程的审批请求被报出来了');
  console.log(
    expected === 0
      ? '      → 本机 0 次触发（approvals_reviewer=auto_review）：等式当前**无法证伪**，一旦出现即生效'
      : `      → 校验了 ${expected} 条真实审批请求`,
  );
});

test('Codex 的 event_msg 类型都在已知清单里（新类型可能就是「要你批准」）', () => {
  const files = listFilesRec(codex.dirs[0], 3, /^rollout-.*\.jsonl$/)
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 20);
  if (!files.length) throw new Error('本机没有 Codex rollout，跳过（不算失败）');

  const known = new Set([
    // 本机实测出现过（2026-10-09 普查：最近 45 个 rollout / 116MB）
    'item_completed',
    'token_count',
    'thread_settings_applied',
    'task_started',
    'task_complete',
    'turn_aborted',
    // 官方协议里「请求用户动作」的那几个，适配器已接 —— 本机目前仍是 0 次
    'exec_approval_request',
    'apply_patch_approval_request',
    'request_permissions',
    'elicitation_request',
  ]);
  const unknown = new Set();
  for (const { f } of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type !== 'event_msg') continue;
        const t = String((ev.payload && ev.payload.type) || '');
        if (t && !known.has(t)) unknown.add(t);
      } catch {
        /* 半行写入 */
      }
    }
  }
  assert.strictEqual(
    [...unknown].join(','),
    '',
    `出现未登记的 event_msg 类型 [${[...unknown].join(', ')}] —— 先判断它是不是「等你批准」类：是就加进 codex.js 的 APPROVAL_EVENTS，不是就登记为明确静默`,
  );
});

group('真实数据回归 · DSH（只读）');

test('第一次接触到每一个真实会话 → 一律不出声（历史不是新闻）', () => {
  const files = listFilesRec(dsh.dirs[0], 0, /^session-.*\.json$/);
  if (!files.length) throw new Error('本机没有 DSH 会话文件，跳过（不算失败）');

  let checked = 0;
  for (const f of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue; // being written right now
    }
    checked += 1;
    // A fresh cache per file: this is what the watcher looks like the first time it ever
    // sees the machine, and firing here would buzz about every conversation ever held.
    assert.strictEqual(
      dsh.snapshot(json, { file: f, json, cache: memCache() }),
      null,
      `${path.basename(f)} 首次接触就报了通知`,
    );
  }
  assert.ok(checked > 0, '一个会话都没读到');
  console.log(`      → 校验了 ${checked} 个真实会话，首次接触全部静默`);
});

test('同一份快照再喂一遍 → 仍然不出声（没变化就不是新闻）', () => {
  const f = listFilesRec(dsh.dirs[0], 0, /^session-.*\.json$/)[0];
  if (!f) throw new Error('本机没有 DSH 会话文件，跳过（不算失败）');
  const json = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  const cache = memCache();
  dsh.snapshot(json, { file: f, json, cache }); // 首次：静默
  assert.strictEqual(dsh.snapshot(json, { file: f, json, cache }), null, '静止的文件被当成了刚完成');
});

// --------------------------------- WorkBuddy 安全中心（第二个数据源：等你批准）

group('WorkBuddy 安全中心适配器 · 判定规则（等你批准）');

/**
 * 真实样本，2026-10-09 取自本机 `~/.workbuddy/audit-log` —— 就是用户报「弹窗了但没通知」
 * 的那一次。**内联而不是现场读文件**：这几个形状是判据的输入契约，而当天 16:03 那条
 * 一度既不在 spool（被归档清空）也不在日文件（还没归档完），现场读会时有时无。
 */
const approvalSample = (over) =>
  Object.assign(
    {
      sessionId: '530c5c8b-4c2c-4428-b295-58be761c6615',
      requestId: '01a11fadf7317d70ba829bda8808eacf',
      toolCallId: 'call_00_Ty6Y9S4risJvXYgsmXkY1575',
      category: 'network',
      eventType: 'network.ask-matched',
      decision: 'info',
      messageKey: 'securityCenter.audit.network.askMatched',
      messageParams: { target: 'www.chinamoney.com.cn' },
      timestamp: 1791533023004,
    },
    over || {},
  );

test('network.ask-matched（decision=info）= ❓ 等你批准，正文带目标域名', () => {
  const d = workbuddyApproval.turnEnd(approvalSample(), { file: 'x', cache: memCache() });
  assert.ok(d, '应判定为等你批准');
  assert.strictEqual(d.state, 'approval');
  assert.strictEqual(d.kind, 'ask-approval');
  assert.strictEqual(d.priority, 4, '阻塞态必须高优先级');
  assert.strictEqual(d.text, '访问 www.chinamoney.com.cn');
  assert.strictEqual(
    d.key,
    'approval:01a11fadf7317d70ba829bda8808eacf:call_00_Ty6Y9S4risJvXYgsmXkY1575:network.ask-matched',
  );
  assert.ok(d.conversation, '会话名不能为空，否则通知会退到监听进程自己的工作目录名');
});

test('file-safety.bulk-delete.needs-approval = ❓ 等你批准，正文说清删什么', () => {
  const d = workbuddyApproval.turnEnd(
    approvalSample({
      category: 'file-safety',
      eventType: 'file-safety.bulk-delete.needs-approval',
      messageParams: { command: 'rm -rf tmp_douyin', count: 85, threshold: 50, targets: 'D:/Fin-Learn/tmp_douyin' },
    }),
    { file: 'x', cache: memCache() },
  );
  assert.ok(d);
  assert.strictEqual(d.state, 'approval');
  assert.strictEqual(d.text, '批量删除 85 个文件（tmp_douyin）');
});

// 下面两条都是**可证伪等式抓出来的漏报**（适配器起初没列它们，2026-10-09）。
// 真实样本来自 2026-07-16 与 2026-09-14 的历史审计日志。
test('file-safety.needs-approval（碰敏感文件）= ❓ 等你批准，指出敏感文件', () => {
  const d = workbuddyApproval.turnEnd(
    approvalSample({
      category: 'file-safety',
      eventType: 'file-safety.needs-approval',
      messageParams: {
        paths: 'C:\\Users\\example-user\\.ssh\\config, C:\\Users\\example-user\\.ssh\\id_rsa, C:\\Users\\example-user\\.ssh\\known_hosts',
      },
    }),
    { file: 'x', cache: memCache() },
  );
  assert.ok(d, '触碰敏感路径必须报 —— 曾经漏过 3 次');
  assert.strictEqual(d.state, 'approval');
  assert.strictEqual(d.text, '访问敏感文件 .ssh/config 等 3 个');
});

test('sensitive-protection.detected（正文含敏感信息）= ❓ 等你批准放行', () => {
  const d = workbuddyApproval.turnEnd(
    approvalSample({
      category: 'sensitive-protection',
      eventType: 'sensitive-protection.detected',
      messageParams: {
        source: 'model-request',
        direction: 'ingress',
        itemCount: 1,
        contentPreview: '1****6',
        ruleCount: 1,
      },
    }),
    { file: 'x', cache: memCache() },
  );
  assert.ok(d);
  assert.strictEqual(d.state, 'approval');
  assert.strictEqual(d.text, '正文含 1 处敏感信息，待放行');
});

test('「你已经决定了」不报：*.approved 一律静默', () => {
  for (const eventType of ['network.approved', 'file-safety.bulk-delete.approved']) {
    assert.strictEqual(
      workbuddyApproval.turnEnd(approvalSample({ eventType, decision: 'approved' }), { file: 'x', cache: memCache() }),
      null,
      `${eventType} 不该通知（你已经点过了）`,
    );
  }
});

test('正常放行不报：sandbox-executed / allow-listed 一律静默（否则一小时几十条）', () => {
  for (const eventType of ['command-safety.sandbox-executed', 'file-safety.allow-listed']) {
    assert.strictEqual(
      workbuddyApproval.turnEnd(approvalSample({ eventType, decision: 'allowed' }), { file: 'x', cache: memCache() }),
      null,
      `${eventType} 不该通知`,
    );
  }
});

test('拦死且不可批准的不报：program-blacklist-blocked 是模型自己的事', () => {
  assert.strictEqual(
    workbuddyApproval.turnEnd(
      approvalSample({ eventType: 'command-safety.program-blacklist-blocked', decision: 'blocked' }),
      { file: 'x', cache: memCache() },
    ),
    null,
  );
});

test('名字像「在问」但 decision 不是 info → 不报（信 decision 字段，不信名字）', () => {
  assert.strictEqual(
    workbuddyApproval.turnEnd(approvalSample({ decision: 'approved' }), { file: 'x', cache: memCache() }),
    null,
    'network.ask-matched + decision=approved 说明已经问过并决定了',
  );
});

test('同一次询问喂两遍 → 去重键相同（发送闸门是引擎的 claim）', () => {
  const a = workbuddyApproval.turnEnd(approvalSample(), { file: 'x', cache: memCache() });
  const b = workbuddyApproval.turnEnd(approvalSample(), { file: 'y', cache: memCache() });
  assert.strictEqual(a.key, b.key, '换了文件也必须同一把键，否则同一次弹窗会发两遍');
});

// ------------------------------- ZCode / MiMo（引擎 SQLite 里的 permission 表 = 等你批准）

group('ZCode / MiMo 适配器 · 等你批准（引擎 SQLite 的 permission 表）');

/**
 * 这两个适配器的**真实**库在本机都是 0 行 —— 结构确证、真机 0 次触发（与 Codex 的审批
 * 分支同病）。所以判定规则只能用**合成的**库来锁：自己建一张 `permission` 表、插一行、
 * 看适配器报不报。
 *
 * ⚠️ 它锁的是「输入契约 → 输出」这段**代码路径**，不是上游语义。上游语义的依据在程序
 * 本体里（ZCode 的 `app.asar` 有 `permission.requested` 与 `permission.lifecycle` 的 zod
 * schema；MiMo 的 `mimo.exe` 有 `permission.asked` / `allowOnce` / `allowAlways` / `deny`），
 * 见两个适配器文件的头部。真机第一次出现待批准请求时，`--status` 的 diagnose 会打印
 * `data` 的原始键名 —— 那时才能用真实数据把字段映射收紧。
 */
function sqliteOrNull() {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

test('permission 表里出现一行 → 报「等你批准」（合成库，锁输入契约）', () => {
  const sqlite = sqliteOrNull();
  if (!sqlite) {
    console.log('      → node:sqlite 不可用（需要 Node 22+），跳过');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-perm-'));
  const dbPath = path.join(dir, 'mimocode.db');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE permission (project_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
  );

  // 走共享的判定本体，不手抄任何逻辑
  const adapter = opencodePerms.createAdapter({
    id: 'test-perm',
    label: 'TestPerm',
    dbPath,
    envVar: 'BAND_NOTIFY_TEST_PERM_DB',
    dbFileName: 'mimocode.db',
  });

  const cache = memCache();
  try {
    // 1) 空表 → 静默（首见即 baseline，历史不是新闻）
    assert.strictEqual(adapter.snapshot(null, { file: dbPath, cache }), null, '空表不该出声');

    // 2) 插一行 → 报且只报一条
    db.prepare('INSERT INTO permission VALUES (?,?,?,?)').run(
      'proj',
      1000,
      1000,
      JSON.stringify({
        requestId: 'req-1',
        toolCallId: 'call-1',
        toolName: 'bash',
        reason: '删除构建产物',
        riskLevel: 'high',
        sessionID: 'sess-aabbccdd-eeff',
      }),
    );
    const descs = adapter.snapshot(null, { file: dbPath, cache });
    assert.ok(descs && descs.length === 1, 'permission 表里有行却没报');
    const d = descs[0];
    assert.strictEqual(d.state, 'approval');
    assert.strictEqual(d.kind, 'ask-approval');
    assert.strictEqual(d.priority, 4, '阻塞态必须高优先级');
    assert.strictEqual(d.key, 'approval:req-1', '优先用 requestId 当身份');
    assert.strictEqual(d.text, '删除构建产物', '正文应取 reason');
    assert.strictEqual(d.conversation, 'sess', '没有对话名时用会话短片段，而不是监听器自己的工作目录');

    // 3) 什么都不变再喂一遍 → 静默（不是每一轮都重报）
    assert.strictEqual(adapter.snapshot(null, { file: dbPath, cache }), null, '同一行被重复报');

    // 4) 换一行 → 只报新的那一行，且键名回落链生效
    db.prepare('DELETE FROM permission').run();
    db.prepare('INSERT INTO permission VALUES (?,?,?,?)').run(
      'proj',
      2000,
      2000,
      JSON.stringify({ callID: 'call-9', tool: 'edit', description: '改写配置文件' }),
    );
    const more = adapter.snapshot(null, { file: dbPath, cache });
    assert.ok(more && more.length === 1, '新出现的请求没被报');
    assert.strictEqual(more[0].key, 'approval:call-9', '没有 requestId 时退到 callID');
    assert.strictEqual(more[0].text, '改写配置文件', '没有 reason 时用 description');

    // 5) 字段一个都不认识 → 正文兜底，绝不为空（宽容读取的意义就在这里）
    db.prepare('DELETE FROM permission').run();
    db.prepare('INSERT INTO permission VALUES (?,?,?,?)').run('proj', 3000, 3000, JSON.stringify({ mystery: 1 }));
    const fallback = adapter.snapshot(null, { file: dbPath, cache });
    assert.ok(fallback && fallback.length === 1, '认不出字段就整个不报，等于静默失败');
    assert.ok(fallback[0].text.length > 0, '认不出字段时正文不能是空字符串');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('库读不到（不存在 / 打不开）→ 静默，不抛错', () => {
  if (!sqliteOrNull()) return;
  const adapter = opencodePerms.createAdapter({
    id: 'test-perm-missing',
    label: 'TestPerm',
    dbPath: path.join(os.tmpdir(), 'bn-does-not-exist-' + Date.now(), 'nothing.db'),
    envVar: 'BAND_NOTIFY_TEST_PERM_MISSING',
    dbFileName: 'nothing.db',
  });
  const cache = memCache();
  adapter.snapshot(null, { file: 'x', cache }); // 首见
  assert.strictEqual(adapter.snapshot(null, { file: 'x', cache }), null, '读不到库却报了通知');
});

test('两个薄适配器的配置接对了（路径 / 表名 / selfRead）', () => {
  const cases = [
    [zcodeApproval, { id: 'zcode-approval', label: 'ZCode', dbFile: 'db.sqlite' }],
    [mimo, { id: 'mimo', label: 'MiMo', dbFile: 'mimocode.db' }],
  ];
  for (const [profile, want] of cases) {
    assert.strictEqual(profile.id, want.id);
    assert.strictEqual(profile.label, want.label);
    assert.strictEqual(profile.mode, 'rewrite');
    // 不声明 selfRead，引擎的 JSON.parse 对 SQLite 每一次轮询都会失败 → 适配器永远不被调用。
    // 那正是"注册表里有、实际永不发声"，所以这一条必须钉死。
    assert.strictEqual(profile.selfRead, true, profile.id + ' 必须声明 selfRead');
    assert.ok(profile.filePattern.test(want.dbFile), want.dbFile + ' 没被 filePattern 匹配');
    // 反向：SQLite 的伴生文件不能被当成独立数据源（否则同一份数据被读两遍）
    assert.ok(!profile.filePattern.test(want.dbFile + '-wal'), '别匹配 -wal');
    assert.ok(!profile.filePattern.test(want.dbFile + '-shm'), '别匹配 -shm');
    assert.deepStrictEqual(agents.validate(profile), [], profile.id + ' 校验不通过');
  }
});

group('MiMo 适配器 · 轮次结束（message 表的 finish 字段）');

/**
 * MiMo 的「轮次结束」判据是 assistant 消息的 `data.finish`：
 *   "stop" → 这一轮结束；"tool-calls" → 轮次还没完；(缺失) + error → 这一轮失败。
 *
 * 依据取自**本机真实库**（5 会话 / 129 消息 / 556 片段）：
 *   tool-calls **96**、stop **14**、缺 finish **1**（那条正是 `APIError 403 未开通会员`）。
 *
 * 这里用合成库锁「输入契约 → 输出」，并**反过来**锁死两个"看着能用、其实不能用"的字段：
 *   · `time.completed` —— 96 条 tool-calls 也都有；用它会把 1 轮报成 N 条（110 : 14）
 *   · `actor_registry` —— turn_count 与真实 stop 数对不上，且 5 行 last_outcome 全是 failure
 */
function makeMimoTurnDb(dir) {
  const sqlite = sqliteOrNull();
  const dbPath = path.join(dir, 'mimocode.db');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('CREATE TABLE session (id TEXT, parent_id TEXT, title TEXT)');
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');
  // 列与真实库一致（真实 `part` 自带 `session_id`；少一列会让"等你回答"那条查询直接报错）
  db.exec(
    'CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
  );
  db.exec('CREATE TABLE permission (project_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  return { db, dbPath };
}

function addMsg(db, id, session, data, t) {
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, session, t, JSON.stringify(data));
}

function addTextPart(db, messageId, text, t, session = 'ses_main') {
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
    `p-${messageId}`,
    messageId,
    session,
    t,
    t,
    JSON.stringify({ type: 'text', text }),
  );
}

/** 一条 `part` 原始行。字段照抄真实库（真实 `part` 自带 `session_id`）。 */
function addRawPart(db, id, messageId, session, data, t) {
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
    id,
    messageId,
    session,
    t,
    t,
    JSON.stringify(data),
  );
}

/** MiMo 的「向用户提问」工具 —— 本机真实调用过 13 次的那个。 */
const QUESTION_PART = (callId, status, questions) => ({
  type: 'tool',
  tool: 'question',
  callID: callId,
  state: {
    status,
    input: {
      questions: questions || [{ question: '你同意这个方案吗？', header: '方案确认', options: [] }],
    },
  },
});

/** bash 工具；`interactive:true` = 引擎文档里"要用户输入（密码 / y/N / SSH passphrase）"。 */
const BASH_PART = (callId, status, interactive) => ({
  type: 'tool',
  tool: 'bash',
  callID: callId,
  state: { status, input: { command: 'ssh-add ~/.ssh/id_rsa', interactive } },
});

const ASSISTANT = (finish, extra = {}) => ({
  role: 'assistant',
  finish,
  time: { created: 1, completed: 2 },
  ...extra,
});

/** 载入一份指向合成库的 mimo 适配器（模块在加载时读 env，所以要清 require 缓存）。 */
function loadMimoAt(dbPath) {
  const modulePath = require.resolve('../src/agents/mimo.js');
  const previous = require.cache[modulePath];
  const prevEnv = process.env.BAND_NOTIFY_MIMO_DB;
  process.env.BAND_NOTIFY_MIMO_DB = dbPath;
  delete require.cache[modulePath];
  let fresh;
  try {
    fresh = require('../src/agents/mimo.js');
  } finally {
    if (prevEnv === undefined) delete process.env.BAND_NOTIFY_MIMO_DB;
    else process.env.BAND_NOTIFY_MIMO_DB = prevEnv;
    if (previous) require.cache[modulePath] = previous; // 别影响后面的测试
  }
  return fresh;
}

test('classifyMessage：只有 stop 算结束；tool-calls 不算；无 finish + error 算失败', () => {
  const { classifyMessage } = opencodePerms;
  assert.strictEqual(classifyMessage({ role: 'assistant', finish: 'stop' }), 'done');
  assert.strictEqual(classifyMessage({ role: 'assistant', finish: 'tool-calls' }), null, 'tool-calls 是轮次中途');
  assert.strictEqual(classifyMessage({ role: 'assistant', error: { name: 'APIError' } }), 'error');
  assert.strictEqual(classifyMessage({ role: 'assistant' }), null, '没有 finish 也没有 error = 还在写');
  assert.strictEqual(classifyMessage({ role: 'user', finish: 'stop' }), null, 'user 消息不是轮次边界');
  assert.strictEqual(classifyMessage(null), null);
  // 语义要明确：万一将来 finish 与 error 同时出现，以"轮次已结束"为准
  assert.strictEqual(classifyMessage({ role: 'assistant', finish: 'stop', error: { name: 'X' } }), 'done');
});

test('readTurnEnds：取 stop / error、忽略 tool-calls、带上 session.title 与子会话标记', () => {
  if (!sqliteOrNull()) {
    console.log('      → node:sqlite 不可用（需要 Node 22+），跳过');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-read-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_main', null, '排查统计偏差');
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_child', 'ses_main', '子代理会话');

    addMsg(db, 'm-tool', 'ses_main', ASSISTANT('tool-calls'), 10); // 轮次中途，不算
    addMsg(db, 'm-stop', 'ses_main', ASSISTANT('stop'), 20);
    addMsg(db, 'm-err', 'ses_main', ASSISTANT(undefined, { error: { name: 'APIError', data: { message: '未开通会员' } } }), 30);
    addMsg(db, 'm-child', 'ses_child', ASSISTANT('stop'), 40);
    addMsg(db, 'm-user', 'ses_main', { role: 'user' }, 50);

    const { ok, rows } = opencodePerms.readTurnEnds(dbPath);
    assert.ok(ok, '合成库读失败');
    const ids = rows.map((r) => `${r.id}:${r.kind}`).sort();
    assert.deepStrictEqual(
      ids,
      ['m-child:done', 'm-err:error', 'm-stop:done'],
      'tool-calls / user 不该出现在轮次边界里',
    );

    const stop = rows.find((r) => r.id === 'm-stop');
    assert.strictEqual(stop.title, '排查统计偏差', '对话名应取 session.title');
    assert.strictEqual(stop.parent, '', '顶层会话没有 parent');

    const child = rows.find((r) => r.id === 'm-child');
    assert.strictEqual(child.parent, 'ses_main', '子会话必须带上 parent，供适配器 skip');

    const err = rows.find((r) => r.id === 'm-err');
    assert.strictEqual(err.errorText, '未开通会员', '失败原因应取 error.data.message');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readTexts：正文 = 该消息所有 text 片段拼接（不带 tool/reasoning）', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-text-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    addTextPart(db, 'm1', '第一段。', 1);
    addRawPart(db, 'p-tool', 'm1', 'ses_main', { type: 'tool', tool: 'bash' }, 2);
    addTextPart(db, 'm1', '  第二段。  ', 3);
    addRawPart(db, 'p-empty', 'm1', 'ses_main', { type: 'text', text: '   ' }, 4);

    const map = opencodePerms.readTexts(dbPath, ['m1', 'nope']);
    assert.strictEqual(map.get('m1'), '第一段。 第二段。', '应拼接非空 text 片段并归一空白');
    assert.strictEqual(map.get('nope'), '', '不存在的消息给空串，不给 undefined');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimo 本体：首见即基线，之后新 stop 才报（正文/对话名/状态/优先级）', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-live-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_a', null, '排查统计偏差');
    addMsg(db, 'm-hist', 'ses_a', ASSISTANT('stop'), 100);
    addTextPart(db, 'm-hist', '历史回复（首见时必须当成基线，不能重播）', 101);

    const adapter = loadMimoAt(dbPath);
    const cache = memCache();

    // ① 首见：历史里那条 stop 不该被报出来
    assert.strictEqual(
      adapter.snapshot(null, { file: dbPath, size: 0, cache }),
      null,
      '首见就把历史轮次重播了',
    );

    // ② 轮次中途（tool-calls）不该报
    addMsg(db, 'm-tool', 'ses_a', ASSISTANT('tool-calls'), 200);
    assert.strictEqual(
      adapter.snapshot(null, { file: dbPath, size: 0, cache }),
      null,
      'tool-calls（轮次中途）被当成结束了 —— time.completed 就是这个坑',
    );

    // ③ 新来的 finish=stop → 报一条「已完成」
    addMsg(db, 'm-new', 'ses_a', ASSISTANT('stop'), 300);
    addTextPart(db, 'm-new', '复核做完了，结论是没有算错。', 301);
    const descs = adapter.snapshot(null, { file: dbPath, size: 0, cache });
    assert.ok(descs && descs.length === 1, `新轮次该报 1 条，实际 ${descs && descs.length}`);
    const d = descs[0];
    assert.strictEqual(d.state, 'done');
    assert.strictEqual(d.kind, 'turn-end');
    assert.strictEqual(d.priority, 0);
    assert.strictEqual(d.key, 'turn:m-new');
    assert.strictEqual(d.text, '复核做完了，结论是没有算错。');
    assert.strictEqual(d.conversation, '排查统计偏差', '对话名要取 session.title');

    // ④ 不再变化 → 静默（不是每轮重报）
    assert.strictEqual(adapter.snapshot(null, { file: dbPath, size: 0, cache }), null, '同一轮被重报');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimo 本体：无 finish + error → ⚠️ 出错了（优先级 5），正文取失败原因', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-err-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_e', null, '费用怎么算');
    const adapter = loadMimoAt(dbPath);
    const cache = memCache();
    adapter.snapshot(null, { file: dbPath, size: 0, cache }); // 基线

    addMsg(db, 'm-fail', 'ses_e', ASSISTANT(undefined, {
      error: { name: 'APIError', data: { message: '未开通会员或会员已到期，请订阅后使用', statusCode: 403 } },
    }), 400);
    const descs = adapter.snapshot(null, { file: dbPath, size: 0, cache });
    assert.ok(descs && descs.length === 1, '失败轮次没报');
    assert.strictEqual(descs[0].state, 'error');
    assert.strictEqual(descs[0].priority, 5, '出错必须是最高优先级');
    assert.strictEqual(descs[0].text, '未开通会员或会员已到期，请订阅后使用');

    // 认不出错误字段时也不能出现空正文
    addMsg(db, 'm-fail2', 'ses_e', ASSISTANT(undefined, { error: { name: 'Weird' } }), 500);
    const again = adapter.snapshot(null, { file: dbPath, size: 0, cache });
    assert.ok(again && again.length === 1, '第二个失败轮次没报');
    assert.ok(again[0].text.length > 0, '正文兜底句缺失');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimo 本体：子会话（parent_id 非空）→ skip 且带原因，不发通知', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-child-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_root', null, '主会话');
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_kid', 'ses_root', '子代理');
    const adapter = loadMimoAt(dbPath);
    const cache = memCache();
    adapter.snapshot(null, { file: dbPath, size: 0, cache }); // 基线

    addMsg(db, 'm-kid', 'ses_kid', ASSISTANT('stop'), 600);
    const descs = adapter.snapshot(null, { file: dbPath, size: 0, cache });
    assert.ok(descs && descs.length === 1, '子会话轮次应产生一条 skip 记录');
    assert.ok(descs[0].skip, 'skip 标志必须有，否则引擎会把它当通知发出去');
    assert.ok(/子会话/.test(descs[0].skip), 'skip 理由要看得懂');
    assert.strictEqual(descs[0].state, undefined, 'skip 项不该带 state');

    // skip 也要记账：再来一轮不能重复刷日志
    assert.strictEqual(adapter.snapshot(null, { file: dbPath, size: 0, cache }), null, 'skip 项被反复重报');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 重启回归：缓存经 JSON 往返后仍能工作（锁死 Map → "{}" 那个缺陷）', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-restart-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_r', null, '重启测试');
    addMsg(db, 'm-old', 'ses_r', ASSISTANT('stop'), 700);

    // 需要一个**能看到底层 store** 的缓存，才能真的做一次 JSON 往返（memCache 看不到）。
    const makeJsonCache = (store = {}) => ({
      get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined),
      set: (k, v) => {
        store[k] = v;
      },
      store,
    });

    const adapter = loadMimoAt(dbPath);
    const c1 = makeJsonCache();
    assert.strictEqual(adapter.snapshot(null, { file: dbPath, size: 0, cache: c1 }), null, '首见应静默');

    // ① 先钉死**落盘形态**：必须是 JSON 数组。
    //    （原来是 Map，`JSON.stringify(new Map())` === "{}" —— 重启后读回一个真值空对象，
    //      `prev.has()` 抛 TypeError，适配器此后每轮都异常且永远不发声。）
    const persisted = JSON.parse(JSON.stringify(c1.store));
    assert.ok(
      Array.isArray(persisted.turns),
      `缓存里的 turns 必须是 JSON 数组，实际 ${typeof persisted.turns}：落盘成 {} 就等于重启即失效`,
    );
    assert.ok(
      Array.isArray(persisted.pending),
      `缓存里的 pending 必须是 JSON 数组，实际 ${typeof persisted.pending}`,
    );
    assert.ok(persisted.turns.includes('turn:m-old'), '基线键没有真的落盘');

    // ② 模拟重启：用**磁盘上那份**继续跑，必须不抛错、也不重播
    const c2 = makeJsonCache(persisted);
    let descs;
    assert.doesNotThrow(() => {
      descs = adapter.snapshot(null, { file: dbPath, size: 0, cache: c2 });
    }, '重启后抛错了 —— 缓存必须是 JSON 安全的');
    assert.strictEqual(descs, null, '重启后把历史轮次重播了');

    // ③ 重启后仍能报新轮次
    addMsg(db, 'm-after', 'ses_r', ASSISTANT('stop'), 800);
    addTextPart(db, 'm-after', '重启之后的新回复', 801);
    const after = adapter.snapshot(null, { file: dbPath, size: 0, cache: c2 });
    assert.ok(after && after.length === 1, `重启后新轮次不报了（实际 ${after && after.length}）`);
    assert.strictEqual(after[0].key, 'turn:m-after');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimo：审批与轮次同库并存时互不掩盖（一次快照能同时产出两类）', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-both-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_b', null, '两件事一起来');
    const adapter = loadMimoAt(dbPath);
    const cache = memCache();
    adapter.snapshot(null, { file: dbPath, size: 0, cache }); // 基线

    addMsg(db, 'm-both', 'ses_b', ASSISTANT('stop'), 900);
    addTextPart(db, 'm-both', '干完了。', 901);
    db.prepare('INSERT INTO permission VALUES (?,?,?,?)').run(
      'proj',
      1,
      1,
      JSON.stringify({ requestId: 'req-both', toolName: 'bash', reason: '删除构建产物' }),
    );

    const descs = adapter.snapshot(null, { file: dbPath, size: 0, cache });
    assert.ok(descs && descs.length === 2, `应同时报 2 条，实际 ${descs && descs.length}`);
    const states = descs.map((d) => d.state).sort();
    assert.deepStrictEqual(states, ['approval', 'done'], '两类信号没能并存');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('不变量锁：TURN_CAP >= TURN_WINDOW（"记住的"必须 ⊇ "读数器还能返回的"）', () => {
  assert.ok(
    opencodePerms.TURN_CAP >= opencodePerms.TURN_WINDOW,
    `TURN_CAP(${opencodePerms.TURN_CAP}) < TURN_WINDOW(${opencodePerms.TURN_WINDOW})：` +
      '窗口里落榜的旧轮次会在下一轮"变成新的"重播 —— 而它们**从不经过 claim()**，' +
      '去重集拦不住。2026-10-09 红队实测：450 条边界 → 第二次轮询误发 50 条。',
  );
});

test('mimo：窗口被边界填满时不许重播（曾因 TURN_CAP<TURN_WINDOW 误发一批）', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-cap-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_cap', null, '窗口塞满');
    // 正好塞满读数窗口。旧代码 TURN_CAP=400 会把多出来的那批在第二次轮询里全发出去。
    const N = opencodePerms.TURN_WINDOW;
    for (let i = 0; i < N; i += 1) {
      addMsg(db, `m-${String(i).padStart(4, '0')}`, 'ses_cap', ASSISTANT('stop'), 1000 + i);
    }

    const adapter = loadMimoAt(dbPath);
    const cache = memCache();

    // ① 首见：全是历史 → 一条都不许发
    assert.strictEqual(
      adapter.snapshot(null, { file: dbPath, size: 0, cache }),
      null,
      '首见就把历史轮次发出来了',
    );

    // ② 内容没变 → 必须仍然一条都不发。**这是本测试的回归点。**
    assert.strictEqual(
      adapter.snapshot(null, { file: dbPath, size: 0, cache }),
      null,
      '第二次轮询重播了历史轮次 —— 基线被截断，落榜的旧轮次"变成新的"了',
    );

    // ③ 真的来一条新的 → 只发这一条（修复不能把正常路径一起堵死）
    addMsg(db, 'm-brand-new', 'ses_cap', ASSISTANT('stop'), 9000);
    addTextPart(db, 'm-brand-new', '这条才是真新', 9001);
    const descs = adapter.snapshot(null, { file: dbPath, size: 0, cache });
    assert.ok(descs && descs.length === 1, `新轮次该只发 1 条，实际 ${descs && descs.length}`);
    assert.strictEqual(descs[0].key, 'turn:m-brand-new');
    assert.strictEqual(descs[0].text, '这条才是真新');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyToolPart：只有 running 才算"在等"；pending 是还没轮到，completed/error 是已结束', () => {
  const { classifyToolPart } = opencodePerms;
  assert.strictEqual(classifyToolPart(QUESTION_PART('c', 'running')), 'question');
  assert.strictEqual(classifyToolPart(QUESTION_PART('c', 'pending')), null, 'pending 报了就太早');
  assert.strictEqual(classifyToolPart(QUESTION_PART('c', 'completed')), null);
  assert.strictEqual(classifyToolPart(QUESTION_PART('c', 'error')), null);
  assert.strictEqual(classifyToolPart(BASH_PART('c', 'running', true)), 'interactive');
  assert.strictEqual(
    classifyToolPart(BASH_PART('c', 'running', false)),
    null,
    '普通 bash 不能报 —— 否则每跑一条命令都响一次（那正是 time.completed 那种通知风暴）',
  );
  assert.strictEqual(classifyToolPart(BASH_PART('c', 'running', undefined)), null);
  assert.strictEqual(classifyToolPart({ type: 'text', text: 'x' }), null, 'text 片段不是工具调用');
  assert.strictEqual(classifyToolPart(null), null);
});

test('askText：多问题标总数；取不到文字时有兜底句（正文绝不为空）', () => {
  const { askText } = opencodePerms;
  assert.match(askText(QUESTION_PART('c', 'running'), 'question'), /你同意这个方案吗？/);
  const multi = QUESTION_PART('c', 'running', [
    { question: '第一个问题？' },
    { question: '第二个问题？' },
  ]);
  assert.match(askText(multi, 'question'), /共 2 个问题/, '多个问题必须让用户知道有几条');
  const empty = askText({ type: 'tool', tool: 'question', state: { status: 'running', input: {} } }, 'question');
  assert.ok(empty && empty.length > 0, '正文空了 —— 通知会变成一条没有内容的提醒');
  assert.match(askText(BASH_PART('c', 'running', true), 'interactive'), /ssh-add/);
});

test('readPendingAsks：能读到 running 的提问；坏 JSON 不会让整条查询崩（json_valid 守卫）', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-asks-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_x', null, '守卫会话');
    addRawPart(db, 'p-ok', 'm1', 'ses_x', QUESTION_PART('call_ok', 'running'), 10);
    addRawPart(db, 'p-done', 'm1', 'ses_x', QUESTION_PART('call_done', 'completed'), 20);
    addRawPart(db, 'p-pend', 'm1', 'ses_x', QUESTION_PART('call_pend', 'pending'), 30);
    // 半截写入的坏 JSON：没有 json_valid 守卫的话，json_extract 会直接抛错 →
    // 整条查询失败 → 适配器静默（本项目最怕的那种死法）。
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
      'p-bad', 'm1', 'ses_x', 40, 40, '{"type":"tool","state":{ 这不是 JSON',
    );

    const r = opencodePerms.readPendingAsks(dbPath);
    assert.strictEqual(r.ok, true, `查询不该整条失败：${r.reason}`);
    assert.strictEqual(r.rows.length, 1, `只该读到那 1 条 running 的，实际 ${r.rows.length}`);
    assert.strictEqual(r.rows[0].callId, 'call_ok');
    assert.strictEqual(r.rows[0].title, '守卫会话');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimo 本体：question 卡在 running → ❓ 等你回答；答完不再报；新问题再报', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-ask-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_q', null, '问我要不要开做');
    const adapter = loadMimoAt(dbPath);
    const cache = memCache();

    // ① 已经答完的（completed）是历史 → 不报
    addRawPart(db, 'p-done', 'm-q', 'ses_q', QUESTION_PART('call_done', 'completed'), 10);
    assert.strictEqual(
      adapter.snapshot(null, { file: dbPath, size: 0, cache }),
      null,
      '已答完的提问被当成待答了',
    );

    // ② 出现一个正在等你的 → 必须报，状态是 ask（走 ❓ 通道，与 WorkBuddy 同类）
    addRawPart(db, 'p-run', 'm-q', 'ses_q', QUESTION_PART('call_run', 'running'), 20);
    const d1 = adapter.snapshot(null, { file: dbPath, size: 0, cache });
    assert.ok(d1 && d1.length === 1, `应报 1 条，实际 ${d1 && d1.length}`);
    assert.strictEqual(d1[0].state, 'ask');
    assert.strictEqual(d1[0].kind, 'ask-question');
    assert.strictEqual(d1[0].key, 'ask:call_run');
    assert.strictEqual(d1[0].priority, 4);
    assert.strictEqual(d1[0].conversation, '问我要不要开做', '对话名要取 session.title');
    assert.match(d1[0].text, /你同意这个方案吗？/);

    // ③ 没变化 → 不许每轮重报（这条以前用日志刷屏的方式暴露过）
    assert.strictEqual(
      adapter.snapshot(null, { file: dbPath, size: 0, cache }),
      null,
      '同一个提问被每轮重报',
    );

    // ④ 用户答完了（状态推进到 completed）→ 不再出现
    db.prepare('UPDATE part SET data=? WHERE id=?').run(
      JSON.stringify(QUESTION_PART('call_run', 'completed')),
      'p-run',
    );
    assert.strictEqual(
      adapter.snapshot(null, { file: dbPath, size: 0, cache }),
      null,
      '答完了还在报',
    );

    // ⑤ 又来一个新提问（callID 不同）→ 必须再报
    addRawPart(db, 'p-run2', 'm-q', 'ses_q', QUESTION_PART('call_run2', 'running'), 30);
    const d2 = adapter.snapshot(null, { file: dbPath, size: 0, cache });
    assert.ok(d2 && d2.length === 1 && d2[0].key === 'ask:call_run2', '新提问没报出来');
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimo：首见就有"正在等你回答"时必须报（不建基线 —— 与"等你批准"故意不同）', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-ask-first-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_f', null, '停机期间被问');
    // 提问发生在监听进程还没起来的时候（例如停机 / 刚双击启动）
    addRawPart(db, 'p-f', 'm-f', 'ses_f', QUESTION_PART('call_f', 'running'), 10);

    const adapter = loadMimoAt(dbPath);
    const d = adapter.snapshot(null, { file: dbPath, size: 0, cache: memCache() });
    assert.ok(
      d && d.length === 1 && d[0].state === 'ask',
      '首见把"正在等的提问"吞了 —— 停机期间被问到就永远收不到通知',
    );
    // 注意：这只是"适配器愿意报"。真正防重发靠引擎的 claim()（跨重启持久），不在这一层。
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimo：bash 声明 interactive 且 running → 等你在终端输入；普通 running 的 bash 不报', () => {
  if (!sqliteOrNull()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mimo-shell-'));
  const { db, dbPath } = makeMimoTurnDb(dir);
  try {
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('ses_b', null, '要我输密码');
    addRawPart(db, 'p-b1', 'm-b', 'ses_b', BASH_PART('call_b1', 'running', true), 10);
    addRawPart(db, 'p-b2', 'm-b', 'ses_b', BASH_PART('call_b2', 'running', false), 20);
    addRawPart(db, 'p-b3', 'm-b', 'ses_b', BASH_PART('call_b3', 'completed', true), 30);

    const adapter = loadMimoAt(dbPath);
    const d = adapter.snapshot(null, { file: dbPath, size: 0, cache: memCache() });
    assert.ok(d && d.length === 1, `只该报那条 interactive 的，实际 ${d && d.length}`);
    assert.strictEqual(d[0].key, 'ask:call_b1');
    assert.strictEqual(d[0].kind, 'ask-shell');
    assert.strictEqual(d[0].state, 'ask');
    assert.match(d[0].text, /ssh-add/);
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

group('真实数据回归 · WorkBuddy 安全中心（只读）');

test('「等你批准」判定数 == 日志里客观存在的待批准事件数（可证伪等式）', () => {
  const spoolDir = workbuddyApproval.dirs[0];
  const files = listFilesRec(spoolDir, 0, /^audit-spool-.*\.jsonl$/i).concat(
    listFilesRec(path.dirname(spoolDir), 0, /^\d{4}-\d{2}-\d{2}\.jsonl$/),
  );
  if (!files.length) throw new Error('本机没有 WorkBuddy 审计日志，跳过（不算失败）');

  // 右边**独立于适配器**：取自日志自己的一句话 —— `decision:"info"` 就是审计日志在说
  // "这不是一个决定，是一个待决"。维护类（audit./config.）不是给人看的事件，排除。
  // （复制适配器的白名单来"验证"适配器就是自证，什么都验不出来。）
  const isUserDecision = (ev) =>
    ev.decision === 'info' && !/^(audit|config)\./.test(String(ev.eventType || ''));
  let expected = 0;
  let got = 0;
  let noise = 0;
  const cache = memCache();

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue; // 正在写
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        continue;
      }
      const isPending = isUserDecision(ev);
      if (isPending) expected += 1;
      const d = workbuddyApproval.turnEnd(ev, { file: f, event: ev, cache });
      if (d) {
        got += 1;
        if (!isPending) noise += 1;
      }
    }
  }

  assert.ok(expected > 0, '语料里一条待批准事件都没有 —— 这个结果证明不了任何事（无法证伪）');
  assert.strictEqual(got, expected, `适配器判定 ${got} 条，日志里客观存在 ${expected} 条`);
  assert.strictEqual(noise, 0, '有不该通知的事件被报出来了');
  console.log(`      → 校验了 ${expected} 条真实待批准事件，一条不多一条不少`);
});

test('spool 里没有未登记的审计事件类型（新类型会改变「该不该响」的判断）', () => {
  const files = listFilesRec(workbuddyApproval.dirs[0], 0, /^audit-spool-.*\.jsonl$/i);
  if (!files.length) throw new Error('本机没有 spool 文件，跳过（不算失败）');

  // 已登记 = 明确会通知的（PENDING_EVENTS）+ 明确静默的。出现第三种 = 必须重新判断。
  // 这份清单由 2026-10-09 对全部历史审计日志的一次普查得出（每个类型都看过真实样本）。
  const known = new Set([
    'network.ask-matched',
    'network.approved',
    'file-safety.bulk-delete.needs-approval',
    'file-safety.bulk-delete.approved',
    'file-safety.bulk-delete.rejected',
    'file-safety.needs-approval',
    'file-safety.approved',
    'file-safety.allow-listed',
    'sensitive-protection.detected',
    'sensitive-protection.approval-resolved',
    'sensitive-protection.approval-timeout',
    'command-safety.sandbox-executed',
    'command-safety.auto-approved',
    'command-safety.approved',
    'command-safety.program-blacklist-blocked',
    'command-safety.system-tool-blocked',
    'audit.retention.pruned',
    'config.orderedRules.migrated',
    'WebFetch',
  ]);
  const unknown = new Set();
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.eventType && !known.has(ev.eventType)) unknown.add(ev.eventType);
      } catch {
        /* 半行写入 */
      }
    }
  }
  assert.strictEqual(
    [...unknown].join(','),
    '',
    `出现未登记的审计事件类型 [${[...unknown].join(', ')}] —— 先 grep 真实日志确认它是否意味着「等你决定」，再决定进 PENDING_EVENTS 还是静默`,
  );
});

// ------------------------------------------------------------ engine behaviour

group('通用引擎 · 用合成适配器在临时目录里跑（不联网、不写真实日志）');

test('第一次运行只建立基线，不发通知', () => {
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: 'turn-end', id: 'old', text: '历史' })}\n`);
  runEngine();
  assert.strictEqual(sent().length, 0, '历史轮次不应被当成新闻');
});

test('重启后追加一轮 → 发出 1 条，参数正确', () => {
  restart();
  fs.appendFileSync(
    sessionFile,
    `${JSON.stringify({ type: 'turn-end', id: 'n1', text: '已经改好了', conversation: '测试对话' })}\n`,
  );
  runEngine();
  assert.strictEqual(sent().length, 1);
  const args = sent()[0];
  const at = (k) => args[args.indexOf(k) + 1];
  assert.strictEqual(at('--agent'), 'TestAgent');
  assert.strictEqual(at('--state'), 'done');
  assert.strictEqual(at('--conversation'), '测试对话');
  assert.strictEqual(at('--preview'), '已经改好了');
  assert.strictEqual(at('--from'), 'testagent-watch');
});

test('历史被复制进新文件（分叉/回放）时不会重发', () => {
  // The real scenario: the software rewrites a conversation into a NEW file, copying
  // past events verbatim. Dedup must key on the event identity, not the file.
  const fork = path.join(sessions, 's2.jsonl');
  fs.writeFileSync(
    fork,
    `${JSON.stringify({ type: 'turn-end', id: 'n1', text: '已经改好了', conversation: '测试对话' })}\n`,
  );
  restart();
  runEngine(); // first sight of s2 → baseline, nothing fires
  fs.appendFileSync(fork, `${JSON.stringify({ type: 'turn-end', id: 'n1', text: '已经改好了' })}\n`);
  runEngine(); // now readable, but the id was already claimed
  assert.strictEqual(sent().length, 0, '同一轮次不能因为换了文件就再响一次');
});

test('提问轮 → ❓ 等你回答 + 优先级 4', () => {
  fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'turn-end', id: 'n2', ask: true, text: '你选哪个方案？' })}\n`);
  runEngine();
  assert.strictEqual(sent().length, 1);
  const args = sent()[0];
  assert.strictEqual(args[args.indexOf('--state') + 1], 'ask');
  assert.strictEqual(args[args.indexOf('--priority') + 1], '4');
});

test('没有换行的半截行不会被消费，补全后才补发', () => {
  fs.appendFileSync(sessionFile, '{"type":"turn-end","id":"n3","text":"半截');
  runEngine();
  assert.strictEqual(sent().length, 0, '半截行不该被当成一个事件');
  fs.appendFileSync(sessionFile, '"}\n');
  restart();
  runEngine();
  assert.strictEqual(sent().length, 1, '补全后必须补发，不能永久丢失');
  assert.strictEqual(sent()[0][sent()[0].indexOf('--preview') + 1], '半截');
});

test('适配器没有给会话名时用兜底', () => {
  fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'turn-end', id: 'n4', text: 'x' })}\n`);
  runEngine();
  assert.strictEqual(sent()[0][sent()[0].indexOf('--conversation') + 1], '兜底名字');
});

test('停机期间完成的轮次在重启后补发，而不是当成历史跳过', () => {
  restart();
  fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'turn-end', id: 'n5', text: '停机期间完成的' })}\n`);
  fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'turn-end', id: 'n6', text: '也是' })}\n`);
  runEngine();
  assert.strictEqual(sent().length, 2, '两条都要补发');
});

test('文件被清空（归档）后，同一轮询里写进来的新事件不会被永久跳过', () => {
  // 真实场景：audit-log 的 spool 归档时会被**清空**，而且会在同一个轮询周期内被重建。
  // 引擎若把「文件变短」读成「已消费到新的末尾」，那批新事件就永远读不到 —— 连日志都不留。
  // ⚠️ 把 tools/agent-watch.js 里的回退目标改回 `size` 时，这条测试会失败：这就是它的证伪点。
  const trunc = path.join(sessions, 'trunc.jsonl');
  fs.writeFileSync(
    trunc,
    `${JSON.stringify({ type: 'turn-end', id: 'o1', text: '归档前的旧事件' })}\n` +
      `${JSON.stringify({ type: 'turn-end', id: 'o2', text: '也是旧的' })}\n`,
  );
  restart();
  runEngine(); // 首见 → 建基线
  assert.strictEqual(sent().length, 0, '首见不该报历史');

  // 清空 → 立刻写入一条更短的新事件（归档与新事件挤在同一个轮询周期里）
  fs.writeFileSync(trunc, `${JSON.stringify({ type: 'turn-end', id: 'f1', text: '清空后新来的' })}\n`);
  runEngine(); // 这一轮发现变短 → 把读位回退到 0
  runEngine(); // 下一轮从 0 读出来
  assert.strictEqual(sent().length, 1, '清空后写入的事件被跳过了');
  assert.strictEqual(sent()[0][sent()[0].indexOf('--preview') + 1], '清空后新来的');
});

test('--list 能列出适配器（含环境变量注入的）', () => {
  const out = capture(() => engine.run(['--list']));
  assert.ok(out.includes('testagent'));
  assert.ok(out.includes('workbuddy'));
  assert.ok(out.includes('zcode'));
});

test('--status 能跑通', () => {
  assert.ok(capture(() => engine.run(['--status', '--agent', 'testagent'])).includes('testagent'));
});

// ------------------------------------------- engine: 'rewrite' mode (whole-file snapshots)
//
// This is the shape DSH uses and the reason the engine has a second reader. The invariant
// that matters is the user-facing one: ONE finished turn = exactly ONE notification, even
// though the software rewrites the file several times on its way to "finished".

group('通用引擎 · rewrite 模式（整文件被反复重写的那种日志）');

const rewriteSessionFile = path.join(rewriteDir, 'session-test.json');

/**
 * Write the session object, then run one scan exactly as the watcher would, and return
 * what THAT scan sent. (`runtime.sent` is reset at the start of every run, so a test must
 * never accumulate across runs — it would silently pass while sending nothing.)
 */
function driveRewrite(json) {
  fs.writeFileSync(rewriteSessionFile, JSON.stringify(json), 'utf8');
  runEngine([], 'testrewrite');
  return sent();
}

test('第一次见到已有内容的文件 → 只建基线，不发通知（历史不是新闻）', () => {
  fs.rmSync(rewriteSessionFile, { force: true });
  restart();
  assert.strictEqual(driveRewrite({ turn: 1, done: true, text: '昨天的活' }).length, 0);
});

test('一轮从"未完成"变成"完成" → 恰好 1 条', () => {
  assert.strictEqual(driveRewrite({ turn: 2, done: false }).length, 0, '未完成时不该发');

  const fired = driveRewrite({ turn: 2, done: true, text: '干完了' });
  assert.strictEqual(fired.length, 1);
  const argv = fired[0];
  assert.strictEqual(argv[argv.indexOf('--state') + 1], 'done');
  assert.ok(argv.includes('干完了'), '预览文本应带上');
});

test('同一轮被反复观察为"完成" → 仍然一条都不发', () => {
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(driveRewrite({ turn: 2, done: true, text: '干完了' }).length, 0);
  }
});

test('边界来回抖动（完成→未完成→完成）也不会补发', () => {
  driveRewrite({ turn: 2, done: false });
  assert.strictEqual(driveRewrite({ turn: 2, done: true, text: '干完了' }).length, 0);
  driveRewrite({ turn: 2, done: false });
  assert.strictEqual(driveRewrite({ turn: 2, done: true, text: '干完了' }).length, 0);
});

test('之后的**新**轮次照常通知', () => {
  const fired = driveRewrite({ turn: 3, done: true, text: '新一轮' });
  assert.strictEqual(fired.length, 1);
  assert.ok(fired[0].includes('新一轮'));
});

test('重启后仍记得发过哪些轮次（缓存落盘）', () => {
  restart(); // forget in-memory state, re-read from disk
  assert.strictEqual(driveRewrite({ turn: 3, done: true, text: '新一轮' }).length, 0, '重启后重放了历史轮次');
});

group('通用引擎 · selfRead（适配器自己读二进制 SQLite，引擎不 parse）');

const selfReadBlob = path.join(selfReadDir, 'state.blob');

function driveSelfRead(text) {
  fs.writeFileSync(selfReadBlob, text, 'utf8');
  runEngine([], 'testselfread');
  return sent();
}

test('非 JSON 文件：声明 selfRead 的适配器照常被调用并发出通知', () => {
  fs.rmSync(selfReadBlob, { force: true });
  restart();
  assert.strictEqual(driveSelfRead('PENDING 等你批准：rm -rf dist').length, 0, '首见只建基线');

  const fired = driveSelfRead('PENDING 等你批准：rm -rf dist（改一下）');
  assert.strictEqual(fired.length, 1, 'selfRead 适配器没被调用 —— 引擎仍在 JSON.parse');
  const argv = fired[0];
  assert.strictEqual(argv[argv.indexOf('--state') + 1], 'approval');
  assert.ok(argv.join(' ').includes('dist'), '正文应来自适配器自己读到的内容，实际: ' + argv.join(' '));
});

test('对照：同一份非 JSON 文件，不声明 selfRead 的适配器一条都不发', () => {
  fs.writeFileSync(selfReadBlob, 'PENDING 等你批准：rm -rf dist', 'utf8');
  runEngine([], 'testnoselfread');
  assert.strictEqual(sent().length, 0, '引擎对非 JSON 文件本该 parse 失败并跳过 —— 这正是 selfRead 存在的理由');
});

group('心跳 · 能分辨"活着"和"没了"（这是本项目最需要的那个信号）');

const heartbeatFile = path.join(logs, 'hb.json');

test('没有任何心跳记录时说"未启动"', () => {
  fs.rmSync(heartbeatFile, { force: true });
  assert.ok(engine.heartbeatLine().includes('未启动'));
});

test('记录里是死进程 → 报"已停止"，并给出怎么拉起来', () => {
  fs.writeFileSync(heartbeatFile, JSON.stringify({ beats: { 999999: Date.now() } }), 'utf8');
  const line = engine.heartbeatLine();
  assert.ok(line.includes('已停止'), line);
  assert.ok(line.includes('一键启动.vbs'), line);
});

test('记录里是本进程 → 报"运行中"', () => {
  fs.writeFileSync(heartbeatFile, JSON.stringify({ beats: { [process.pid]: Date.now() } }), 'utf8');
  assert.ok(engine.heartbeatLine().includes('运行中'), engine.heartbeatLine());
});

test('兼容旧版单条记录格式（不会因为升级而误报未启动）', () => {
  fs.writeFileSync(heartbeatFile, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8');
  assert.ok(engine.heartbeatLine().includes('已停止'));
});

test('短命的 --once 运行不会把长命监听器的记录盖掉', () => {
  // A long-running watcher is "alive" (simulated with this process's pid), and a
  // short-lived run then writes its own beat. Both must survive; the dead ones are
  // pruned. Getting this wrong is what made --status report a healthy watcher as dead.
  fs.writeFileSync(heartbeatFile, JSON.stringify({ beats: { [process.pid]: Date.now(), 999999: Date.now() } }), 'utf8');
  engine.beat();
  const raw = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
  assert.ok(raw.beats[process.pid], '仍在跑的进程必须保留');
  assert.ok(!raw.beats['999999'], '已死的进程必须被清掉');
  assert.ok(engine.heartbeatLine().includes('运行中'));
});

// `--status --quiet` is what start-agent-watch.cmd branches on to stay idempotent:
// it must answer through the RETURN VALUE only, and must not print anything (a .cmd
// cannot compare Chinese console text reliably under the OEM code page). Two watchers
// would send every notification twice, so getting this wrong is user-visible.
test('--status --quiet：没有记录 → false（启动器该启动）', () => {
  fs.rmSync(heartbeatFile, { force: true });
  assert.strictEqual(engine.run(['--status', '--quiet']), false);
});

test('--status --quiet：活着的进程 → true（启动器必须什么都不做）', () => {
  fs.writeFileSync(heartbeatFile, JSON.stringify({ beats: { [process.pid]: Date.now() } }), 'utf8');
  assert.strictEqual(engine.run(['--status', '--quiet']), true);
});

test('--status --quiet：已死的进程 → false', () => {
  fs.writeFileSync(heartbeatFile, JSON.stringify({ beats: { 999999: Date.now() } }), 'utf8');
  assert.strictEqual(engine.run(['--status', '--quiet']), false);
});

test('--status --quiet：进程还在但心跳已停 3 小时 → false（不认领僵尸）', () => {
  fs.writeFileSync(
    heartbeatFile,
    JSON.stringify({ beats: { [process.pid]: Date.now() - 3 * 3600 * 1000 } }),
    'utf8',
  );
  assert.strictEqual(engine.run(['--status', '--quiet']), false);
});

test('--status 不带 --quiet 时行为不变（仍打印人看的行）', () => {
  fs.writeFileSync(heartbeatFile, JSON.stringify({ beats: { [process.pid]: Date.now() } }), 'utf8');
  assert.strictEqual(engine.run(['--status']), undefined);
});

test('--help 走"用法"分支，不落进前台循环（不依赖起子进程，哪都能跑）', () => {
  // 参数里补了 --once/--dry-run/不存在的 --agent：万一 --help 分支被删掉，run() 也只会
  // 打印"没有这个适配器"然后返回，**不会把测试进程变成常驻监听**。所以这条断言安全。
  const out = capture(() =>
    engine.run(['--help', '--agent', 'definitely-no-such-adapter', '--once', '--dry-run']),
  );
  assert.match(out, /用法：node tools\/agent-watch\.js/, '--help 没有走用法分支');
  assert.ok(!/没有这个适配器/.test(out), '--help 没被优先处理，参数解析继续往下走了');
});

test('--help 必须秒退并打印用法，绝不能进常驻循环（否则会起第二个监听 → 通知发两遍）', () => {
  // 判据：如果不加 --once 就落进前台循环，子进程会挂住直到超时被杀。
  // 所以"没被超时杀掉 + 退出码 0 + 有用法文本"三条同时成立，才算这条没退化。
  // 2026-10-09：未知标志原本直接穿透到常驻循环，一次 --help 就起了第二个 watcher。
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'agent-watch.js'), '--help'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.error) {
    // 有的受限环境禁止起子进程（EBUSY）。这不是 --help 的问题 —— 跳过，
    // 与 sqlite 测试"能力不具备就 return"同一惯例。用户机器上会真的跑。
    return;
  }
  assert.strictEqual(
    r.signal,
    null,
    `--help 被超时杀掉（signal=${r.signal}）= 它进了常驻循环，会起第二个监听`,
  );
  assert.strictEqual(r.status, 0, `--help 应退出码 0，实际 ${r.status}`);
  assert.match(r.stdout, /用法：node tools\/agent-watch\.js/, '--help 没有打印用法');
  assert.match(r.stdout, /--status/, '--help 的用法里缺点名的选项');
});

// --------------------- node 运行时解析（2026-10-09 事故回归锁）

group('node 运行时解析 · 防"升级后通知静默丢失"');

/**
 * 事故：WorkBuddy 升级把 `…\node\versions\22.22.2-3\node.exe` 删掉了，而监听进程
 * 仍跑在这条**已被删除**的镜像上（Windows 让已加载的镜像继续活着）→ 心跳正常、判定照写，
 * 但 `spawn(process.execPath)` 一律 **ENOENT** → 通知变成"判定成功、从未发出"，用户侧毫无提示。
 * 现场：19:51:43 `已通知(任务完成) agent=codex …` 紧跟一行 `推送失败: spawn … ENOENT`。
 */
test('resolveNodeBin 必须绕开不存在的路径，且不许落到升级暂存目录里', () => {
  const bogus = path.join(ROOT, 'definitely', 'missing', 'versions', '22.22.2-3', 'node.exe');
  assert.ok(!fs.existsSync(bogus), '这条测试自己的前提被破坏了：那条坏路径居然存在');
  // 传坏路径 = 让"第一候选"失效，从而**真的走完整条回退链**（否则 execPath 那一步
  // 就把答案给出来了，链子根本没被测到）。
  const got = engine.resolveNodeBin(bogus);
  assert.notStrictEqual(got, bogus, 'resolveNodeBin 原样返回了不存在的路径 —— 回退链没生效');
  const probe = spawnSync(got, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.strictEqual(probe.status, 0, `回退到的 node 无法执行：${got}`);
  assert.ok(
    !got.includes('.deleting.'),
    `落到了 WorkBuddy 升级的暂存目录（即将被删）：${got} —— 等于把同一个雷埋回去`,
  );
});

test('候选列表里不许混进升级暂存目录（`.deleting.`）', () => {
  const list = engine.nodeBinCandidates('C:/nope/node.exe');
  assert.ok(list.includes('C:/nope/node.exe'), '传进去的那个应当排在第一个候选');
  const bad = list.filter((p) => String(p).includes('.deleting.'));
  assert.deepStrictEqual(bad, [], `候选里混进了暂存目录：${bad.join(', ')}`);
});

test('发送通知时不许再直接 spawn(process.execPath)（那条路会随升级静默失效）', () => {
  // 源码级锁：`resolveNodeBin` 存在但 fire() 不调用它，同样是坏的 —— 那正是
  // "模块说某功能在、代码却没接上"那一类。所以这里盯的是**调用点**，不是模块是否存在。
  // 覆盖面 = 全部**常驻**监听（agent-watch + 两个可复活旧链路）。短命进程不在此列：
  // 它们启动那一刻 execPath 必然有效，用它是**对的**。
  const longLived = ['tools/agent-watch.js', 'tools/codex-watch.js', 'tools/dsh-watch.js'];
  const all = [];
  for (const rel of longLived) {
    const p = path.join(ROOT, rel);
    assert.ok(fs.existsSync(p), `清单里的常驻监听不见了：${rel}`);
    const code = fs
      .readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      });
    for (const l of code.filter((l) => /spawn\(\s*process\.execPath\b/.test(l))) {
      all.push(`${rel}: ${l.trim()}`);
    }
  }
  assert.deepStrictEqual(all, [], `还有常驻监听在直接 spawn(process.execPath)：\n${all.join('\n')}`);
});

// --------------------- 不变式审查器（2026-10-09：把"审查靠人肉"变成一条命令）
//
// 一条**永远不跳闸**的检查等于没有检查。所以这里不是"跑一遍看看有没有 FAIL"，
// 而是**造假现场**（临时目录里的 config.toml / 启动文件夹），断言它**必须**报 FAIL。
// 真现场（`~/.codex/config.toml`、真的启动文件夹）绝不碰 —— 用 BAND_NOTIFY_AUDIT_* 缝。

group('不变式审查器 · 必须真的会跳闸');

const AUDIT = path.join(ROOT, 'tools', 'audit-invariants.js');

function runAudit(env) {
  return spawnSync(process.execPath, [AUDIT], {
    encoding: 'utf8',
    timeout: 60000,
    env: Object.assign({}, process.env, { BAND_NOTIFY_AGENT_MODULE: '' }, env),
  });
}

test('审查器在本仓库当前状态下必须是绿的（0 项 FAIL）', () => {
  const r = runAudit({});
  if (r.error) return; // 受限环境禁子进程（EBUSY），与 sqlite 测试同一惯例
  const out = `${r.stdout}${r.stderr}`;
  const m = out.match(/不变式审查：(\d+) 项 FAIL/);
  assert.ok(m, `审查器没有打印总结行：\n${out}`);
  assert.strictEqual(r.status, 0, `仓库有 ${m[1]} 项 FAIL，必须先修掉或明确豁免：\n${out}`);
});

test('变异①：持久化配置里写死带版本号的 node → 这条检查必须 FAIL', () => {
  const dir = path.join(tmpRoot, 'audit-mut-cfg');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'config.toml');
  fs.writeFileSync(
    cfg,
    'model = "x"\n' +
      'notify = [ "C:\\Users\\a\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe", "C:\\x\\notify.js" ]\n',
    'utf8',
  );
  const r = runAudit({
    BAND_NOTIFY_AUDIT_CODEX_CONFIG: cfg,
    BAND_NOTIFY_AUDIT_STARTUP: path.join(dir, 'no-startup'),
    BAND_NOTIFY_AUDIT_TASK: path.join(dir, 'no-task'),
  });
  if (r.error) return;
  const out = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 1, `配置里写死了带版本号的 node，审查器却没判 FAIL：\n${out}`);
  assert.match(out, /持久化产物里的 node 路径：[\s\S]*?违规 1 处/, '没在这条检查里点名');
});

test('变异②：启动文件夹残留旧链路自启 → 这条检查必须 FAIL（这是"发两遍"的源头）', () => {
  const dir = path.join(tmpRoot, 'audit-mut-startup');
  const startup = path.join(dir, 'Startup');
  fs.mkdirSync(startup, { recursive: true });
  fs.writeFileSync(path.join(startup, 'band-notify-codex-watch.vbs'), 'x', 'utf8');
  const r = runAudit({
    BAND_NOTIFY_AUDIT_STARTUP: startup,
    BAND_NOTIFY_AUDIT_CODEX_CONFIG: path.join(dir, 'no-config.toml'),
    BAND_NOTIFY_AUDIT_TASK: path.join(dir, 'no-task'),
  });
  if (r.error) return;
  const out = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 1, `启动文件夹里有第二套自启，审查器却没判 FAIL：\n${out}`);
  assert.match(out, /自启唯一性：[\s\S]*?残留旧链路自启/, '没在这条检查里点名');
});

test('变异③：启动脚本里写死带版本号的 node → 这条检查必须 FAIL', () => {
  const dir = path.join(tmpRoot, 'audit-mut-vbs');
  const startup = path.join(dir, 'Startup');
  fs.mkdirSync(startup, { recursive: true });
  fs.writeFileSync(
    path.join(startup, 'band-notify-launch.vbs'),
    'sh.Run "C:\\Users\\a\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe script.js"\r\n',
    'utf8',
  );
  const r = runAudit({
    BAND_NOTIFY_AUDIT_STARTUP: startup,
    BAND_NOTIFY_AUDIT_CODEX_CONFIG: path.join(dir, 'no-config.toml'),
    BAND_NOTIFY_AUDIT_TASK: path.join(dir, 'no-task'),
  });
  if (r.error) return;
  const out = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 1, `启动脚本里写死了带版本号的 node，审查器却没判 FAIL：\n${out}`);
  assert.match(out, /持久化产物里的 node 路径：[\s\S]*?违规 1 处/, '没在这条检查里点名');
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

// -------------------------------------------------------------------------

console.log(`\n${'─'.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped} 项`);
if (failed) {
  console.log('\n失败详情:');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failed ? 1 : 0);
