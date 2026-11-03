// .vbs 静态自检：编码 / 换行 / 引号配平 / 块结构配对。
//
// 为什么需要这个：
//   本环境跑不了 wscript.exe / cscript.exe（安全策略判为 LOLBin），
//   所以改完 .vbs 之后没有任何"跑一下试试"的机会 —— 一个漏写的
//   End If 或一个错位的中文字符，症状都是"双击没反应"，而且
//   和"双击了但里面没干活"完全分不清。
//   这里把能静态查出来的问题全查出来，把 wscript 那一步的赌注降到最低。
//
//   ⚠ 它**不能**替代真正的语法检查。它只保证"块配对和引号看起来对"，
//     查不出拼错的属性名、传错参数个数这类问题。改完 .vbs 仍应让用户
//     双击一次，并从它写出的日志确认结果。
//
// 用法:
//   node tools/check-vbs.js                # 检查项目里全部 .vbs
//   node tools/check-vbs.js 一键启动.vbs    # 只查指定文件
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APOS = String.fromCharCode(39); // '
const QUOTE = String.fromCharCode(34); // "

function listVbs() {
  const out = [];
  for (const dir of [ROOT, path.join(ROOT, 'tools')]) {
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.vbs')) out.push(path.join(dir, f));
    }
  }
  return out;
}

// 去掉一行里的字符串字面量和注释，只留"语法骨架"。
function skeleton(raw) {
  let out = '';
  let inStr = false;
  let inComment = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inComment) break;
    if (inStr) {
      if (c === QUOTE) inStr = false;
      continue;
    }
    if (c === QUOTE) { inStr = true; continue; }
    if (c === APOS) { inComment = true; break; }
    out += c;
  }
  return out.trim();
}

// 单行 If（"If ... Then <语句>"）不产生块，不需要 End If。
function isBlockIf(code) {
  if (!/^If\s/i.test(code)) return false;
  if (!/\sThen\b/i.test(code)) return false;
  return /\bThen\s*$/i.test(code);
}

// ⚠ 这里没有 `If` 这一项，是有意的。
// 判断 If 是"开一个块"还是"单行语句"只能靠"行尾是不是 Then"，
// 所以它由上面的 isBlockIf() 单独处理，不能再放一条通用的
// /^If\s.+$/ 进来 —— 那种规则会把单行 `If x Then y = 1` 也算成
// 开块，于是每个单行 If 都贡献一个假的 +1。
// （这个 bug 真的写出来过：watchdog.vbs 里正好 6 个单行 If，
//   工具就报"If 不平衡 If(+6)"，而实际逐行追踪 depth = 0。
//   教训和 turn-text 那次一样：规则报错时先量规则本身。）
const OPENERS = [
  [/^For\s.+$/i, 'For'],
  [/^Do\b.*$/i, 'Do'],
  [/^Select\s+Case\b/i, 'Select Case'],
  [/^(Public\s+|Private\s+)?Function\b/i, 'Function'],
  [/^(Public\s+|Private\s+)?Sub\b/i, 'Sub'],
  [/^With\b/i, 'With'],
];
const CLOSERS = [
  [/^End\s+If\b/i, 'If'],
  [/^Next\b/i, 'For'],
  [/^Loop\b/i, 'Do'],
  [/^End\s+Select\b/i, 'Select Case'],
  [/^End\s+Function\b/i, 'Function'],
  [/^End\s+Sub\b/i, 'Sub'],
  [/^End\s+With\b/i, 'With'],
];

function check(file) {
  const raw = fs.readFileSync(file);
  let enc;
  let text;
  if (raw[0] === 0xff && raw[1] === 0xfe) {
    enc = 'UTF-16 LE + BOM';
    text = raw.toString('utf16le');
  } else if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    enc = 'UTF-8 + BOM';
    text = raw.toString('utf8');
  } else {
    enc = 'UTF-8 / ANSI（无 BOM）';
    text = raw.toString('utf8');
  }
  text = text.replace(/^\uFEFF/, '');

  const crlf = (text.match(/\r\n/g) || []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) || []).length;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  const lines = text.split('\r\n');

  const problems = [];
  const depth = {};
  const bumps = (k, d) => { depth[k] = (depth[k] || 0) + d; };

  lines.forEach((rawLine, idx) => {
    const no = idx + 1;
    const code = skeleton(rawLine);
    if (!code) return;

    // 引号配平（只看代码部分；注释里的引号不算）
    const q = (code.split(QUOTE).length - 1);
    if (q % 2 !== 0 && !rawLine.trimEnd().endsWith('_')) {
      problems.push(`第 ${no} 行引号数为奇数(${q})，疑似未闭合字符串: ${code.slice(0, 70)}`);
    }

    if (isBlockIf(code)) { bumps('If', 1); return; }

    for (const [re, key] of CLOSERS) {
      if (re.test(code)) { bumps(key, -1); return; }
    }
    for (const [re, key] of OPENERS) {
      if (re.test(code)) { bumps(key, 1); return; }
    }
  });

  const bad = Object.keys(depth).filter((k) => depth[k] !== 0);

  console.log('=== ' + path.relative(ROOT, file));
  console.log('  编码: ' + enc + '   行数: ' + lines.length +
    '   CRLF: ' + crlf + (loneLf ? '   ⚠ 裸 LF: ' + loneLf : ''));
  console.log('  非 ASCII 字符: ' + nonAscii +
    (enc.startsWith('UTF-16') ? '（UTF-16 下安全）' : nonAscii ? '  ⚠ 无 BOM 时 wscript 会按 GBK 解析！' : ''));
  console.log('  块配对: ' + (bad.length
    ? '✗ 不平衡 -> ' + bad.map((k) => k + '(' + depth[k] + ')').join(', ')
    : '全部平衡 ✓'));
  problems.forEach((p) => console.log('  ✗ ' + p));
  console.log('');
  return bad.length + problems.length;
}

const args = process.argv.slice(2);
const files = args.length ? args.map((a) => path.resolve(a)) : listVbs();
let total = 0;
for (const f of files) {
  if (!fs.existsSync(f)) { console.log('=== ' + f + '\n  ✗ 文件不存在\n'); total++; continue; }
  total += check(f) || 0;
}
console.log(total ? '共 ' + total + ' 处可疑 —— 逐条核对后再交给用户双击。' : '全部通过 ✓（注意：这仍不等于能跑通，只是把静态能查的查完了）');
process.exitCode = total ? 1 : 0;
