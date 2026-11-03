'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const launchers = ['01-首次配置.cmd', '02-发送测试通知.cmd', '03-开始监听.cmd', '04-查看状态.cmd', '05-停止监听.cmd'];

function copy(source, destination) {
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(destination, name));
  } else fs.copyFileSync(source, destination);
}

function run(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${file}""`], {
      cwd: path.dirname(file), env, windowsHide: true, windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Launcher timed out')); }, 45000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test('numbered CMDs: initialize, deliver, start once, report and stop only their own folder',
  { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'band 双击 release '));
    const env = Object.assign({}, process.env);
    for (const key of Object.keys(env)) if (key.startsWith('BAND_NOTIFY_')) delete env[key];
    const home = path.join(temp, 'home');
    fs.mkdirSync(home);
    Object.assign(env, { USERPROFILE: home, HOME: home, BAND_NOTIFY_NO_UI: '1', BAND_NOTIFY_NO_PAUSE: '1' });
    const roots = ['工具 one', '工具 two'].map(name => path.join(temp, name));
    const stopped = new Set();
    // A real loopback receiver exercises the exact self-test action, without an external push.
    const received = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.setHeader('Content-Type', 'application/json');
        res.end('{"id":"local-self-test"}');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      try {
        for (const root of roots) {
          if (!stopped.has(root) && fs.existsSync(path.join(root, launchers[4]))) {
            const result = await run(path.join(root, launchers[4]), env);
            assert.equal(result.status, 0, result.stderr);
          }
        }
      } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
      }
    });
    for (const root of roots) {
      const app = path.join(root, 'app');
      fs.mkdirSync(app, { recursive: true });
      for (const name of ['src', 'tools', 'notify.js', 'config.example.json']) copy(path.join(ROOT, name), path.join(app, name));
      for (const name of launchers) copy(path.join(ROOT, name), path.join(root, name));
      let result = await run(path.join(root, launchers[0]), env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /首次配置已完成/);
      const cfgFile = path.join(app, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      assert.match(cfg.topic, /^agent-[a-f0-9]{32}$/);
      assert.ok(fs.readFileSync(path.join(app, 'phone-subscription.txt'), 'utf8').includes(cfg.topic));
      // Never print the generated subscription; retain it on repeat setup.
      result = await run(path.join(root, launchers[0]), env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).topic, cfg.topic);
      cfg.ntfyServer = `http://127.0.0.1:${server.address().port}`;
      fs.writeFileSync(cfgFile, JSON.stringify(cfg));
      result = await run(path.join(root, launchers[1]), env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /服务器已接受测试通知/);
      result = await run(path.join(root, launchers[2]), env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /后台监听已启动/);
      result = await run(path.join(root, launchers[2]), env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /已经在运行/);
    }
    assert.equal(received.length, 2);
    let result = await run(path.join(roots[0], launchers[4]), env);
    assert.equal(result.status, 0, result.stderr);
    stopped.add(roots[0]);
    result = await run(path.join(roots[0], launchers[3]), env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /监听没有运行/);
    result = await run(path.join(roots[1], launchers[3]), env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /监听正在运行/);
    result = await run(path.join(roots[1], launchers[4]), env);
    assert.equal(result.status, 0, result.stderr);
    stopped.add(roots[1]);
  });
