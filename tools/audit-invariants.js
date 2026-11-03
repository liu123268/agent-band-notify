#!/usr/bin/env node
'use strict';
/** Read-only checks for adapter ownership, cache serialization, startup paths and runtime invariants. Supports temporary paths for offline mutation tests. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

const engine = require('./agent-watch.js');
const agents = require('../src/agents/index.js');

let fails = 0;
let warns = 0;
const lines = [];

function emit(tag, title, detail) {
  if (tag === 'FAIL') fails += 1;
  if (tag === 'WARN') warns += 1;
  if (QUIET && tag === 'PASS') return;
  lines.push(`[${tag}] ${title}`);
  for (const d of [].concat(detail || [])) {
    if (d) lines.push(`        ${d}`);
  }
}

/**
 * 源码里"真正是代码"的行（滤掉注释），行号保留。注释里的假阳性最容易骗人。
 * ⚠️ 必须连 `*` 开头的**块注释续行**一起滤掉：本文件自己的文档注释里就写着
 * `spawn(process.execPath)` 这串字，不滤就会让审查器**自己把自己告了**。
 */
function codeLines(src) {
  return src
    .split(/\r?\n/)
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    });
}

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '.git') walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/**
 * 把一行里的**字符串/模板字面量**挖空（保留长度与位置），这样 `spawn(...)` 这类
 * 关键词只要出现在引号里就不会被当成调用点。
 *
 * 为什么必须做：本仓库好几处**故意**在字符串里写这串字 —— 测试标题
 * （`test('…不许再直接 spawn(process.execPath)…')`）和断言的失败消息模板。
 * 不挖空它们，审查器就会把**守卫测试自己**列进"违规/允许"清单，
 * 而一份"自己告自己"的报告会让人不再信它。
 */
function stripLiterals(line) {
  let out = '';
  let q = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      if (c === q) q = '';
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * **常驻进程**清单 —— 只有它们受这条不变式约束。
 *
 * 判据来自事故复盘（见 `src/nodebin.js` 头注释）：**只有活得够久、能跨界经历一次运行时
 * 升级的进程才会踩到这个坑。** 测试、`setup.js`、每次一钩的 `hook-handler.js` 都是短命进程，
 * 启动那一刻 `process.execPath` 必然有效，用它是**对的**。
 *
 * 换句话说：把这条规则无差别套到所有文件上，得到的是 9 条假阳性 + 0 条真问题
 * —— 那正是"每次审查都有很多错误"的来源之一。规则必须**只对能踩到它的地方**生效。
 */
const LONG_LIVED = ['tools/agent-watch.js', 'tools/codex-watch.js', 'tools/dsh-watch.js'];

/* ================================================================= *
 * 1. 常驻进程：绝不许 spawn(process.execPath)
 * ================================================================= *
 * 2026-10-09 19:51 事故：`process.execPath` 是**带版本号**的路径，WorkBuddy 升级会把它
 * 改名成 `….deleting.<pid>.<ts>`；监听仍跑在已删的镜像上（Windows 让已加载镜像活着）
 * → 心跳正常、判定照写，但每次 spawn 都 ENOENT = **判定成功、从未发出**。
 */
function checkSubprocess() {
  const files = walk(path.join(ROOT, 'src'), []).filter((f) => f.endsWith('.js'));
  files.push(...walk(path.join(ROOT, 'tools'), []).filter((f) => f.endsWith('.js')));
  files.push(path.join(ROOT, 'notify.js'));

  const offenders = [];
  const allowed = [];
  let sites = 0;
  const missingLongLived = LONG_LIVED.filter((f) => !fs.existsSync(path.join(ROOT, f)));

  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const isLongLived = LONG_LIVED.includes(rel(f));
    for (const { n, line } of codeLines(fs.readFileSync(f, 'utf8'))) {
      // 先把字符串字面量挖空：引号里的 `spawn(process.execPath)`（测试标题、断言模板）
      // 不是调用点。这一步之后仍可能撞上**正则字面量**，由下面的 `prev` 判据兜住。
      const bare = stripLiterals(line);
      const m = bare.match(/\b(spawn|spawnSync|execFile|execFileSync|execSync)\s*\(\s*([^,)]*)/);
      if (!m) continue;
      const prev = m.index > 0 ? bare[m.index - 1] : '';
      if (prev === '/') continue; // 正则字面量里的字（典型：守卫测试自己那条）
      sites += 1;
      if (!/process\.execPath/.test(m[2])) continue;
      const where = `${rel(f)}:${n}  ${line.trim()}`;
      if (isLongLived) offenders.push(where);
      else allowed.push(where);
    }
  }

  const detail = [];
  if (missingLongLived.length) detail.push(`⚠️ 清单里的常驻进程不存在了：${missingLongLived.join(', ')}`);
  if (offenders.length) detail.push(...offenders);
  detail.push(
    `· 受约束：${LONG_LIVED.join(', ')}（全仓 ${sites} 个真实调用点，其中违规 ${offenders.length} 处）`,
  );
  if (allowed.length) {
    detail.push(
      `· 不受约束的短命进程（启动即有效，允许使用）：${allowed.length} 处 —— ` +
        allowed.map((a) => a.split('  ')[0]).join(', '),
    );
  }
  emit(
    offenders.length || missingLongLived.length ? 'FAIL' : 'PASS',
    `常驻进程的子进程调用：违规 ${offenders.length} 处（只有能跨界经历升级的进程才算）`,
    detail,
  );
}

