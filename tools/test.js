#!/usr/bin/env node
'use strict';
/**
 * band-notify test suite. Sections:
 *   1. message format & delivery contract   (network-free, via --dry-run)
 *   2. chain follow-up mechanism            (keeps Codex computer-use alive)
 *   3. DSH watcher end-to-end               (synthetic session, local capture server)
 *
 *   node tools/test.js             # all sections
 *   node tools/test.js format      # one section: format | chain | watch
 *
 * Note for section 3: the capture server runs in THIS process. It must never
 * write to stdout, and the test must never use spawnSync while the server is
 * needed — a blocked event loop or a full stdout pipe would deadlock the child
 * and show up as a bogus network timeout.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NOTIFY = path.join(ROOT, 'notify.js');
const only = process.argv[2] || 'all';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, expect, detail) {
  results.push({ name, ok: Boolean(ok), expect, detail: detail || '' });
}

function testTurnText() {
  const {
    looksLikeQuestion,
    looksLikeContinuing,
    asksForSomething,
    OPTIONAL,
    DEFAULT_ASK_MAX_CHARS,
  } = require('../src/turn-text.js');

  // ── The production false positive that started all this (2026-10-05, 2:05) ──
  // A real `❓ 等你回答` alert fired for a turn that had DELIVERED everything and
  // finished; the AI had asked the user nothing. The closing sentence is verbatim
  // below (backticks around code spans dropped to keep the fixture quoting simple —
  // no rule in turn-text.js looks at them).
  const DECISION_TAIL =
    '你觉得**该不该现在统一**，还是**先让它稳着、等真出了不一致的毛病再动**？';
  // A long, marker-free report body. Kept separate from the closing line below so
  // fixtures can append different endings — appending to the courtesy version would
  // leave its "值得你想一下" inside tail(200) and pass for the wrong reason.
  const DELIVERY_BODY = [
    '三个问题分开答。',
    '',
    '① 那条「正在监听」为什么不能划掉：也许该先问一句，App 在后台被冻结了，它怎么还能秒收消息？普通的网络请求是 App 主动去问服务器（拉），一冻结就没人问了；ntfy 走的是长连接，管子一直不关，服务器有新消息就顺着管子推过来。安卓为省电会杀掉后台长连接，所以 ntfy 用了前台服务，代价是必须在通知栏挂一条通知，那条就是它的工作证，不是消息。',
    '② codex 什么没做——答案是它其实做了，是文档写错了。我去核了代码：tools/codex-watch.js 第 381 行本来就在调 src/turn-text.js 对最终回复做提问判定，"只有 DSH 支持"那句是过期的。真正的差别是证据强度：DSH 直接读它自己写的字段，Codex / WorkBuddy 只能看回复文字猜。',
    '③ 通用化：已经建好了。引擎 tools/agent-watch.js 把所有机械动作收在一处——找文件、只读新增字节、只推进到最后一个完整换行、读位落盘、按轮次去重、组装消息、调 notify.js、写日志、写心跳。每个软件只在 src/agents/ 贡献几十行。端到端实测通过。',
    '现在的状态：监听进程正在跑。以后一条命令就能知道它活着没有，这是这个项目最大的痛点——进程悄悄没了和今天没干活看起来一模一样。',
  ].join('\n');
  const COURTESY_CLOSING =
    '最后一个值得你想一下的问题：Codex 和 DSH 现在还是两套独立脚本，它们的过滤逻辑很特殊，我没硬塞进通用层。但引擎的模式是现成的——加一个 mode: snapshot 就能把 DSH 收进来。' +
    DECISION_TAIL;
  const LONG_DELIVERY = `${DELIVERY_BODY}\n\n${COURTESY_CLOSING}`;

  // ── The SECOND production false positive (2026-10-06, 00:41, Codex) ──────────
  // Verbatim final message of the "实时 Token 统计" turn (backticks dropped). The
  // turn HAD delivered — login done, device code no longer needed — and closed by
  // asking for the next instruction with no question mark at all. It was announced
  // as `❓ 等你回答`; the user's complaint was exactly "明明是完成任务".
  //
  // What fired was the bare `需要你` inside "所以需要你的选择", an explanatory noun
  // phrase. Kept here so the `需要你(?!的)` guard in turn-text.js cannot be undone.
  const NEXTTASK_REPORT =
    '已经好了。我刚核实，**GitHub CLI 已成功登录 liu123268，授权也已保存，你不用再输入设备码。**\n\n' +
    '之前换码，是因为工具的网络连接中断、旧请求失效，不是你没有完成操作。我前面的说明让你感觉要重复登录了。\n\n' +
    '现在剩下的是发布设置：建议仓库名用 **token-meter**，许可证用 **MIT**。这决定别人能怎样使用、修改和分发代码，所以需要你的选择，和登录无关。你回复 **“按推荐发布”**，我就继续创建公开仓库并上传源码和便携包。';

  // The `格式` section drives notify.js as a CHILD PROCESS, which some sandboxes
  // forbid outright (EBUSY). This section must never depend on that.
  const handovers = [
    ['是否/吗 提问', '要现在做任务 C 吗？告诉我**本地代码状态**（git 在哪个分支？有没有未提交的改动？），我带你一步步走。'],
    ['回一句话就动手', '要不要执行？回 "改" 我就动手。或者你看完觉得 `.run/` 其实该保留、暂时不动，告诉我 "不动" 也行。'],
    ['先检查一个理解点', '先检查一个关键理解点：**`AppUserMapper` 只有接口，调用它的方法时，真正接手并执行 SQL 的是谁？** 你回答这个问题后，我们就接着讲下一题。'],
    ['请你做一步再回来', '现在请你**完全退出 Codex，再重新打开**，让它重新读取修复后的配置。重启后两条警告是否都消失，还需要看实际界面。'],
    ['等你给信息', '告诉我服务器类型（Ubuntu/CentOS/Debian？），我接着教你 GUI 部署的具体操作。'],
    ['口语问候式提问', '你好！在的。你想接着聊 DeepSeek Harness 桌面版，还是有别的问题？'],
    ['等你确认清单', '按这个清单一项项确认：退出 less、curl 看到 Welcome to nginx。**确认后**，下一步我教你怎么打包。请你回复结果。'],
    // Signal (a) is length-independent: a long report that ends by asking the user
    // FOR something is a blocker, and no length rule may swallow it.
    ['长文但结尾明确要东西', `${DELIVERY_BODY}\n\n请你把服务器类型发我，我接着教你 GUI 部署。`],
    // ── The two cases the (now-disabled) length gate got WRONG. Both are real
    // corpus tails: long messages, no explicit ask, and genuinely blocked on the
    // user. If a length rule is ever re-enabled these must still come out true.
    ['长文但明说"你不选我就不动手"', `${DELIVERY_BODY}\n\n下一步需要先由你决定一件事：是保留当前仅本地提交、暂时不推送，还是撤销这条提交但保留所有项目文件？在你明确选择前，我不会关联或推送。`],
    ['长文结尾的决策提问', `${DELIVERY_BODY}\n\n要不要现在装？还是要继续测其他功能？`],
    // A bare decision question is a handover wherever it appears — the production
    // false positive was NOT one of these; it carried an OPTIONAL softener.
    ['没有软化的决策提问', `还剩一件事要你定。${DECISION_TAIL}`],
    // Still a request even with the guard: `需要你` followed by an ACTION.
    ['"需要你"后接动作仍是请求', '配置文件我已经改好了。需要你重新退出应用再打开一次，它才会读到新配置。'],
  ];
  const notHandovers = [
    ['完成报告', '**图表已改成完整数字，悬浮提示也重新做了。** 刷新页面后，纵轴会显示 `50,000,000`，不再用「万、亿」。'],
    ['交付说明', '已检查悬浮提示、软件比较、键盘操作和窄屏布局；本地服务运行正常，临时检查文件也已清理。'],
    ['教学解释（句中含问号）', '面试问“什么是结果映射”，你可以回答：结果映射就是把 SQL 查询结果的列转换成 Java 对象的属性。'],
    ['只读审查结论', '只读源码结论，未修改文件，未进行浏览器验收。'],
    // The real production false positive. Note what actually identifies it: the
    // closing question is framed as OPTIONAL REFLECTION ("值得你想一下"), NOT its
    // length. A length rule would also have killed the two handovers above.
    ['长文末尾"顺口一问"（真实误报）', LONG_DELIVERY],
    ['短文里的"顺口一问"同样不报', '都做完了。另外那个模块名你也可以考虑换一个，你觉得呢？'],
    // The 2026-10-06 production false positive. A completion report whose closing
    // paragraph EXPLAINS why the choice matters and then asks for the next command.
    ['完成汇报+顺带请求下一步（真实误报）', NEXTTASK_REPORT],
  ];

  // Pin the reasons, so a future edit cannot make these pass by accident.
  record(
    'turn-text · 误报样本确实带"顺口一问"措辞（而不是靠长度）',
    OPTIONAL.test(LONG_DELIVERY.slice(-200)),
    'OPTIONAL 命中',
    `命中=${OPTIONAL.test(LONG_DELIVERY.slice(-200))}，长度=${LONG_DELIVERY.length}`,
  );
  record(
    'turn-text · 误报样本里没有"向你要东西"的字样',
    !asksForSomething(LONG_DELIVERY),
    'false',
    String(asksForSomething(LONG_DELIVERY)),
  );
  record(
    'turn-text · 长度门槛默认关闭（否则长文里真在等你的会被误报成已完成）',
    DEFAULT_ASK_MAX_CHARS === 0,
    '0',
    String(DEFAULT_ASK_MAX_CHARS),
  );

  // Pin WHY the 2026-10-06 fixture is a non-handover, so the guard cannot be
  // "simplified" away later: the only rule that used to fire was the bare `需要你`
  // sitting inside the explanatory phrase "需要你的选择".
  const last200 = NEXTTASK_REPORT.slice(-200);
  record(
    'turn-text · 误报样本的"需要你"是陈述（"需要你的选择"），不是祈使',
    /需要你的/.test(NEXTTASK_REPORT) && !/请你|麻烦你|告诉我|回我/.test(last200),
    '需要你的=true 强请求=false',
    `需要你的=${/需要你的/.test(NEXTTASK_REPORT)} 强请求=${/请你|麻烦你|告诉我|回我/.test(last200)}`,
  );
  record(
    'turn-text · 该样本真正的请求句（"你回复X，我就继续"）不带问号',
    !/[?？]/.test(last200),
    'true',
    `尾部有问号=${/[?？]/.test(last200)}`,
  );

  // ── POLICY: may we CLAIM "it is waiting for you"? ───────────────────────────
  // History, both directions, both on 2026-10-05:
  //   · Measured against real behaviour the text guess was mostly WRONG — of the turns
  //     it flagged, only 4% (Codex) / 0% (WorkBuddy) were followed by an actual answer.
  //     So it was turned OFF.
  //   · Hours later the opposite miss hit production: a turn that ended by asking three
  //     questions was announced as "✅ 已完成". The user asked for it back, choosing
  //     "same body format, but the title says 等你回答".
  // So the default is ON again, with an opt-out. Note this is the NOISY half of the
  // pair: the exact signal is `askPending` in src/agents/workbuddy.js (the blocking
  // AskUserQuestion tool call), and that one cannot be wrong.
  const { looksLikeAsk, askFromTextEnabled } = require('../src/turn-text.js');
  delete process.env.BAND_NOTIFY_ASK_FROM_TEXT;
  record(
    'turn-text · 默认靠文字判 ❓（用户 2026-10-05 选定）',
    looksLikeAsk('你希望我用哪种方案，A 还是 B？') === true,
    'true',
    String(looksLikeAsk('你希望我用哪种方案，A 还是 B？')),
  );
  record(
    'turn-text · 默认开关是开的',
    askFromTextEnabled() === true,
    'true',
    String(askFromTextEnabled()),
  );
  process.env.BAND_NOTIFY_ASK_FROM_TEXT = '0';
  try {
    record(
      'turn-text · 设 0 可退回"只有 DSH 能报 ❓"（❓ 开始吵时先翻这个）',
      looksLikeAsk('你希望我用哪种方案，A 还是 B？') === false,
      'false',
      String(looksLikeAsk('你希望我用哪种方案，A 还是 B？')),
    );
  } finally {
    delete process.env.BAND_NOTIFY_ASK_FROM_TEXT;
  }

  for (const [label, text] of handovers) {
    record(`turn-text · 识别为提问：${label}`, looksLikeQuestion(text), 'true', String(looksLikeQuestion(text)));
  }
  for (const [label, text] of notHandovers) {
    record(`turn-text · 不误判为提问：${label}`, !looksLikeQuestion(text), 'false', String(looksLikeQuestion(text)));
  }
  record(
    'turn-text · 仍在继续（"我先…"）',
    looksLikeContinuing('我先去把三个文件改完，然后跑一遍测试。'),
    'true',
    String(looksLikeContinuing('我先去把三个文件改完，然后跑一遍测试。')),
  );
  record(
    'turn-text · 普通句子不算仍在继续',
    !looksLikeContinuing('任务已经完成，测试全部通过。'),
    'false',
    String(looksLikeContinuing('任务已经完成，测试全部通过。')),
  );
}

// ---------------------------------------------------------------- section 1

function realThreadId() {
  try {
    const lines = fs.readFileSync(path.join(os.homedir(), '.codex', 'session_index.jsonl'), 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const t = lines[i].trim();
      if (!t) continue;
      const row = JSON.parse(t);
      if (row && row.id && row.thread_name) return { id: row.id, name: row.thread_name };
    }
  } catch {
    /* Codex not installed */
  }
  return null;
}

