/*
 * 冒烟测试：把 wb-relay 拉起来，逐项验证代理和控制台接口。
 * 用法: node smoke-test.js
 *
 * 注意：故意用独立的临时配置文件（_test-config.json），不会改动你的 config.json。
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const locateMod = require('./locate.js');

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = path.join(__dirname, 'wb-relay.js');
const TEST_CFG = path.join(__dirname, '_test-config.json');

try { fs.rmSync(TEST_CFG, { force: true }); } catch {}
try { fs.rmSync(path.join(__dirname, 'workspace'), { recursive: true, force: true }); } catch {}
// 故意先删掉定位缓存，验证「首次会自己找出来并记住」
const LOC_CACHE = path.join(__dirname, '.wb-location.json');
try { fs.rmSync(LOC_CACHE, { force: true }); } catch {}

const tBoot = Date.now();
const child = spawn(process.execPath, [APP, '--port', String(PORT), '--config', TEST_CFG], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOut = '';
child.stdout.on('data', (d) => { serverOut += d.toString('utf8'); });
child.stderr.on('data', (d) => { serverOut += d.toString('utf8'); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(300);
  }
  throw new Error('服务没起来：\n' + serverOut);
}

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failed++;
}
const api = async (p, o) => {
  const r = await fetch(BASE + p, o);
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const post = (p, body, extraHeaders) => api(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-wb-relay': '1', ...(extraHeaders || {}) },
  body: JSON.stringify(body),
});

(async () => {
  try {
    const health = await waitHealth();
    ok('GET /health', health.status === 'ok', `workers=${JSON.stringify(health.workers)}`);

    // ---- 0. 路径自动定位 ----
    ok('启动时自动找到 WorkBuddy CLI',
      typeof health.cli === 'string' && health.cli.length > 0 && fs.existsSync(health.cli),
      `${health.cli}（启动到健康检查约 ${Math.round((Date.now() - tBoot) / 1000)} 秒）`);
    const st0 = await api('/api/state');
    ok('  定位来源有记录', Boolean(st0.j.locate && st0.j.locate.source), `来源=${st0.j.locate && st0.j.locate.source}`);
    ok('  配置里没有写死路径', (st0.j.locate.userOverride || '') === '', `cliJs 配置值=${JSON.stringify(st0.j.locate.userOverride)}`);
    let cacheOk = false;
    try { cacheOk = JSON.parse(fs.readFileSync(LOC_CACHE, 'utf8')).cliJs === st0.j.cliPath; } catch {}
    ok('  路径已记进 .wb-location.json', cacheOk);

    // 删掉缓存，验证强制重扫能重新找回来
    fs.rmSync(LOC_CACHE, { force: true });
    const tLoc = Date.now();
    const reloc = await post('/api/locate', {});
    const locMs = Date.now() - tLoc;
    ok('POST /api/locate 强制重新查找', reloc.status === 200 && reloc.j.ok === true,
      `用时 ${locMs}ms，来源=${reloc.j.source}`);
    ok('  重扫后又记住了路径', fs.existsSync(LOC_CACHE) && fs.readFileSync(LOC_CACHE, 'utf8').includes('cliJs'),
      '文件已写入');

    // ---- 0b. 直接测目录遍历这条兜底路径 ----
    // 造一个假的安装目录树，看遍历能不能自己翻出来（WorkBuddy 没运行时全靠它）
    const fakeRoot = path.join(__dirname, '_fake_drive');
    const fakeCli = path.join(fakeRoot, 'SomeVendor', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
    fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
    fs.writeFileSync(fakeCli, '// fake\n');
    // 顺便塞几个该被跳过的目录，验证不会钻进去浪费时间
    for (const skip of ['Windows', 'node_modules', '$Recycle.Bin']) {
      fs.mkdirSync(path.join(fakeRoot, skip, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(fakeRoot, skip, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'), '// should be skipped\n');
    }
    const scanned = locateMod.scanRoots({ roots: [fakeRoot], maxDepth: 4, log: () => {} });
    ok('目录遍历能找到 WorkBuddy（兜底路径）',
      Boolean(scanned && scanned.cliJs) && path.resolve(scanned.cliJs) === path.resolve(fakeCli),
      `找到=${scanned && scanned.cliJs}，看了 ${scanned && scanned.visited} 个目录`);
    fs.rmSync(fakeRoot, { recursive: true, force: true });

    // ---- 0c. 缓存里的路径失效了，要能自动重新找 ----
    fs.writeFileSync(LOC_CACHE, JSON.stringify({ cliJs: path.join(__dirname, '这个路径不存在', 'codebuddy'), source: '测试' }), 'utf8');
    const child2 = spawn(process.execPath, [APP, '--port', String(PORT + 1), '--config', TEST_CFG], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out2 = '';
    child2.stdout.on('data', (d) => { out2 += d.toString('utf8'); });
    child2.stderr.on('data', (d) => { out2 += d.toString('utf8'); });
    let health2 = null;
    try {
      const t2 = Date.now();
      while (Date.now() - t2 < 25000) {
        try { const r = await fetch(`http://127.0.0.1:${PORT + 1}/health`); if (r.ok) { health2 = await r.json(); break; } } catch {}
        await sleep(300);
      }
    } finally { child2.kill(); }
    ok('缓存路径失效时会自动重新查找',
      Boolean(health2) && fs.existsSync(health2.cli) && out2.includes('已失效'),
      `重新找到 ${health2 && health2.cli}`);

    // ---- 1. 网页控制台能打开 ----
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    ok('GET / 控制台页面', page.ok && html.includes('wb-relay') && html.includes('全部可用模型'),
      `${Buffer.byteLength(html)} 字节`);

    // 静态检查：脚本引用的元素 id 都得真存在，脚本本身要能解析
    const pageIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...html.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
    const missing = [...new Set(refs)].filter((r) => !pageIds.has(r));
    ok('  页面脚本引用的元素都存在', missing.length === 0, missing.length ? '缺失：' + missing.join(', ') : `${refs.length} 处引用`);

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    let parseErr = '';
    try { for (const s of scripts) new Function(s); } catch (e) { parseErr = e.message; }
    ok('  内联脚本语法正确', !parseErr, parseErr || `${scripts.length} 段脚本`);

    // ---- 2. /v1/models 返回全部模型 ----
    const m1 = await api('/v1/models');
    const ids = (m1.j.data || []).map((x) => x.id);
    ok('GET /v1/models 返回全部模型', m1.status === 200 && ids.length >= 30,
      `${ids.length} 个，来源=${m1.j._source || '?'}`);
    ok('  含默认别名 auto', ids.includes('auto'));
    ok('  含真实模型 deepseek-v4-pro', ids.includes('deepseek-v4-pro'));
    ok('  含档位别名 fast-model / balanced-model / deep-model',
      ['fast-model', 'balanced-model', 'deep-model'].every((x) => ids.includes(x)));
    const sample = (m1.j.data || []).find((x) => x.id === 'auto');
    ok('  模型条目带积分/上下文等元数据', Boolean(sample && sample.kind && sample.context_length));

    // ---- 3. 控制台状态接口 ----
    const st = await api('/api/state');
    ok('GET /api/state', st.status === 200 && st.j.catalog && st.j.tools && st.j.config);
    ok('  工具清单可用', (st.j.tools || []).length >= 10, `${(st.j.tools || []).length} 个工具`);
    ok('  模型分类统计', st.j.catalog.counts.total >= 30,
      `对话 ${st.j.catalog.counts.chat} / 补全 ${st.j.catalog.counts.completion} / 图像 ${st.j.catalog.counts.image} / 视频 ${st.j.catalog.counts.video}`);
    ok('  清单带时间戳（能看出新不新）',
      typeof st.j.catalog.loadedAt === 'number' && typeof st.j.catalog.sourceMtime === 'number' && st.j.catalog.sourceMtime > 0,
      `读取于 ${new Date(st.j.catalog.loadedAt).toLocaleTimeString()}，文件更新于 ${new Date(st.j.catalog.sourceMtime).toLocaleString()}`);

    // ---- 3b. 手动拉取最新模型 ----
    const pull = await post('/api/models/refresh', {});
    ok('POST /api/models/refresh 拉取最新模型',
      pull.status === 200 && pull.j.ok === true && pull.j.count >= 30,
      `读到 ${pull.j.count} 个，来源=${pull.j.source}，变化=${pull.j.changed}，新增=${JSON.stringify(pull.j.added)}，移除=${JSON.stringify(pull.j.removed)}`);
    ok('  返回 WorkBuddy 配置文件的时间', typeof pull.j.sourceMtime === 'number' && pull.j.sourceMtime > 0,
      `文件更新于 ${new Date(pull.j.sourceMtime).toLocaleString()}`);

    // ---- 4. 代理对话（真调一次，顺带验证流式） ----
    const t0 = Date.now();
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'workbuddy-auto', stream: true, messages: [{ role: 'user', content: '只回复两个字：收到' }] }),
    });
    let sse = '';
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += dec.decode(value, { stream: true });
    }
    const deltas = sse.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
    const text = deltas.map((c) => (c.choices[0] && c.choices[0].delta && c.choices[0].delta.content) || '').join('');
    ok('POST /v1/chat/completions (流式)', r.ok && text.length > 0 && sse.includes('[DONE]'),
      `回答=${JSON.stringify(text)} 用时=${Date.now() - t0}ms`);

    // ---- 5. 改配置的接口必须挡住无凭证的跨站调用 ----
    const noHeader = await api('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli: { allowTools: true } }),
    });
    ok('POST /api/config 缺自定义头 => 403', noHeader.status === 403, `status=${noHeader.status}`);

    const cross = await post('/api/config', { cli: { allowTools: true } }, { origin: 'http://evil.example.com' });
    ok('POST /api/config 跨站 Origin => 403', cross.status === 403, `status=${cross.status}`);

    // ---- 6. 正常改配置 + 写回文件 ----
    const cfg = await post('/api/config', {
      cli: { allowTools: true, allowedTools: 'Read,Grep', systemPrompt: '', model: 'glm-5.2' },
      sessions: { maxWorkers: 2, idleMs: 600000, turnTimeoutMs: 600000 },
      models: ['workbuddy-auto', 'my-alias'],
    });
    ok('POST /api/config 写入成功', cfg.status === 200 && cfg.j.ok === true, `warnings=${JSON.stringify(cfg.j.warnings)}`);

    const onDisk = JSON.parse(fs.readFileSync(TEST_CFG, 'utf8'));
    ok('  配置已写回文件', onDisk.cli.allowTools === true && onDisk.cli.model === 'glm-5.2' &&
      onDisk.cli.allowedTools === 'Read,Grep' && onDisk.sessions.maxWorkers === 2);

    const st2 = await api('/api/state');
    ok('  新配置立即反映在状态里', st2.j.config.cli.allowTools === true && st2.j.config.cli.model === 'glm-5.2');

    const m2 = await api('/v1/models');
    const ids2 = (m2.j.data || []).map((x) => x.id);
    ok('  自定义别名也出现在模型列表', ids2.includes('my-alias'));

    // ---- 6b. 放开工具后真的能起进程（-y --allowedTools 这条路） ----
    await post('/api/sessions', { all: true });
    const tTool = Date.now();
    const withTools = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'workbuddy-auto', messages: [{ role: 'user', content: '只回复两个字：收到' }] }),
    });
    const withToolsText = withTools.j.choices && withTools.j.choices[0] && withTools.j.choices[0].message.content;
    ok('工具白名单模式能正常对话（-y + --allowedTools）',
      withTools.status === 200 && typeof withToolsText === 'string' && withToolsText.length > 0,
      `回答=${JSON.stringify(withToolsText)} 用时=${Date.now() - tTool}ms 模型=${withTools.j['x-wb-model']}`);

    // ---- 6c. 一个工具都不勾 = 什么工具都不给（-y + --disallowedTools） ----
    const noneCfg = await post('/api/config', { cli: { allowTools: true, allowedTools: '' } });
    ok('POST /api/config 清空白名单', noneCfg.status === 200);
    await post('/api/sessions', { all: true });
    const tNone = Date.now();
    const noTools = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'workbuddy-auto', messages: [{ role: 'user', content: '只回复两个字：收到' }] }),
    });
    const noToolsText = noTools.j.choices && noTools.j.choices[0] && noTools.j.choices[0].message.content;
    ok('空白名单也能正常对话（-y + --disallowedTools 全禁）',
      noTools.status === 200 && typeof noToolsText === 'string' && noToolsText.length > 0,
      `回答=${JSON.stringify(noToolsText)} 用时=${Date.now() - tNone}ms`);

    // ---- 7. 参数校验与告警 ----
    const bad = await post('/api/config', { cli: { allowedTools: 'Read,不存在的工具' }, sessions: { maxWorkers: 999 } });
    ok('奇怪的参数会给出告警而不是崩掉', bad.status === 200 && Array.isArray(bad.j.warnings) && bad.j.warnings.length >= 1,
      `warnings=${JSON.stringify(bad.j.warnings)}`);
    const st3 = await api('/api/state');
    ok('  超范围数值被夹回上限', st3.j.config.sessions.maxWorkers === 16, `maxWorkers=${st3.j.config.sessions.maxWorkers}`);

    // ---- 8. 会话管理 ----
    const before = (await api('/api/state')).j.sessions.length;
    const clr = await post('/api/sessions', { all: true });
    const after = (await api('/api/state')).j.sessions.length;
    ok('POST /api/sessions 清空会话', clr.status === 200 && before > 0 && after === 0,
      `清掉 ${clr.j.cleared} 个，剩余 ${after} 个`);

    // ---- 9. 鉴权开关（模拟对外暴露时的保护） ----
    const stAuth = await api('/api/state');
    ok('本机回环默认不要求密钥', stAuth.status === 200 && stAuth.j.authRequired === false);
  } catch (e) {
    console.error('测试异常：', e.message);
    failed++;
  } finally {
    console.log('\n--- 服务端日志尾部 ---');
    console.log(serverOut.split('\n').slice(-14).join('\n'));
    child.kill();
    await sleep(600);
    for (const f of ['_test-config.json', 'workspace']) {
      try { fs.rmSync(path.join(__dirname, f), { recursive: true, force: true }); } catch {}
    }
    console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
    process.exit(failed === 0 ? 0 : 1);
  }
})();