/* ================================================================= *
 * 2. 写死的绝对路径（换用户 / 换盘 / 目录改名就静默失效）
 * ================================================================= */
function checkHardcodedPaths() {
  const targets = [];
  for (const dir of ['', 'tools', 'src']) {
    for (const f of fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)) : []) {
      const p = path.join(ROOT, dir, f);
      if (fs.statSync(p).isFile() && /\.(vbs|cmd|js|json)$/i.test(f)) targets.push(p);
    }
  }
  const re = /[A-Za-z]:[\\/](?:Users|Documents|Projects|develop|Java|dsh-workspace)[\\/][^\s"')]*/;
  const hits = [];
  for (const f of targets) {
    let src;
    try {
      // `.vbs` 是 UTF-16 LE + BOM：按 utf8 读会得到一堆 NUL，正则永远匹配不到（这个坑我踩过）。
      src = /\.vbs$/i.test(f) ? fs.readFileSync(f, 'utf16le') : fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    src.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      // 与 codeLines() 同一套：块注释续行（`*`）也是注释，别把文档里举的**例子路径**告成缺陷。
      if (t.startsWith("'") || t.startsWith('//') || t.startsWith('*')) return;
      const m = line.match(re);
      if (m) hits.push(`${rel(f)}:${i + 1}  ${m[0]}`);
    });
  }
  emit(
    hits.length ? 'WARN' : 'PASS',
    `写死的绝对路径：${hits.length} 处（本机专用可接受，但换用户/换盘就会静默失效）`,
    hits,
  );
}

/* ================================================================= *
 * 3. 注册表不变量（注册了但永远不发声 = 本项目最怕的失败形态）
 * ================================================================= */
function checkRegistry() {
  const list = agents.list();
  const problems = [];

  for (const p of list) {
    const v = agents.validate(p);
    if (v.length) problems.push(`${p && p.id}: ${v.join('；')}`);
  }

  // 去重命名空间 = `${profileId}#${key}`（见 agent-watch.js 的 claim）。
  // id 撞车 = 两个适配器共用命名空间 = 互相顶掉去重 = **同一条通知发两遍或永远不发**。
  const byId = new Map();
  for (const p of list) {
    const id = p && p.id;
    if (byId.has(id)) problems.push(`id 重复：${id}（会共用去重命名空间 → 双发/漏发）`);
    byId.set(id, p);
  }

  emit(problems.length ? 'FAIL' : 'PASS', `注册表：${list.length} 个适配器，契约问题 ${problems.length} 处`, problems);
}

/* ================================================================= *
 * 4. 适配器之间不许"读到同一个文件"（否则同一个轮次被报两次）
 * ================================================================= */