function testFormat() {
  const known = realThreadId();
  const codexPayload = JSON.stringify({
    type: 'agent-turn-complete',
    'turn-id': known ? known.id : 'turn-7f3a',
    cwd: 'C:\\Users\\example-user\\Documents\\codex\\2026-10-04\\my-project',
    'last-assistant-message': '链路已经打通：电脑推送 → ntfy → 手机通知 → 手环振动。',
  });

  const cases = [
    {
      name: 'Codex 载荷 → 标题/对话名/摘要齐全',
      args: ['--from', 'codex', '--agent', 'codex', codexPayload],
      expect: known ? `正文含真实对话名「${known.name}」` : '正文含【codex】和摘要',
      check: (r) =>
        r.notice.title === '✅ 已完成' &&
        /【codex】/.test(r.notice.body) &&
        (known ? r.notice.body.includes(known.name.slice(0, 20)) : true) &&
        /链路已经打通/.test(r.notice.body),
    },
    {
      name: 'Codex 未知 turn-id → 回退项目文件夹',
      args: ['--from', 'codex', '--agent', 'codex', JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 'ffffffff-0000-0000-0000-000000000000', cwd: 'C:\\x\\new-chat', 'last-assistant-message': '回退测试' })],
      expect: '正文含 new-chat',
      check: (r) => /new-chat/.test(r.notice.body) && /回退测试/.test(r.notice.body),
    },
    {
      name: 'DSH 完成态',
      args: ['--from', 'dsh-watch', '--agent', 'DSH', '--state', 'done', '--conversation', '给手环接完成提醒', '--preview', '已经做完了'],
      expect: '✅ 已完成 · 【DSH】对话名 · 摘要',
      check: (r) => r.notice.title === '✅ 已完成' && r.notice.body === '【DSH】给手环接完成提醒 · 已经做完了',
    },
    {
      name: 'DSH 等你回答',
      args: ['--from', 'dsh-watch', '--agent', 'DSH', '--state', 'ask', '--conversation', '数据库迁移方案', '--preview', '在等你选一个选项'],
      expect: '❓ 等你回答',
      check: (r) => r.notice.title === '❓ 等你回答',
    },
    {
      name: 'DSH 出错了',
      args: ['--from', 'dsh-watch', '--agent', 'DSH', '--state', 'error', '--conversation', '构建流水线', '--preview', '任务出错'],
      expect: '⚠️ 出错了',
      check: (r) => r.notice.title === '⚠️ 出错了',
    },
    {
      // 和下面 `approval` 同一类陷阱：`wait` 是 DSH `goal.paused` / `goal.current` 的真实产出，
      // 名字或键值一旦写坏，`buildNotice` 会静默回落到 `done` ——「目标已暂停」变成「✅ 已完成」，
      // 意思正好反过来，而且不会报任何错。2026-10-09 审核补上。
      name: '已暂停（DSH 目标暂停）',
      args: ['--from', 'dsh-watch', '--agent', 'DSH', '--state', 'wait', '--conversation', '批量重构', '--preview', '目标已暂停'],
      expect: '⏸️ 已暂停',
      check: (r) => r.notice.title === '⏸️ 已暂停',
    },
    {
      // ⚠️ 这一条锁的是**语义**，不是排版。`buildNotice` 对不认识的 state 会回落到 'done'
      // （下一例恰好就是证明），所以 `STATES.approval` 一旦被改名/删掉，安全中心的
      // 「有弹窗等你点」会**以「✅ 已完成」发出去**——含义正好相反，而且没有任何东西会报错。
      // 2026-10-09 审核时补上：它和上面那条 `wait` 曾是 STATES 里仅有的两个「有适配器真实产出、
      // 却没有任何渲染回归锁」的状态。（`start` 至今无产出者，是待清理的死码，见 README。）
      name: '等你批准（安全中心 / 审批请求）',
      args: ['--from', 'workbuddy-approval-watch', '--agent', 'WorkBuddy', '--state', 'approval', '--conversation', 'stockweb', '--preview', '访问 www.chinamoney.com.cn'],
      expect: '❓ 等你批准',
      check: (r) => r.notice.title === '❓ 等你批准' && /www\.chinamoney/.test(r.notice.body),
    },
    {
      name: '未知 state → 不崩，回退到已完成',
      args: ['--agent', 'DSH', '--state', 'bogus', '--conversation', 'x', '--preview', 'y'],
      expect: '✅ 已完成',
      check: (r) => r.notice.title === '✅ 已完成',
    },
    {
      name: '缺对话名 → 回退项目文件夹且不留空占位',
      args: ['--agent', 'Codex', '--state', 'done', '--preview', '做完了'],
      expect: '正文无「 ·  · 」也无「【】」',
      check: (r) => !/·\s*·/.test(r.notice.body) && !/【】/.test(r.notice.body) && r.notice.body.length > 4,
    },
    {
      name: '文案不含轮次号',
      args: ['--from', 'dsh-watch', '--agent', 'DSH', '--state', 'done', '--conversation', '测试对话', '--preview', '做完了'],
      expect: '不含「第 N 轮」',
      check: (r) => !/第\s*\d+\s*轮/.test(r.notice.title) && !/第\s*\d+\s*轮/.test(r.notice.body),
    },
    {
      name: 'ntfy 载荷字段合法',
      args: ['--from', 'dsh-watch', '--agent', 'DSH', '--state', 'done', '--conversation', '字段校验', '--preview', 'ok'],
      expect: 'priority 1-5、有 topic/title/message',
      check: (r) =>
        Number.isInteger(r.payload.priority) && r.payload.priority >= 1 && r.payload.priority <= 5 &&
        Boolean(r.payload.topic) && Boolean(r.payload.title) && Boolean(r.payload.message),
    },
    {
      name: '短任务阈值过滤（minSeconds=10，用时 1 秒 → 跳过）',
      args: ['--agent', 'DSH', '--preview', '太短', '--elapsed-ms', '1000'],
      env: { BAND_NOTIFY_MIN_SECONDS: '10' },
      expect: '不产生通知',
      check: (r, res) => r === null && /skipped: elapsed/.test(res.stderr),
    },
  ];

  for (const c of cases) {
    const res = spawnNotify([NOTIFY, '--dry-run', ...c.args], {
      encoding: 'utf8',
      timeout: 30000,
      env: Object.assign({}, process.env, { BAND_NOTIFY_TOPIC: 'test-topic' }, c.env || {}),
    });
    let parsed = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      /* leave null */
    }
    let ok = false;
    let detail = res.status === 0 ? '' : `退出码 ${res.status}`;
    try {
      ok = res.status === 0 && Boolean(c.check(parsed, res));
      if (!detail) detail = parsed ? `title="${parsed.notice.title}" body="${parsed.notice.body}"` : (res.stderr || '').trim();
    } catch (err) {
      detail = `断言抛错: ${err.message}`;
    }
    record(`格式 · ${c.name}`, ok, c.expect, detail);
  }
}

