'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

function run(args, extra = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 35000, windowsHide: true,
    env: Object.assign({}, process.env, extra),
  });
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'band portable 测试 '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('environment overrides apply without a local config file', () => {
  const result = run(['-e', 'console.log(JSON.stringify(require("./src/config").loadConfig()))'], {
    BAND_NOTIFY_TOPIC: 'new-machine-topic', BAND_NOTIFY_SERVER: 'http://127.0.0.1:9999', BAND_NOTIFY_MIN_SECONDS: '17',
  });
  assert.equal(result.status, 0);
  const cfg = JSON.parse(result.stdout);
  assert.equal(cfg.topic, 'new-machine-topic');
  assert.equal(cfg.ntfyServer, 'http://127.0.0.1:9999');
  assert.equal(cfg.minSeconds, 17);
});

test('retired entry points cannot launch a duplicate watcher', () => {
  for (const file of ['codex-watch.js', 'dsh-watch.js']) {
    const result = run([path.join('tools', file), '--install'], { BAND_NOTIFY_LEGACY_WATCHER: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent-watch\.js/);
  }
});

test('fresh setup creates a private topic and retains it on a second run', t => {
  const dir = temp(t);
  const config = path.join(dir, '配置 with spaces.json');
  let result = run(['tools/setup.js', '--config', config]);
  assert.equal(result.status, 0, result.stderr);
  const first = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.match(first.topic, /^agent-[a-f0-9]{32}$/);
  result = run(['tools/setup.js', '--config', config]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).topic, first.topic);
  assert.ok(fs.existsSync(config + '.bak'));
});

test('setup does not silently replace malformed user configuration', t => {
  const dir = temp(t);
  const config = path.join(dir, 'bad.json');
  fs.writeFileSync(config, '{broken');
  const result = run(['tools/setup.js', '--config', config]);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(config, 'utf8'), '{broken');
});

test('setup never rewrites Codex agent settings', t => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, '.codex'));
  const agentConfig = path.join(dir, '.codex', 'config.toml');
  fs.writeFileSync(agentConfig, 'model = "unchanged"\n');
  const result = run(['tools/setup.js', '--codex'], { USERPROFILE: dir, HOME: dir });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(agentConfig, 'utf8'), 'model = "unchanged"\n');
});

test('a fresh checkout works from a directory containing spaces and Chinese', t => {
  const dir = temp(t);
  const copy = path.join(dir, '工具 folder');
  fs.mkdirSync(copy);
  for (const name of ['src', 'notify.js', 'config.example.json']) {
    fs.cpSync(path.join(ROOT, name), path.join(copy, name), { recursive: true });
  }
  const result = run([path.join(copy, 'notify.js'), '--dry-run', '--agent', 'Demo', '--state', 'done',
    '--conversation', '测试会话', '--preview', '任务已完成'], { BAND_NOTIFY_TOPIC: 'portable-test-topic' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.notice.title, '✅ 已完成');
  assert.equal(output.notice.body, '【Demo】测试会话 · 任务已完成');
  assert.equal(output.payload.topic, 'portable-test-topic');
});

test('real CLI delivers UTF-8 JSON and token to a local ntfy-compatible receiver', async t => {
  const dir = temp(t);
  let received;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received = { method: req.method, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), auth: req.headers.authorization };
      res.setHeader('Content-Type', 'application/json');
      res.end('{"id":"test-accepted"}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ ntfyServer: `http://127.0.0.1:${server.address().port}`,
    topic: 'local-cli-test', token: 'local-test-token', title: '{stateEmoji} {stateLabel}',
    body: '【{software}】{conversation} · {summary}', minSeconds: 0 }));
  const result = await new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    for (const key of ['BAND_NOTIFY_URL', 'BAND_NOTIFY_SERVER', 'BAND_NOTIFY_TOPIC', 'BAND_NOTIFY_TOKEN']) delete env[key];
    const child = spawn(process.execPath, [path.join(ROOT, 'notify.js'), '--config', config, '--json', '--force',
      '--agent', 'Demo', '--state', 'done', '--conversation', '示例任务', '--preview', '本地链路完成'],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI receiver test timed out')); }, 20000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(received.method, 'POST');
  assert.equal(received.auth, 'Bearer local-test-token');
  assert.equal(received.body.topic, 'local-cli-test');
  assert.equal(received.body.message, '【Demo】示例任务 · 本地链路完成');
});