function checkOverlap() {
  const list = agents.list();
  const sets = new Map();
  for (const p of list) {
    let files = [];
    try {
      files = engine.listFiles(p).map((x) => path.resolve(x.file).toLowerCase());
    } catch (err) {
      emit('WARN', `重叠检测：${p.id} 列文件失败（${err.message}）`, []);
      continue;
    }
    sets.set(p.id, new Set(files));
  }

  const collisions = [];
  const ids = [...sets.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = sets.get(ids[i]);
      const b = sets.get(ids[j]);
      const shared = [...a].filter((f) => b.has(f));
      if (shared.length) {
        collisions.push(`${ids[i]} ∩ ${ids[j]} = ${shared.length} 个文件，例：${path.basename(shared[0])}`);
      }
    }
  }
  const detail = collisions.length ? collisions : ids.map((id) => `· ${id}: ${sets.get(id).size} 个文件`);
  emit(
    collisions.length ? 'FAIL' : 'PASS',
    `适配器文件重叠：${ids.length} 个适配器两两互检，冲突 ${collisions.length} 对`,
    detail,
  );
}

/* ================================================================= *
 * 5. 快照型铁律：记住的 ⊇ 读数器还能返回的
 * ================================================================= */
function checkSnapshotCap() {
  const list = agents.list();
  const bad = [];
  let checked = 0;
  for (const p of list) {
    const cap = p.TURN_CAP;
    const win = p.TURN_WINDOW;
    if (cap === undefined && win === undefined) continue;
    checked += 1;
    if (!(cap >= win)) {
      bad.push(`${p.id}: TURN_CAP(${cap}) < TURN_WINDOW(${win}) → 落榜的旧事件下一轮会被当新的重播`);
    }
  }
  // 上限写在共享 reader 里的适配器（mimo）不在 profile 上，直接审那个模块。
  const shared = require('../src/agents/opencode-permissions.js');
  if (Number.isFinite(shared.TURN_CAP) && Number.isFinite(shared.TURN_WINDOW)) {
    checked += 1;
    if (!(shared.TURN_CAP >= shared.TURN_WINDOW)) {
      bad.push(`opencode-permissions: TURN_CAP(${shared.TURN_CAP}) < TURN_WINDOW(${shared.TURN_WINDOW})`);
    }
  }
  emit(
    bad.length ? 'FAIL' : 'PASS',
    `快照型上限：检查了 ${checked} 组（CAP 必须 >= WINDOW）`,
    bad.length ? bad : [`· opencode-permissions CAP=${shared.TURN_CAP} WINDOW=${shared.TURN_WINDOW}`],
  );
}

/* ================================================================= *
 * 6. 文档点了名、磁盘上却没有的东西（"文档说某功能在" ≠ "代码接了它"）
 * ================================================================= */
function checkDocsVsReality() {
  const docs = ['README.md', '它是怎么工作的.md', '.workbuddy/memory/RULES-REFERENCE.md']
    .map((f) => path.join(ROOT, f))
    .filter((f) => fs.existsSync(f));
  const text = docs.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  const referenced = new Set();
  for (const m of text.matchAll(/tools[\\/]([A-Za-z0-9._-]+\.(?:js|vbs|cmd))/g)) referenced.add(m[1]);
  const missing = [...referenced].filter((r) => !fs.existsSync(path.join(ROOT, 'tools', r)));

  // 反向：磁盘上有、但三份文档一次都没提过（只是提示，不一定是问题）。
  const onDisk = fs
    .readdirSync(path.join(ROOT, 'tools'))
    .filter((f) => /\.(js|vbs|cmd)$/i.test(f));
  const undocumented = onDisk.filter((f) => !text.includes(f));
  const info = [];
  if (undocumented.length) info.push(`未被任何文档提到：${undocumented.join(', ')}`);

  emit(
    missing.length ? 'FAIL' : 'PASS',
    `文档 ↔ 现实：文档点名 ${referenced.size} 个 tools 文件，缺失 ${missing.length} 个`,
    missing.length ? missing.map((m) => `· tools/${m} 被文档点名但磁盘上不存在`) : info,
  );
}

/* ================================================================= *
 * 7. `.vbs` 必须是 UTF-16LE + BOM + CRLF
 * ================================================================= *
 * 本环境跑不了 wscript.exe，改完 `.vbs` 没有"跑一下试试"的机会；
 * 而编码错了的症状（双击没反应）与"双击了但没干活"完全同形 —— 所以只能静态卡住。
 */