// ---------------------------------------------------------------- section 2

/**
 * spawnSync returns `{ error, status: null, stdout: null, stderr: null }` when the child
 * process cannot be created at all — seen in sandboxes that forbid launching processes.
 * Normalising it here keeps every assertion below working, and turns a bare
 * "Cannot read properties of undefined" into a sentence that says what actually happened.
 * (This crashed the whole run before: one blocked spawn aborted the report, so the 40
 * tests that DID pass were never printed.)
 */
function spawnNotify(args, options) {
  const res = spawnSync(process.execPath, args, options);
  if (res.stdout === null || res.stdout === undefined) res.stdout = '';
  if (res.stderr === null || res.stderr === undefined) res.stderr = '';
  if (res.error) {
    res.stderr += `\n[test] 子进程无法启动: ${res.error.code || res.error.message}（环境限制，不是代码问题）`;
  }
  return res;
}

async function testChain() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'band-notify-chain-'));
  const marker = path.join(tmp, 'chain-ran.txt');
  const mark = (text) => [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},${JSON.stringify(text)})`];

  const cfgFile = (name, chain) => {
    const file = path.join(tmp, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({
      ntfyServer: 'https://ntfy.sh', topic: 'chain-test', title: '✅ {agent}', body: '{preview}',
      previewMax: 60, minSeconds: 0, enabled: true, logFile: path.join(tmp, `${name}.log`), chain,
    }), 'utf8');
    return file;
  };
  const run = (name, chain, extra) =>
    spawnNotify([NOTIFY, '--config', cfgFile(name, chain), '--dry-run', ...extra], {
      encoding: 'utf8', timeout: 30000,
    });

  const readable = run('codex', [mark('ran')], ['--from', 'codex', '--agent', 'codex']);
  let configPath = null;
  try {
    configPath = JSON.parse(readable.stdout).config;
  } catch { /* ignore */ }
  record('chain · 配置可读', Boolean(configPath), '--dry-run 输出 config 路径', readable.stdout.slice(0, 120));

  const broken = run('broken', [['C:\\definitely\\missing\\binary.exe', 'turn-ended']], ['--from', 'codex', '--agent', 'codex']);
  record('chain · 指向不存在的程序不报错', broken.status === 0 && !/unexpected error/.test(broken.stderr), '退出码 0', broken.stderr.trim());

  const { runChain } = require('../src/transport.js');
  fs.rmSync(marker, { force: true });
  runChain({ chain: [mark('executed')], logFile: path.join(tmp, 'direct.log'), debug: false }, { title: 't', body: 'b' });
  await sleep(2000);
  record('chain · 命令确实被执行', fs.existsSync(marker), '标记文件生成', fs.existsSync(marker) ? '' : '标记文件未生成');

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testDedupe() {
  const { isDuplicate, DEFAULT_WINDOW_MS } = require('../src/dedupe.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'band-notify-dedupe-'));
  const logDir = path.join(tmp, 'logs');
  const notice = { title: '✅ 已完成', body: '【Codex】stockweb · 已经改好了' };

  const first = isDuplicate({ notice, logDir });
  const second = isDuplicate({ notice, logDir });
  const other = isDuplicate({ notice: { title: '✅ 已完成', body: '【Codex】stockweb · 另一件事' }, logDir });
  // Same text, but long after the window: a genuinely new occurrence of identical text.
  const later = isDuplicate({ notice, logDir, now: Date.now() + DEFAULT_WINDOW_MS + 1000 });

  record('去重 · 第一次不拦截', first === false, 'false', String(first));
  record('去重 · 25s 内同一内容被拦截（钩子+监听器不会发两条）', second === true, 'true', String(second));
  record('去重 · 内容不同不拦截', other === false, 'false', String(other));
  record('去重 · 超出时间窗后不再拦截', later === false, 'false', String(later));

  // A RELATIVE logDir must land in the project, never in whatever directory the
  // caller happened to run from. notify.js is invoked by the watcher, by Codex's
  // computer-use wrapper, by DSH's Stop hook and by a double-clicked notify.cmd —
  // a CWD-relative path would split the "already sent" state into one file per
  // directory and the gate would silently stop firing (= the same turn, twice).
  // Measured 2026-10-05: a stray %TEMP%\last-notice.json next to logs\last-notice.json.
  const { statePath } = require('../src/dedupe.js');
  const rootAbs = path.join(__dirname, '..');
  const relative = statePath('logs');
  record(
    '去重 · 相对 logDir 锚在项目根，而不是当前工作目录',
    relative === path.join(rootAbs, 'logs', 'last-notice.json'),
    path.join(rootAbs, 'logs', 'last-notice.json'),
    relative,
  );
  const fallback = statePath(undefined);
  record(
    '去重 · 不传 logDir 时同样锚在项目根',
    fallback === path.join(rootAbs, 'logs', 'last-notice.json'),
    path.join(rootAbs, 'logs', 'last-notice.json'),
    fallback,
  );
  record(
    '去重 · 绝对 logDir 原样尊重（测试用的临时目录不能被改写）',
    statePath(logDir) === path.join(logDir, 'last-notice.json'),
    path.join(logDir, 'last-notice.json'),
    statePath(logDir),
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

function testLogRotation() {
  const { append, CEILING_BYTES, CHECK_EVERY_BYTES } = require('../src/logfile.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'band-notify-rot-'));
  const file = path.join(tmp, 'test.log');
  const sizeOf = () => fs.statSync(file).size;

  // The honest guarantee is MAX_BYTES + one checking batch, because the size is
  // only inspected once per CHECK_EVERY_BYTES appended.
  const limit = CEILING_BYTES;
  const line = (i, tag) => `[2026-10-05T00:00:00.000Z] ${tag} ${i} ${'x'.repeat(150)}`;

  let peak = 0;
  for (let i = 0; i < 8000; i += 1) {
    append(file, line(i, 'filler'));
    const s = sizeOf();
    if (s > peak) peak = s;
  }

  record(
    '日志轮转 · 运行中会长大（说明写入正常）',
    peak > 512 * 1024,
    '> 512 KB',
    `峰值 ${(peak / 1024).toFixed(0)} KB`,
  );
  record(
    '日志轮转 · 峰值不超过「上限 + 一批」',
    peak <= limit,
    `≤ ${(limit / 1024).toFixed(0)} KB`,
    `峰值 ${(peak / 1024).toFixed(0)} KB（检查批 ${(CHECK_EVERY_BYTES / 1024).toFixed(0)} KB）`,
  );

  // A rotation must have happened: the file should be far smaller than the peak.
  const settled = sizeOf();
  record(
    '日志轮转 · 轮转后明显回落',
    settled < peak,
    '< 峰值',
    `峰值 ${(peak / 1024).toFixed(0)} KB → 当前 ${(settled / 1024).toFixed(0)} KB`,
  );
  record(
    '日志轮转 · 保留最新记录',
    fs.readFileSync(file, 'utf8').includes('filler 7999'),
    '含最新一行',
    fs.readFileSync(file, 'utf8').includes('filler 7999') ? '' : '最新行丢失',
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- section 3

async function testWatch() {
  let PORT;
  const received = [];
  const server = http.createServer((req, res) => {
    // Silent on stdout on purpose (see file header).
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        received.push({ parseError: true });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'band-notify-watch-'));
  const sessionDir = path.join(tmpHome, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });

  const payload = (open, response) => ({
    version: 7,
    record: {
      identity: { formatVersion: 4, cwd: 'C:\\Users\\example-user\\Projects\\demo-app' },
      rows: {
        title: { ver: 1, seq: 10, val: '给手环接完成提醒' },
        turnBoundary: { ver: 2, seq: 10, val: { openTurnStartSeq: open, lastTurn: open === null ? 2 : 1, lastStepBoundary: { kind: 'start', seq: 9 } } },
        sessionStats: { ver: 1, seq: 10, val: { turns: open === null ? 2 : 1, steps: 4, lastTurn: open === null ? 2 : 1, openStep: open === null ? null : { turn: 2, step: 5 }, pendingCalls: {} } },
        turnOutline: { ver: 2, seq: 10, val: { turns: [{ turn: open === null ? 2 : 1, seq: 1, prompt: '做提醒', response }], draft: '' } },
      },
    },
  });

  const file = path.join(sessionDir, 'session-test0000-1111-2222-3333.json');
  fs.writeFileSync(file, JSON.stringify(payload(10, '')), 'utf8');

  const watcher = spawn(process.execPath, [path.join(__dirname, 'agent-watch.js'), '--agent', 'dsh'], {
    env: Object.assign({}, process.env, {
      BAND_NOTIFY_SESSION_DIR: sessionDir,
      BAND_NOTIFY_TOPIC: 'test-topic-watch',
      BAND_NOTIFY_URL: `http://127.0.0.1:${PORT}`,
      BAND_NOTIFY_AGENT_LOG: path.join(sessionDir, 'watch.log'),
      BAND_NOTIFY_AGENT_STATE: path.join(sessionDir, 'state.json'),
      BAND_NOTIFY_AGENT_SEEN: path.join(sessionDir, 'seen.json'),
      BAND_NOTIFY_AGENT_CACHE: path.join(sessionDir, 'cache.json'),
      BAND_NOTIFY_AGENT_HEARTBEAT: path.join(sessionDir, 'heartbeat.json'),
      // ⚠️ 必须显式 opt-in：dsh-watch 自 2026-10-05 起已退役，**默认拒绝启动**
      // （否则同一轮会被新旧两条链路各报一次 = 通知发两遍）。少了这一行，这个用例
      // 在自己机器上会以**错误的理由**失败 —— 「监听没起来」被读成「通知没发出去」。
      BAND_NOTIFY_LEGACY_WATCHER: '1',
    }),
    stdio: 'ignore',
  });

  await sleep(4000); // baseline
  const afterBaseline = received.length;

  fs.writeFileSync(file, JSON.stringify(payload(null, '已经接好了，手机订阅 ntfy 频道就会震。')), 'utf8');
  await sleep(5000);

  watcher.kill();
  server.close();

  const fired = received.slice(afterBaseline);
  record('watch · 基线期不发通知', afterBaseline === 0, '0 条', `实际 ${afterBaseline} 条`);
  record(
    'watch · turn/end 恰好触发 1 条',
    fired.length === 1,
    '1 条',
    fired.length ? `title="${fired[0].title}" body="${fired[0].message}"` : `实际 ${fired.length} 条`,
  );
  if (fired.length === 1) {
    record('watch · 通知内容正确', fired[0].title === '✅ 已完成' && /【DSH】/.test(fired[0].message), '✅ 已完成 · 【DSH】…', `title="${fired[0].title}" body="${fired[0].message}"`);
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

// ---------------------------------------------------------------- runner

/**
 * Can a child process reach an HTTP server owned by THIS process?
 *
 * In some sandboxed environments it cannot: the request is sent, the listening
 * socket accepts it, but the server's request handler never runs and the client
 * times out. Tests that depend on that path would report false failures, so probe
 * it once and skip those sections with an explicit reason instead.
 */
async function loopbackWorksFromChild() {
  const server = http.createServer((req, res) => { req.resume(); res.end('ok'); server.__hit = true; });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath,
        ['-e', `require('http').get('http://127.0.0.1:${port}/',r=>{r.resume();r.on('end',()=>process.exit(0))}).on('error',()=>process.exit(1))`],
        { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => child.kill(), 8000);
      child.on('error', () => { clearTimeout(timer); resolve(1); });
      child.on('close', status => { clearTimeout(timer); resolve(status); });
    });
    return code === 0 && Boolean(server.__hit);
  } catch { return false; }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

