#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { loadConfig, isPlaceholderTopic } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');
const WATCHER = path.join(ROOT, 'tools', 'agent-watch.js');
const INFO = path.join(ROOT, 'phone-subscription.txt');
const LOCK = path.join(ROOT, 'logs', 'controller.lock');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 40000 });
  if (result.error || result.status !== 0) throw new Error((result.stderr || result.error?.message || '运行失败').trim());
  return result.stdout;
}

// The process query and stop share one exact script-path guard. No path is
// interpolated into shell source, and other project folders are never matched.
function ownedProcesses(stop = false) {
  if (process.platform !== 'win32') throw new Error('双击入口支持 Windows。其他环境请使用源码命令。');
  const script = `
$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::Combine($env:BAND_NOTIFY_CONTROL_ROOT, 'tools', 'agent-watch.js')
$pattern = '(?i)(?:^|[\\s\"])' + [regex]::Escape($expected) + '(?=[\\s\"]|$)'
$matches = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine -match $pattern
})
foreach ($item in $matches) {
  if ($env:BAND_NOTIFY_CONTROL_STOP -eq '1') { Stop-Process -Id $item.ProcessId -ErrorAction Stop }
}
ConvertTo-Json -Compress -InputObject @($matches | ForEach-Object { [int]$_.ProcessId })
`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: Object.assign({}, process.env, { BAND_NOTIFY_CONTROL_ROOT: ROOT, BAND_NOTIFY_CONTROL_STOP: stop ? '1' : '0' }),
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  if (result.error || result.status !== 0) throw new Error('无法读取本目录的监听进程。请保留此窗口并查看错误，或按文档使用前台命令。');
  const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    if (fs.existsSync(LOCK)) {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { owner = null; }
      let alive = false;
      if (owner && Number.isInteger(owner.pid)) { try { process.kill(owner.pid, 0); alive = true; } catch {} }
      if (!alive && Date.now() - fs.statSync(LOCK).mtimeMs > 30000) fs.unlinkSync(LOCK);
    }
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fs.closeSync(fd);
    return () => {
      try {
        const owner = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
        if (owner.pid === process.pid) fs.unlinkSync(LOCK);
      } catch {}
    };
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('另一个启动或停止操作正在进行，请稍等后再试。');
    throw error;
  }
}

async function main() {
  const action = process.argv[2];
  if (action === 'setup') {
    const output = runNode([path.join(ROOT, 'tools', 'setup.js')]);
    const cfg = loadConfig();
    if (isPlaceholderTopic(cfg.topic)) throw new Error('频道未配置成功，请查看上方提示。');
    const text = [
      '手机 ntfy 订阅信息（只给自己看，不要公开）', '',
      `服务器地址：${cfg.ntfyServer}`,
      `主题名称 / Topic：${cfg.topic}`, '',
      '在手机 ntfy 点 + 添加订阅：',
      '1. 服务器填上面的服务器地址；保持默认时是 https://ntfy.sh。',
      '2. 主题名称填上面 agent- 开头的整串文字，不加引号，不填写完整网址。',
      '3. 点击订阅，再在手环配套 App 中允许转发 ntfy 通知。',
      '4. 回到电脑，双击 02-发送测试通知.cmd，查看手机和手环。', '',
      `本机配置文件：${cfg.__source || path.join(ROOT, 'config.json')}`,
      '再次运行首次配置会保留当前频道，不会要求重新订阅。', '',
    ].join('\r\n');
    fs.writeFileSync(INFO, '\uFEFF' + text, 'utf8');
    console.log('首次配置已完成。手机订阅需要的两项信息如下：\n');
    console.log(`服务器：${cfg.ntfyServer}`);
    console.log(`主题名称：${cfg.topic}`);
    console.log(`\n这些信息也保存在：${INFO}`);
    console.log('手机配置完成后，双击“02-发送测试通知.cmd”。');
    if (process.platform === 'win32' && process.env.BAND_NOTIFY_NO_UI !== '1') {
      const editor = spawn('notepad.exe', [INFO], { detached: true, stdio: 'ignore' });
      editor.on('error', () => console.log('未能打开记事本，请手动打开上面的订阅信息文件。'));
      editor.unref();
    }
    if (process.env.BAND_NOTIFY_DEBUG) process.stderr.write(output);
    return;
  }
  if (action === 'test') {
    if (isPlaceholderTopic(loadConfig().topic)) throw new Error('请先双击“01-首次配置.cmd”。');
    const output = runNode([path.join(ROOT, 'notify.js'), '--test', '--json']);
    let result;
    try { result = JSON.parse(output); } catch { throw new Error('没有收到发送结果。请检查配置是否启用，或查看 logs/notify.log。'); }
    if (!result.ok) throw new Error(`测试未发送成功：${result.error || '请检查网络和配置'}`);
    console.log('服务器已接受测试通知。');
    console.log('现在请看手机是否出现 ntfy 通知，再看手环是否振动。');
    console.log('两边都正常后，双击“03-开始监听.cmd”。');
    return;
  }
  if (!['start', 'status', 'stop'].includes(action)) throw new Error('使用 setup、test、start、status 或 stop。');
  if (action === 'status') {
    const ids = ownedProcesses();
    console.log(ids.length ? `监听正在运行，进程：${ids.join(', ')}` : '当前目录的监听没有运行。需要提醒时请双击“03-开始监听.cmd”。');
    console.log(`程序目录：${ROOT}`);
    return;
  }
  const release = acquireLock();
  try {
    if (action === 'stop') {
      const ids = ownedProcesses(true);
      console.log(ids.length ? '本目录的后台监听已停止。之后的任务不会再提醒。' : '本目录没有正在运行的后台监听。');
      console.log('已注册的开机启动任务需另外禁用，具体见 README。');
      return;
    }
    if (isPlaceholderTopic(loadConfig().topic)) throw new Error('请先双击“01-首次配置.cmd”，并完成手机订阅。');
    const existing = ownedProcesses();
    if (existing.length) { console.log('监听已经在运行，不会重复启动。'); return; }
    const child = spawn(process.execPath, [WATCHER], {
      cwd: ROOT, env: process.env, detached: true, stdio: 'ignore', windowsHide: true,
    });
    let error;
    child.on('error', value => { error = value; });
    child.unref();
    const heartbeat = process.env.BAND_NOTIFY_AGENT_HEARTBEAT || path.join(ROOT, 'logs', 'agent-watch.heartbeat.json');
    for (let i = 0; i < 60; i++) {
      if (error) throw error;
      await sleep(100);
      try {
        const data = JSON.parse(fs.readFileSync(heartbeat, 'utf8'));
        if (data.beats && data.beats[child.pid]) {
          console.log('后台监听已启动，这个窗口可以关闭。');
          console.log('现在去支持的软件里发起一个新任务，完成后会自动提醒。');
          console.log('关掉此窗口不会停止后台监听；要停止请双击“05-停止监听.cmd”。');
          return;
        }
      } catch {}
    }
    throw new Error('还未确认监听心跳，请双击“04-查看状态.cmd”并查看 logs/agent-watch.log。');
  } finally { release(); }
}

main().catch(error => {
  console.error(`\n未完成：${error.message}`);
  console.error('请查看 README 的对应步骤，不需要重复下载或删除自己的频道。');
  process.exitCode = 1;
});