function checkVbsEncoding() {
  const bad = [];
  const all = walk(path.join(ROOT, 'tools'), []).filter((f) => f.endsWith('.vbs'));
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.vbs'))) all.push(path.join(ROOT, f));
  for (const f of all) {
    const buf = fs.readFileSync(f);
    const bom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    if (!bom) {
      bad.push(`${rel(f)}: 不是 UTF-16LE + BOM（wscript 会按 GBK 解析 → 中文错位/字符串未结束）`);
      continue;
    }
    const text = buf.toString('utf16le');
    const lfOnly = /(?<!\r)\n/.test(text);
    if (lfOnly) bad.push(`${rel(f)}: 有裸 LF（应为 CRLF）`);
  }
  emit(bad.length ? 'FAIL' : 'PASS', `.vbs 编码：检查 ${all.length} 个文件`, bad.length ? bad : all.map((f) => `· ${rel(f)}`));
}

/* ================================================================= *
 * 8. 持久化缓存必须 JSON 安全（Map 会被 JSON.stringify 成 "{}" → 重启后永久静默）
 * ================================================================= */
function checkCacheSafety() {
  const files = walk(path.join(ROOT, 'src'), []).filter((f) => f.endsWith('.js'));
  const hits = [];
  for (const f of files) {
    for (const { n, line } of codeLines(fs.readFileSync(f, 'utf8'))) {
      if (/cache\.set\(/.test(line) && /new (Map|Set)\s*\(/.test(line)) {
        hits.push(`${rel(f)}:${n}  ${line.trim()}`);
      }
    }
  }
  emit(
    hits.length ? 'FAIL' : 'PASS',
    '缓存 JSON 安全：不许把 Map/Set 直接塞进 info.cache',
    hits.length ? hits : ['未发现 `cache.set(…, new Map(…))` 这类写法'],
  );
}

/* ================================================================= *
 * 9. 持久化产物里不许出现"带版本号的 node 路径"
 * ================================================================= *
 * 第 1 条管的是**代码**，这条管的是**已经落盘的配置**。
 *
 * 2026-10-09 审查新发现：同一个坑有第二种形态 —— 不在代码里 spawn，而是把
 * `process.execPath` **写进持久配置**（`~/.codex/config.toml` 的 `notify = [...]`、
 * 启动文件夹里的 `.vbs`）。代码改好了也没用：那份配置会一直指向一个将死的路径，
 * 而且**没有任何入口会去复查它** —— 比代码里那处更隐蔽。
 *
 * 判据：这些产物里凡是出现 `\node\versions\<版本>\` 就 FAIL（应当走回退链 / 只写稳定入口）。
 */
function checkPersistedNodePath() {
  const hits = [];

  // (a) Codex 的 config.toml：notify = [ "<node>", ... ]
  // 路径可用 `BAND_NOTIFY_AUDIT_CODEX_CONFIG` 覆盖（变异实验的缝，见 startupDir 注释）。
  const codexCfg = process.env.BAND_NOTIFY_AUDIT_CODEX_CONFIG || path.join(os.homedir(), '.codex', 'config.toml');
  if (fs.existsSync(codexCfg)) {
    const text = fs.readFileSync(codexCfg, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*notify\s*=/.test(line)) continue;
      if (/[\\/]node[\\/]versions[\\/]/.test(line) || /\.workbuddy/.test(line)) {
        hits.push(`${codexCfg}: notify 行里写死了带版本号的 node → ${line.trim().slice(0, 120)}`);
      }
    }
  }

  // (b) 启动文件夹里的 .vbs / .cmd
  for (const f of startupFiles()) {
    let src;
    try {
      const raw = fs.readFileSync(f);
      src = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
    } catch {
      continue;
    }
    if (/[\\/]node[\\/]versions[\\/]/.test(src)) {
      hits.push(`${f}: 启动脚本里写死了带版本号的 node 路径`);
    }
  }

  emit(
    hits.length ? 'FAIL' : 'PASS',
    `持久化产物里的 node 路径：检查了 config.toml 与启动文件夹，违规 ${hits.length} 处`,
    hits.length ? hits : ['· 未发现带版本号的 node 被写进持久配置'],
  );
}

/**
 * 启动文件夹里现存的文件。**只读**，绝不写、绝不删。
 * 这正是"自启静默失效"事故的现场，值得被审查器持续盯着。
 *
 * 路径可用 `BAND_NOTIFY_AUDIT_STARTUP` 覆盖 —— 那是给**变异实验**用的缝：
 * 一条检查如果永远没被看见跳闸，就等于没有检查（本项目吃过这个亏）。
 * 测试用临时目录造假现场，绝不碰真的启动文件夹。
 */
function startupDir() {
  return (
    process.env.BAND_NOTIFY_AUDIT_STARTUP ||
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  );
}

function startupFiles() {
  try {
    return fs.readdirSync(startupDir()).map((f) => path.join(startupDir(), f));
  } catch {
    return [];
  }
}

/* ================================================================= *
 * 10. 一个软件只能有一个所有者 —— 自启也只能有一套
 * ================================================================= *
 * 两套自启同时存在 = 同一个轮次被两个进程各报一次 = **每条通知发两遍**。
 * 旧链路的 `.vbs` 只要还躺在启动文件夹里，登录时就会再拉起一个监听 ——
 * 代码里的"拒绝启动"门只在没有 `LEGACY_WATCHER=1` 时生效，而自启脚本里
 * 恰好可能写着这个变量。**所以必须查现场，不能只查代码。**
 */
function checkSingleOwnerAutostart() {
  const problems = [];

  const legacyVbs = startupFiles().filter((f) => /band-notify-.*-watch\.vbs$/i.test(path.basename(f)));
  for (const f of legacyVbs) {
    problems.push(`启动文件夹里残留旧链路自启：${f}（会导致每条通知发两遍）`);
  }

  // 计划任务与启动文件夹两套只能有一套。
  // 任务路径同样有测试缝（`BAND_NOTIFY_AUDIT_TASK`），好在变异实验里造假现场。
  const taskPath =
    process.env.BAND_NOTIFY_AUDIT_TASK || 'C:\\Windows\\System32\\Tasks\\band-notify-watchers';
  const taskExists = fs.existsSync(taskPath);
  if (taskExists && legacyVbs.length) {
    problems.push('计划任务与启动文件夹两套自启同时存在 → 同秒并发，每条发两遍');
  }

  const routes = [];
  routes.push(`计划任务 band-notify-watchers：${taskExists ? '已注册' : '未注册'}`);
  routes.push(`启动文件夹旧链路脚本：${legacyVbs.length} 个`);
  emit(
    problems.length ? 'FAIL' : 'PASS',
    `自启唯一性：${taskExists ? 1 : 0} 套在册（计划任务 / 启动文件夹只能有一套）`,
    problems.length ? problems.concat(routes) : routes,
  );
}

/* ================================================================= *
 * 11. 已退役的自启安装器必须"拒绝"，而不是"装一套并行的"
 * ================================================================= *
 * 这是上一条的**代码侧回归锁**：退役链路里的 `--install` 只要还能写出 `.vbs`，
 * 现场就会慢慢长出第二套自启（今天审查就发现它俩原封不动地留着）。
 * 现场检查（第 10 条）会拦下来，但更好的做法是让它压根写不出来。
 */
function checkRetiredInstallers() {
  const targets = ['tools/codex-watch.js', 'tools/dsh-watch.js'];
  const bad = [];
  for (const t of targets) {
    const p = path.join(ROOT, t);
    if (!fs.existsSync(p)) {
      bad.push(`${t} 不存在了（清单过期，请更新本检查）`);
      continue;
    }
    const code = codeLines(fs.readFileSync(p, 'utf8')).map((x) => x.line).join('\n');
    if (/\bwriteFileSync\s*\(/.test(code) && /band-notify-.*-watch\.vbs/.test(code)) {
      bad.push(`${t}: 还能往启动文件夹写自启 .vbs（应改为直接拒绝）`);
    }
  }
  emit(
    bad.length ? 'FAIL' : 'PASS',
    `退役安装器：${targets.length} 个旧链路的 --install 都必须拒绝`,
    bad.length ? bad : targets.map((t) => `· ${t} 不再写自启`),
  );
}

/* ================================================================= */
checkSubprocess();
checkHardcodedPaths();
checkRegistry();
checkOverlap();
checkSnapshotCap();
checkDocsVsReality();
checkVbsEncoding();
checkCacheSafety();
checkPersistedNodePath();
checkSingleOwnerAutostart();
checkRetiredInstallers();

console.log(lines.join('\n'));
console.log('');
console.log('='.repeat(56));
console.log(`不变式审查：${fails} 项 FAIL，${warns} 项 WARN`);
console.log('='.repeat(56));
process.exit(fails ? 1 : 0);
