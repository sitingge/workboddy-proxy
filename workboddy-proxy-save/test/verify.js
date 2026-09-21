#!/usr/bin/env node
/*
 * verify.js —— wb-relay 的端到端验证（不依赖真实 WorkBuddy CLI / 账号）
 *
 * 做法：起两个 wb-relay 实例，CLI 都指向 fake-cli.js —
 *   实例 A（端口 8801）：正常模式
 *   实例 B（端口 8802）：伪装模式（disguise.enabled）
 * 然后跑三组验证：
 *   1. 功能验证  —— Anthropic 流式/非流式、OpenAI 流式/非流式、快照/整段兜底、伪装检查
 *   2. 实时性验证 —— 记录每个 SSE 块到达时刻，确认思考/正文是匀速抵达而非整块弹出
 *   3. 语法检查  —— node --check wb-relay.js
 *
 * 用法：node test/verify.js    （在 wb-relay.js 所在目录下跑；会自动起停服务）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const FAKE_CLI = path.join(__dirname, 'fake-cli.js');
const PORT_A = 8801; // 正常
const PORT_B = 8802; // 伪装

const failures = [];
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` —— ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ' —— ' + detail : ''}`); }
}

/* ---------------- 配置与进程 ---------------- */

function writeConfig(port, disguise) {
  const cfg = {
    listen: { host: '127.0.0.1', port },
    apiKeys: [],
    cli: { cwd: path.join(__dirname, 'workspace'), verbose: false, allowTools: false, partialMessages: true },
    sites: { mode: 'cn', cn: { cliJs: FAKE_CLI, home: '', model: '' }, intl: { cliJs: '', home: '', model: '' } },
    sessions: { maxWorkers: 4, idleMs: 60000, turnTimeoutMs: 30000, keepAliveHintMs: 15000, prewarm: false },
    models: ['workbuddy-auto'],
  };
  if (disguise) cfg.disguise = { enabled: true, serverHeader: '' };
  const file = path.join(__dirname, disguise ? 'config.fake-disguise.json' : 'config.fake.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return file;
}

function startRelay(configFile) {
  const child = spawn(process.execPath, [path.join(APP_DIR, 'wb-relay.js'), '--config', configFile], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[relay-stderr] ' + d));
  return child;
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// 收 SSE：每个 data 帧到达时回调 {event, obj, at}，流结束时 resolve 全部帧
function postSSE(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), accept: 'text/event-stream' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = '';
          const dataLines = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue; // 心跳注释行
          const raw = dataLines.join('\n');
          let obj = null;
          try { obj = JSON.parse(raw); } catch { obj = raw; }
          frames.push({ event, obj, at: Date.now() });
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, frames }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function waitReady(port, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await getJson(port, '/health');
      if (r.status === 200) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`端口 ${port} 的服务一直没起来`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ---------------- 各组验证 ---------------- */

// 实例 A：Anthropic 流式 —— 事件序列、签名、思考在正文前、实时性
async function testAnthropicStream() {
  console.log('\n[A1] Anthropic /v1/messages 流式');
  const r = await postSSE(PORT_A, '/v1/messages', {
    model: 'workbuddy-auto', max_tokens: 1024, stream: true,
    messages: [{ role: 'user', content: '你好，介绍一下你自己' }],
  });
  check('HTTP 200', r.status === 200, `status=${r.status}`);
  const names = r.frames.map((f) => (f.obj && f.obj.type) || f.event);
  check('message_start 开头', names[0] === 'message_start', names.slice(0, 3).join(','));
  check('message_stop 收尾', names[names.length - 1] === 'message_stop', names.slice(-2).join(','));

  const tStart = r.frames.find((f) => f.obj && f.obj.type === 'content_block_start' && f.obj.content_block && f.obj.content_block.type === 'thinking');
  const xStart = r.frames.find((f) => f.obj && f.obj.type === 'content_block_start' && f.obj.content_block && f.obj.content_block.type === 'text');
  check('思考块开始（index 0）', Boolean(tStart) && tStart.obj.index === 0);
  check('正文块开始（index 1）', Boolean(xStart) && xStart.obj.index === 1, xStart ? `index=${xStart.obj.index}` : '没有正文块');

  const thinkDeltas = r.frames.filter((f) => f.obj && f.obj.type === 'content_block_delta' && f.obj.delta && f.obj.delta.type === 'thinking_delta');
  const sigDeltas = r.frames.filter((f) => f.obj && f.obj.type === 'content_block_delta' && f.obj.delta && f.obj.delta.type === 'signature_delta');
  const textDeltas = r.frames.filter((f) => f.obj && f.obj.type === 'content_block_delta' && f.obj.delta && f.obj.delta.type === 'text_delta');
  check('有思考增量', thinkDeltas.length > 0);
  check('签名实时转发（>=1 次 signature_delta）', sigDeltas.length > 0);
  const sigAll = sigDeltas.map((f) => f.obj.delta.signature).join('');
  check('签名完整（sig- 开头）', sigAll.startsWith('sig-'), sigAll);
  check('有正文增量', textDeltas.length > 0);

  const thinkText = thinkDeltas.map((f) => f.obj.delta.thinking).join('');
  const answer = textDeltas.map((f) => f.obj.delta.text).join('');
  check('思考内容非空', thinkText.length > 5, `len=${thinkText.length}`);
  check('正文内容非空', answer.length > 3, answer);

  // 顺序：所有思考增量都在正文增量之前
  if (thinkDeltas.length && textDeltas.length) {
    const lastThink = r.frames.indexOf(thinkDeltas[thinkDeltas.length - 1]);
    const firstText = r.frames.indexOf(textDeltas[0]);
    check('思考严格在正文之前', lastThink < firstText);
  }
  // 事件序列里 content_block_stop 成对出现
  const stops = r.frames.filter((f) => f.obj && f.obj.type === 'content_block_stop');
  check('两个 content_block_stop（思考+正文）', stops.length === 2, `stops=${stops.length}`);
  const mdelta = r.frames.find((f) => f.obj && f.obj.type === 'message_delta');
  check('message_delta 带 stop_reason', Boolean(mdelta) && mdelta.obj.delta.stop_reason === 'end_turn');

  // 实时性：逐字模式下思考增量应该在一段时间里陆续到达，不是一瞬全到
  if (thinkDeltas.length > 3) {
    const span = thinkDeltas[thinkDeltas.length - 1].at - thinkDeltas[0].at;
    check('思考是匀速抵达（跨度 > 40ms）', span > 40, `span=${span}ms, n=${thinkDeltas.length}`);
  }
}

// 实例 A：Anthropic 非流式 —— content 是数组，thinking 块带 signature
async function testAnthropicNonStream() {
  console.log('\n[A2] Anthropic /v1/messages 非流式');
  const r = await postJson(PORT_A, '/v1/messages', {
    model: 'workbuddy-auto', max_tokens: 1024,
    system: '你是一个测试助手',
    messages: [{ role: 'user', content: '非流式测试' }],
  });
  check('HTTP 200', r.status === 200, `status=${r.status} raw=${(r.raw || '').slice(0, 200)}`);
  const b = r.body || {};
  check('type=message / role=assistant', b.type === 'message' && b.role === 'assistant');
  check('content 是数组', Array.isArray(b.content));
  if (Array.isArray(b.content)) {
    const th = b.content.find((c) => c.type === 'thinking');
    const tx = b.content.find((c) => c.type === 'text');
    check('有 thinking 块且带 signature', Boolean(th) && typeof th.signature === 'string' && th.signature.startsWith('sig-'), th && th.signature);
    check('有 text 块且非空', Boolean(tx) && tx.text.length > 3, tx && tx.text);
    check('thinking 块在 text 块之前', b.content.indexOf(th) < b.content.indexOf(tx));
  }
  check('stop_reason=end_turn', b.stop_reason === 'end_turn');
  check('usage 有 output_tokens', Boolean(b.usage) && b.usage.output_tokens === 20, JSON.stringify(b.usage));
}

// 实例 A：OpenAI 流式 —— reasoning_content 在 content 之前
async function testOpenAIStream() {
  console.log('\n[A3] OpenAI /v1/chat/completions 流式');
  const r = await postSSE(PORT_A, '/v1/chat/completions', {
    model: 'workbuddy-auto', stream: true,
    messages: [{ role: 'user', content: '流式思维链测试' }],
  });
  check('HTTP 200', r.status === 200, `status=${r.status}`);
  const chunks = r.frames.map((f) => f.obj).filter((o) => o && typeof o === 'object');
  const deltas = chunks.flatMap((o, i) => ((o.choices && o.choices[0] && o.choices[0].delta) ? [{ delta: o.choices[0].delta, at: r.frames[i].at }] : []));
  const reasoning = deltas.filter((d) => typeof d.delta.reasoning_content === 'string' && d.delta.reasoning_content.length > 0);
  const contents = deltas.filter((d) => typeof d.delta.content === 'string' && d.delta.content.length > 0);
  check('有 reasoning_content 增量', reasoning.length > 0);
  check('有 content 增量', contents.length > 0);
  const thinkText = reasoning.map((d) => d.delta.reasoning_content).join('');
  const answer = contents.map((d) => d.delta.content).join('');
  check('思考内容非空', thinkText.length > 5, `len=${thinkText.length}`);
  check('正文内容非空', answer.length > 3, answer);
  if (reasoning.length && contents.length) {
    check('思考严格在正文之前', reasoning[reasoning.length - 1].at <= contents[0].at);
    const span = reasoning[reasoning.length - 1].at - reasoning[0].at;
    check('思考匀速抵达（跨度 > 40ms）', span > 40, `span=${span}ms, n=${reasoning.length}`);
  }
  const done = r.frames.some((f) => f.obj === '[DONE]');
  check('以 [DONE] 结束', done);
  const finish = chunks.some((o) => o.choices && o.choices[0] && o.choices[0].finish_reason === 'stop');
  check('finish_reason=stop', finish);
}

// 实例 A：OpenAI 非流式 —— message.reasoning_content
async function testOpenAINonStream() {
  console.log('\n[A4] OpenAI /v1/chat/completions 非流式');
  const r = await postJson(PORT_A, '/v1/chat/completions', {
    model: 'workbuddy-auto',
    messages: [{ role: 'user', content: '非流式思维链测试' }],
  });
  check('HTTP 200', r.status === 200, `status=${r.status} raw=${(r.raw || '').slice(0, 200)}`);
  const msg = r.body && r.body.choices && r.body.choices[0] && r.body.choices[0].message;
  check('有 message', Boolean(msg));
  if (msg) {
    check('message.content 非空', typeof msg.content === 'string' && msg.content.length > 3, msg.content);
    check('message.reasoning_content 非空', typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 5, `len=${msg.reasoning_content && msg.reasoning_content.length}`);
  }
  check('usage 齐全', Boolean(r.body && r.body.usage && r.body.usage.total_tokens === 30), JSON.stringify(r.body && r.body.usage));
}

// 实例 A：整段思考（bigthink）—— 匀速器把它切成小片吐
async function testBigThinkPaced() {
  console.log('\n[A5] 整段思考 → 匀速切吐（bigthink）');
  const r = await postSSE(PORT_A, '/v1/chat/completions', {
    model: 'workbuddy-auto', stream: true,
    messages: [{ role: 'user', content: 'bigthink 整段思考测试' }],
  });
  const deltas = r.frames.map((f) => ({ o: f.obj, at: f.at }))
    .filter((x) => x.o && x.o.choices && x.o.choices[0] && x.o.choices[0].delta);
  const reasoning = deltas.filter((x) => typeof x.o.choices[0].delta.reasoning_content === 'string' && x.o.choices[0].delta.reasoning_content.length > 0);
  check('整段思考被切成多片（>=2）', reasoning.length >= 2, `n=${reasoning.length}`);
  if (reasoning.length >= 2) {
    const span = reasoning[reasoning.length - 1].at - reasoning[0].at;
    check('切吐是匀速的（跨度 >= 30ms）', span >= 30, `span=${span}ms`);
  }
  const contents = deltas.filter((x) => typeof x.o.choices[0].delta.content === 'string' && x.o.choices[0].delta.content.length > 0);
  if (reasoning.length && contents.length) {
    check('思考队列吐干净才发正文（顺序不乱）', reasoning[reasoning.length - 1].at <= contents[0].at);
  }
}

// 实例 A：快照模式（snapshot）—— 没有逐字增量时也能从快照补出思考和正文
async function testSnapshotFallback() {
  console.log('\n[A6] 快照兜底（无逐字增量）');
  const r = await postSSE(PORT_A, '/v1/chat/completions', {
    model: 'workbuddy-auto', stream: true,
    messages: [{ role: 'user', content: 'snapshot 快照模式测试' }],
  });
  const deltas = r.frames.map((f) => f.obj).filter((o) => o && o.choices && o.choices[0] && o.choices[0].delta)
    .map((o) => o.choices[0].delta);
  const reasoning = deltas.filter((d) => typeof d.reasoning_content === 'string' && d.reasoning_content.length > 0);
  const contents = deltas.filter((d) => typeof d.content === 'string' && d.content.length > 0);
  check('快照模式下仍有 reasoning_content', reasoning.length > 0);
  check('快照模式下仍有 content', contents.length > 0);
  const answer = contents.map((d) => d.content).join('');
  check('正文完整无重复', answer === `这是对「snapshot 快照模式测试」的回答。`, answer);
}

// 实例 A：/v1/models 正常模式 —— 带站点信息（作为伪装的对照）
async function testModelsNormal() {
  console.log('\n[A7] /v1/models（正常模式对照）');
  const r = await getJson(PORT_A, '/v1/models');
  check('HTTP 200', r.status === 200);
  check('有 data 数组', Array.isArray(r.body && r.body.data) && r.body.data.length > 0);
  check('正常模式带私有字段 _sites', Array.isArray(r.body && r.body._sites), '伪装模式下应消失');
}

// 实例 B：伪装检查
async function testDisguise() {
  console.log('\n[B] 伪装模式');
  const m = await getJson(PORT_B, '/v1/models');
  check('B1 models 只留标准字段', Array.isArray(m.body.data) && m.body.data.every((x) => {
    const keys = Object.keys(x).sort().join(',');
    return keys === 'created,id,object,owned_by' && x.owned_by === 'system';
  }), m.body.data && JSON.stringify(m.body.data[0]));
  check('B2 models 顶层无私有字段', !Object.keys(m.body || {}).some((k) => k.startsWith('_')), Object.keys(m.body || {}).join(','));
  check('B3 模型 id 无站点前缀', (m.body.data || []).every((x) => !/^(cn|intl)\//i.test(x.id)));

  const h = await getJson(PORT_B, '/health');
  check('B4 /health 只回 status', h.status === 200 && Object.keys(h.body).join(',') === 'status', JSON.stringify(h.body));

  const p = await postJson(PORT_B, '/v1/wb/prompt', { prompt: 'hi' });
  check('B5 /v1/wb/prompt 404', p.status === 404, `status=${p.status}`);

  const c = await postJson(PORT_B, '/v1/chat/completions', {
    model: 'workbuddy-auto', messages: [{ role: 'user', content: '伪装测试' }],
  });
  check('B6 对话正常（HTTP 200）', c.status === 200, `status=${c.status} raw=${(c.raw || '').slice(0, 150)}`);
  const wbHeaders = Object.keys(c.headers).filter((k) => k.toLowerCase().startsWith('x-wb'));
  check('B7 响应头无 x-wb-*', wbHeaders.length === 0, wbHeaders.join(','));
  const wbFields = Object.keys(c.body || {}).filter((k) => k.startsWith('x-wb'));
  check('B8 响应体无 x-wb-* 字段', wbFields.length === 0, wbFields.join(','));
  const msg = c.body && c.body.choices && c.body.choices[0] && c.body.choices[0].message;
  check('B9 伪装下思维链照常（reasoning_content）', Boolean(msg) && typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 5);

  const a = await postJson(PORT_B, '/v1/messages', {
    model: 'workbuddy-auto', max_tokens: 100, messages: [{ role: 'user', content: '伪装 anthropic 测试' }],
  });
  check('B10 伪装下 /v1/messages 正常', a.status === 200 && a.body && a.body.type === 'message', `status=${a.status}`);
  const wbHeaders2 = Object.keys(a.headers).filter((k) => k.toLowerCase().startsWith('x-wb'));
  check('B11 /v1/messages 响应头无 x-wb-*', wbHeaders2.length === 0, wbHeaders2.join(','));
}

/* ---------------- 主流程 ---------------- */

(async () => {
  console.log('[0] node --check wb-relay.js');
  try {
    execFileSync(process.execPath, ['--check', path.join(APP_DIR, 'wb-relay.js')]);
    check('语法检查通过', true);
  } catch (e) {
    check('语法检查通过', false, e.message);
  }

  const cfgA = writeConfig(PORT_A, false);
  const cfgB = writeConfig(PORT_B, true);
  // 测试实例会把 fake-cli 的路径写进定位缓存（.wb-location.json）。
  // 不备份恢复的话，下次正常启动 wb-relay 会从缓存里把假 CLI 当真 CLI 用 —— 表现为「模型只会复读固定台词」
  const LOC_CACHE = path.join(APP_DIR, '.wb-location.json');
  const cacheBackup = fs.existsSync(LOC_CACHE) ? fs.readFileSync(LOC_CACHE) : null;
  const restoreCache = () => {
    try {
      if (cacheBackup) fs.writeFileSync(LOC_CACHE, cacheBackup);
      else fs.rmSync(LOC_CACHE, { force: true });
    } catch {}
  };
  const a = startRelay(cfgA);
  const b = startRelay(cfgB);
  const stop = () => { try { a.kill(); } catch {} try { b.kill(); } catch {} restoreCache(); };
  process.on('exit', stop);

  try {
    console.log('[*] 等两个实例就绪…');
    await waitReady(PORT_A);
    await waitReady(PORT_B);
    console.log('[*] 就绪，开始验证');

    await testAnthropicStream();
    await testAnthropicNonStream();
    await testOpenAIStream();
    await testOpenAINonStream();
    await testBigThinkPaced();
    await testSnapshotFallback();
    await testModelsNormal();
    await testDisguise();
  } catch (e) {
    failures.push('运行异常：' + e.message);
    console.error(e);
  } finally {
    stop();
  }

  console.log('\n========================================');
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log('  失败：' + f);
    process.exit(1);
  }
  console.log('全部通过 ✓');
  process.exit(0);
})();
