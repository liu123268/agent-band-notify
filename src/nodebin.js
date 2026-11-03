'use strict';
/** Resolve an existing Node executable for notification child processes, including recovery when an application-managed runtime has been replaced. */
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 候选 node，按"稳定 → 兜底"排序。`execPath` 只是**第一个候选**，不是唯一答案。
 */
function nodeBinCandidates(execPath) {
  const list = [execPath];
  const versions = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  // `current` 是稳定的 junction，优先；再退到任何真带 node.exe 的版本目录。
  list.push(path.join(versions, 'current', 'node.exe'));
  try {
    for (const name of fs.readdirSync(versions)) {
      // ⚠️ 跳过升级时改名出来的**暂存目录**（`…\.22.22.2-3.deleting.<pid>.<ts>`）：
      // 旧名字已经没了（所以 spawn ENOENT），可暂存目录里的 node.exe 还在。
      if (name.startsWith('.') || name.includes('.deleting.')) continue;
      list.push(path.join(versions, name, 'node.exe'));
    }
  } catch {
    /* 没有托管运行时：继续往下退 */
  }
  // DSH runtime —— 与 `start-agent-watch.cmd` / `*.vbs` 的第二档一致。
  list.push(
    path.join(
      os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe',
    ),
  );
  return list;
}

let nodeBinCache = '';

/**
 * 回退链里第一个**真的存在**的 node；最后一档交给 PATH（返回字符串 `'node'`）。
 *
 * 每次调用都会**重新确认文件存在**，所以"运行到一半被删"也只会影响正在飞的那一条，
 * 下一条自己就好了。
 *
 * @param {string} [preferred] 测试缝：传一条坏路径时它**替代** `process.execPath`，
 *   这样才会真的走完整条回退链（否则 execPath 在第一个候选就把答案给了，链子根本没被测到）。
 */
function resolveNodeBin(preferred) {
  if (preferred === undefined && nodeBinCache && fs.existsSync(nodeBinCache)) return nodeBinCache;
  const list = nodeBinCandidates(preferred === undefined ? process.execPath : preferred);
  for (const c of list) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) {
        if (preferred === undefined) nodeBinCache = c;
        return c;
      }
    } catch {
      /* 这个候选读不到：试下一个 */
    }
  }
  if (preferred === undefined) nodeBinCache = '';
  return 'node';
}

module.exports = { resolveNodeBin, nodeBinCandidates };
