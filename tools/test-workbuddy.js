'use strict';
/**
 * WorkBuddy adapter · real-data regression.
 *
 * The bug this file exists for (2026-10-05):
 *
 *   The AI asked the user a question with `AskUserQuestion`. The tool BLOCKS, so the
 *   turn did not end there — the user answered and the same turn carried on. The
 *   watcher only ever looked at turn ends, so the question produced NO notification at
 *   all. The user found out only because they happened to be looking at the screen.
 *
 * And the second half of the same complaint: a turn that ended by asking three
 * questions was announced as "✅ 已完成".
 *
 * ── What is pinned here, after 2026-10-06 ─────────────────────────────────────
 *   1. `AskUserQuestion` → announced immediately, on the `function_call` line.
 *      This is the exact signal, and it is what actually solved the miss above.
 *   2. A reply whose closing text is a question → STILL `done`. The first fix for
 *      the second half guessed from the prose, and on real data that guess flagged
 *      100 of 162 WorkBuddy turn-ends (61.7%) while the same transcripts hold only
 *      14 genuine AskUserQuestion calls — and 0 of its 141 flagged turns were ever
 *      answered. WorkBuddy is used as a teacher here, and its lessons end with
 *      Socratic prompts ("想想为什么？"), which are sign-offs, not handovers.
 *      Guessing is gone: only a field may say ❓.
 *
 * Runs against the REAL transcript when one is present (the project's rule: an adapter
 * ships with a real-data regression), and against a synthetic event otherwise, so it
 * still runs on a machine that has never used WorkBuddy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const adapter = require('../src/agents/workbuddy.js');

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('通过 ✅  ' + name);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log('失败 ❌  ' + name);
    console.log('        ' + err.message);
  }
}

/** A cache shaped like the engine's persisted per-adapter memo. */
function makeInfo(file) {
  return { file: file || 'D:/nope/does-not-exist.jsonl', cache: new Map() };
}

check('提问事件 → 立刻判为「等你回答」，并带上问题原文', () => {
  const ev = {
    type: 'function_call',
    name: 'AskUserQuestion',
    id: 'call-abc-123',
    callId: 'call_00_x',
    arguments: JSON.stringify({
      questions: [
        { question: '「AI 在等你回答」这件事，通知要怎么做？', header: '通知状态', options: [] },
      ],
    }),
  };
  const desc = adapter.turnEnd(ev, makeInfo());
  assert.ok(desc, '必须产出通知描述');
  assert.strictEqual(desc.state, 'ask');
  assert.strictEqual(desc.kind, 'ask-pending');
  assert.ok(desc.text.includes('通知要怎么做'), '正文要带问题原文，实际: ' + desc.text);
  assert.strictEqual(desc.key, 'ask:call-abc-123', '去重键必须用事件自己的 id');
});

check('提问事件：多个问题合并，且不会与轮次键撞车', () => {
  const ev = {
    type: 'function_call',
    name: 'AskUserQuestion',
    id: 'turn-shaped-id',
    arguments: JSON.stringify({ questions: [{ question: '第一问' }, { question: '第二问' }] }),
  };
  const desc = adapter.turnEnd(ev, makeInfo());
  assert.ok(desc.text.includes('第一问') && desc.text.includes('第二问'), desc.text);
  assert.notStrictEqual(desc.key, 'turn-shaped-id', '必须加 ask: 前缀，否则会和轮次键去重撞车');
});

check('别的工具调用 → 不产生任何通知（不能把每次 Read 都当提问）', () => {
  for (const name of ['Read', 'Bash', 'Edit', 'Grep', 'present_files']) {
    assert.strictEqual(
      adapter.turnEnd({ type: 'function_call', name, id: 'x', arguments: '{}' }, makeInfo()),
      null,
      name + ' 不该触发通知',
    );
  }
});

check('提问事件 arguments 是坏 JSON → 仍然通知，只是正文为空（宁可少字，不可漏报）', () => {
  const desc = adapter.turnEnd(
    { type: 'function_call', name: 'AskUserQuestion', id: 'y', arguments: '{坏掉的' },
    makeInfo(),
  );
  assert.ok(desc, '必须仍然通知');
  assert.strictEqual(desc.state, 'ask');
  assert.strictEqual(desc.text, '');
});