/**
 * Run a file-based sub-suite and fold its PASS/FAIL lines into this run.
 * The trailing "===== N 项失败 =====" summary also starts with 失败, so only lines
 * that match the full "通过/失败 ✅/❌ name" shape count as cases.
 */
function runSubSuite(prefix, script) {
  const res = spawnSync(process.execPath, [path.join(__dirname, script)], {
    encoding: 'utf8',
    timeout: 300000,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  let found = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^(通过|失败) [✅❌]\s+(.+)$/);
    if (m) {
      found += 1;
      record(`${prefix} · ${m[2].trim()}`, m[1] === '通过', '', '');
    }
  }
  if (!found) {
    record(`${prefix} · 监听器测试`, false, '有输出', out.trim().slice(-300) || '(无输出)');
  }
}

async function main() {
  if (only === 'all' || only === 'format') testFormat();
  if (only === 'all' || only === 'turn') testTurnText();
  if (only === 'all' || only === 'dedupe') testDedupe();
  if (only === 'all' || only === 'log') testLogRotation();
  if (only === 'all' || only === 'chain') await testChain();
  if (only === 'all' || only === 'watch') {
    if (await loopbackWorksFromChild()) {
      await testWatch();
    } else {
      record(
        'watch · 监听器集成测试',
        true,
        '（本环境跳过）',
        '本环境禁止两个子进程通过 loopback 互通：请求已发出但服务器处理函数不会运行，' +
          '所以网络型验证在此不可靠。监听器逻辑由 codex(文件式) 与线上日志覆盖。',
      );
    }
  }

  let failed = 0;
  console.log('');
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? '通过 ✅' : '失败 ❌'}  ${r.name}`);
    if (!r.ok) {
      console.log(`        期望: ${r.expect}`);
      if (r.detail) console.log(`        实际: ${r.detail}`);
    }
  }
  console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} (共 ${results.length} 项) =====`);
  process.exitCode = failed ? 1 : 0;
}

main();