check('结尾带提问的回复 → 仍然是「已完成」（文字不再参与判定）', () => {
  const ev = {
    type: 'message',
    role: 'assistant',
    id: 'msg-1',
    message: { usage: { input_tokens: 1 } },
    content: [
      {
        type: 'output_text',
        text: '三个问题都查清了。\n\n**顺带问一句**：你觉得 1 分钟的检查间隔合适，还是希望我调到 30 秒？',
      },
    ],
  };
  const desc = adapter.turnEnd(ev, makeInfo());
  assert.strictEqual(
    desc.state,
    'done',
    '轮次结束时不再靠文字猜 ❓ —— 真正的阻塞提问由 AskUserQuestion 在提出那一刻通知',
  );
  assert.strictEqual(desc.kind, 'turn-end');
});

check('普通交付回复 → 仍然是「已完成」', () => {
  const ev = {
    type: 'message',
    role: 'assistant',
    id: 'msg-2',
    message: { usage: { input_tokens: 1 } },
    content: [{ type: 'output_text', text: '已经改完了，文件都写好了。' }],
  };
  const desc = adapter.turnEnd(ev, makeInfo());
  assert.strictEqual(desc.state, 'done');
});

check('中间轮次的 prose（没有 message 字段）→ 不通知', () => {
  const ev = {
    type: 'message',
    role: 'assistant',
    id: 'msg-3',
    content: [{ type: 'output_text', text: '我先看一下日志。' }],
  };
  assert.strictEqual(adapter.turnEnd(ev, makeInfo()), null);
});

// ── 真实数据：在这台机器的真实会话里，历史上是否真有被漏掉的提问 ──────────────
const PROJECTS_DIR =
  process.env.BAND_NOTIFY_WORKBUDDY_DIR || path.join(require('os').homedir(), '.workbuddy', 'projects');

/**
 * Newest transcript that actually CONTAINS an AskUserQuestion call.
 *
 * Not simply the newest file: a brand-new session may have no ask in it yet (the one
 * on this machine had zero), and then both real-data checks fail for a reason that has
 * nothing to do with the adapter. Pick the newest file that has the phenomenon.
 */
function newestTranscriptWithAsk() {
  const all = [];
  (function walk(dir) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p);
      else if (it.name.endsWith('.jsonl')) {
        try {
          all.push({ p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  })(PROJECTS_DIR);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of all.slice(0, 40)) {
    try {
      if (/"name"\s*:\s*"AskUserQuestion"/.test(fs.readFileSync(f.p, 'utf8'))) return f.p;
    } catch {
      /* ignore */
    }
  }
  return '';
}

const transcript = newestTranscriptWithAsk();
if (!transcript) {
  console.log('\n(这台机器上没有 WorkBuddy 会话，跳过真实数据部分)');
} else {
  console.log('\n真实数据: ' + path.basename(transcript));

  check('真实日志里存在的每一个 AskUserQuestion 都能被捕获', () => {
    const lines = fs.readFileSync(transcript, 'utf8').split('\n');
    const info = makeInfo(transcript);
    let seen = 0;
    let missed = 0;
    for (const line of lines) {
      if (!line.includes('AskUserQuestion')) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type !== 'function_call' || ev.name !== 'AskUserQuestion') continue;
      seen += 1;
      const desc = adapter.turnEnd(ev, info);
      if (!desc || desc.state !== 'ask' || !desc.key) missed += 1;
    }
    assert.ok(seen > 0, '这份会话里应该有 AskUserQuestion 调用（它就是本次 bug 的现场）');
    assert.strictEqual(missed, 0, seen + ' 次提问里有 ' + missed + ' 次没被捕获');
    console.log('        真实捕获 ' + seen + ' 次提问，漏 ' + missed + ' 次');
  });

  check('真实日志：重复喂同一个提问事件 → 键稳定（重启后不会重发）', () => {
    const lines = fs.readFileSync(transcript, 'utf8').split('\n');
    const ev = lines
      .filter((l) => l.includes('AskUserQuestion'))
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.type === 'function_call' && e.name === 'AskUserQuestion');
    assert.ok(ev, '至少要有一个真实的提问事件');
    const a = adapter.turnEnd(ev, makeInfo(transcript));
    const b = adapter.turnEnd(ev, makeInfo(transcript));
    assert.strictEqual(a.key, b.key);
  });
}

console.log('\n' + '='.repeat(56));
if (failures.length === 0) {
  console.log('全部通过 (共 ' + pass + ' 项)');
  process.exit(0);
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + failures.length + ' 项');
  for (const f of failures) console.log('  · ' + f.name + ': ' + f.message);
  process.exit(1);
}
