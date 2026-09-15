/*
 * 冒烟测试：把 wb-relay 拉起来，逐项验证代理和控制台接口。
 * 用法: node smoke-test.js
 *
 * 注意：故意用独立的临时配置文件（_test-config.json），不会改动你的 config.json。
 */

'use strict';

const { spawn, spawnSync } = require('node:child_process');
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

    // ---- 10. 局域网 / 公网访问 ----
    const KEY = 'test-' + Math.random().toString(36).slice(2, 12);
    const PORT_EXT = PORT + 3;
    const CFG_EXT = path.join(__dirname, '_test-config-ext.json');
    const baseExt = `http://127.0.0.1:${PORT_EXT}`;
    try { fs.rmSync(CFG_EXT, { force: true }); } catch {}
    const childExt = spawn(process.execPath,
      [APP, '--port', String(PORT_EXT), '--host', '0.0.0.0', '--key', KEY, '--config', CFG_EXT],
      { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let outExt = '';
    childExt.stdout.on('data', (d) => { outExt += d.toString('utf8'); });
    childExt.stderr.on('data', (d) => { outExt += d.toString('utf8'); });

    try {
      let h = null;
      const tExt = Date.now();
      while (Date.now() - tExt < 25000) {
        try { const r = await fetch(`${baseExt}/health`); if (r.ok) { h = await r.json(); break; } } catch {}
        await sleep(300);
      }
      ok('对外监听能起来', Boolean(h), `host=0.0.0.0 port=${PORT_EXT}`);

      // 页面本身不需要密钥 —— 否则配了密钥之后浏览器根本打不开控制台
      const pageExt = await fetch(`${baseExt}/`);
      const htmlExt = await pageExt.text();
      ok('  控制台页面无需密钥即可打开', pageExt.ok && htmlExt.includes('wb-relay 控制台'),
        `HTTP ${pageExt.status}，${Buffer.byteLength(htmlExt)} 字节`);

      // 未鉴权的 /health 只回最基本信息，不泄露会话名和路径
      const hPub = await (await fetch(`${baseExt}/health`)).json();
      ok('  未鉴权的 /health 不泄露细节',
        hPub.status === 'ok' && hPub.authRequired === true && !hPub.cli && !hPub.workers,
        JSON.stringify(hPub));

      // 数据接口仍然要密钥
      ok('  /api/state 无密钥 => 401', (await fetch(`${baseExt}/api/state`)).status === 401);
      const stExt = await (await fetch(`${baseExt}/api/state`, { headers: { 'x-api-key': KEY } })).json();
      ok('  /api/state 带密钥 => 200', Boolean(stExt.catalog));
      ok('  列出局域网地址（本机地址也照旧可用）',
        stExt.bindAll === true && Array.isArray(stExt.lanUrls),
        `lanUrls=${JSON.stringify(stExt.lanUrls)}`);

      // 给别的程序填的接入地址表
      const stAuth2 = { h: { 'x-api-key': KEY } };
      const postExt = (body, origin) => fetch(`${baseExt}/api/config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-wb-relay': '1', 'x-api-key': KEY,
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      });
      const eps0 = stExt.endpoints || [];
      ok('  生成接入地址表（可直接填到别的程序里）',
        eps0.length >= 2 && eps0.every((e) => e.baseUrl === '' || e.baseUrl.endsWith('/v1')),
        eps0.map((e) => e.label + '=' + (e.baseUrl || '(空)')).join(' | '));
      ok('  给出模型名提示', Boolean(stExt.modelHint), `modelHint=${stExt.modelHint}`);

      // 手填对外地址（公网/局域网都不写死）
      const setUrlRes = await postExt({ publicBaseUrl: 'https://relay.example.com', lanBaseUrl: 'http://10.1.2.3:8790' });
      const setUrlBody = await setUrlRes.json();
      ok('  写入手填的公网/局域网地址', setUrlRes.status === 200 && setUrlBody.ok === true);
      ok('  明确告知已自动放行该域名',
        (setUrlBody.warnings || []).some((w) => w.includes('relay.example.com')),
        JSON.stringify(setUrlBody.warnings));
      const after = await (await fetch(`${baseExt}/api/state`, { headers: stAuth2.h })).json();
      const bases = (after.endpoints || []).map((e) => e.baseUrl);
      ok('  手填的两个地址都出现在接入表里',
        bases.includes('https://relay.example.com/v1') && bases.includes('http://10.1.2.3:8790/v1'),
        bases.join(' | '));
      ok('  手填域名被自动加进反代白名单（省得保存设置 403）',
        (after.listen.trustedOrigins || []).includes('https://relay.example.com'),
        JSON.stringify(after.listen.trustedOrigins));

      // 域名不带端口不能乱补端口（那多半是走 80 的反代），要原样保留
      await postExt({ publicBaseUrl: 'noscheme.example.com' });
      const after2 = await (await fetch(`${baseExt}/api/state`, { headers: stAuth2.h })).json();
      ok('  域名没写协议头会自动补 http://，且不擅自加端口',
        (after2.endpoints || []).some((e) => e.baseUrl === 'http://noscheme.example.com/v1'),
        JSON.stringify((after2.endpoints || []).map((e) => e.baseUrl)));

      // 用户最容易踩的坑：只写 IP，不写端口 —— 那样会去访问 80 端口，肯定拉不到
      const noPort = await postExt({ publicBaseUrl: `http://10.19.100.57` });
      const noPortBody = await noPort.json();
      const after3 = await (await fetch(`${baseExt}/api/state`, { headers: stAuth2.h })).json();
      ok('  IP 没写端口会自动补上监听端口',
        (after3.endpoints || []).some((e) => e.baseUrl === `http://10.19.100.57:${PORT_EXT}/v1`),
        JSON.stringify((after3.endpoints || []).map((e) => e.baseUrl)));
      ok('  并且明确告知补了端口',
        (noPortBody.warnings || []).some((w) => w.includes('没写端口')),
        JSON.stringify(noPortBody.warnings));

      // 每行地址要标出「现在能不能用」以及原因
      const epWithStatus = (after3.endpoints || []).filter((e) => e.baseUrl);
      ok('  每条地址都带可用性判断',
        epWithStatus.every((e) => 'available' in e),
        epWithStatus.map((e) => `${e.baseUrl}→${e.available}`).join(' | '));
      ok('  本机地址标记为可用',
        (after3.endpoints || []).some((e) => e.baseUrl.startsWith('http://127.0.0.1') && e.available === true));
      ok('  端口写错的地址会被指出端口不匹配（而不是只报连不上）',
        (await (async () => {
          await postExt({ lanBaseUrl: 'http://10.19.100.57:9999' });
          const s = await (await fetch(`${baseExt}/api/state`, { headers: stAuth2.h })).json();
          const bad = (s.endpoints || []).find((e) => e.baseUrl.includes(':9999'));
          return bad && bad.available === false && /端口/.test(bad.reason || '');
        })()), '检查端口不匹配的诊断');

      // 真的照接入地址拉一次模型，证明「填了地址就能拉模型用」
      const epLocal = (after3.endpoints || []).find((e) => e.baseUrl.startsWith('http://127.0.0.1'));
      const rModels = await fetch(epLocal.modelsUrl, { headers: stAuth2.h });
      const jModels = await rModels.json();
      ok('  从接入地址真能拉到模型列表',
        rModels.ok && (jModels.data || []).length >= 30,
        `${epLocal.modelsUrl} → ${(jModels.data || []).length} 个模型`);
      ok('  密钥能在控制台里读到（方便填到别的程序）',
        typeof after3.apiKey === 'string' && after3.apiKey.length > 0 && after3.apiKey === KEY);

      // 套了反代之后浏览器发的 Origin 是域名：没放行要挡，放行了要通
      ok('  陌生 Origin => 403',
        (await postExt({ cli: { allowTools: false } }, 'https://evil.example.com')).status === 403);

      const addTrust = await postExt({ trustedOrigins: ['https://my.example.com', 'https://*.example.com'] });
      ok('  写入反代域名白名单', addTrust.status === 200);
      ok('  放行后的域名 => 200（立刻生效，不用重启）',
        (await postExt({ cli: { allowTools: false } }, 'https://my.example.com')).status === 200);
      ok('  子域通配也能放行',
        (await postExt({ cli: { allowTools: false } }, 'https://a.b.example.com')).status === 200);
      ok('  没在名单里的域名仍然挡住',
        (await postExt({ cli: { allowTools: false } }, 'https://other.com')).status === 403);
      ok('  白名单已落盘',
        (JSON.parse(fs.readFileSync(CFG_EXT, 'utf8')).listen.trustedOrigins || []).length === 2);
    } finally {
      childExt.kill();
      await sleep(400);
      try { fs.rmSync(CFG_EXT, { force: true }); } catch {}
    }

    // ---- 11. 起一个实例、等它就绪的小工具（下面几项要反复用） ----
    const bootWith = async (cfgObj, port) => {
      const cfgFile = path.join(__dirname, `_test-boot-${port}.json`);
      fs.writeFileSync(cfgFile, JSON.stringify(cfgObj, null, 2), 'utf8');
      const ch = spawn(process.execPath, [APP, '--config', cfgFile], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      ch.stdout.on('data', (d) => { out += d.toString('utf8'); });
      ch.stderr.on('data', (d) => { out += d.toString('utf8'); });
      let health = null;
      const t = Date.now();
      while (Date.now() - t < 25000) {
        try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { health = await r.json(); break; } } catch {}
        await sleep(300);
      }
      const state = health
        ? await (await fetch(`http://127.0.0.1:${port}/api/state`, {
            headers: (() => { const k = (JSON.parse(fs.readFileSync(cfgFile, 'utf8')).apiKeys || [])[0]; return k ? { 'x-api-key': k } : {}; })(),
          })).json()
        : null;
      return { child: ch, out, health, state, cfgFile, disk: () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')) };
    };

    // host: auto —— 填了对外地址就自动对外监听；没填就只监听本机
    const auto1 = await bootWith({ listen: { host: 'auto', port: PORT + 5, lanBaseUrl: `http://10.19.100.57:${PORT + 5}` } }, PORT + 5);
    ok('host=auto + 填了局域网地址 => 自动对外监听',
      Boolean(auto1.health) && auto1.state && auto1.state.bindAll === true,
      `bindAll=${auto1.state && auto1.state.bindAll}`);
    ok('  不会自动生成密钥（要不要密钥由用户决定）',
      Boolean(auto1.state) && auto1.state.authRequired === false && (auto1.disk().apiKeys || []).length === 0,
      `apiKeys=${JSON.stringify(auto1.disk().apiKeys)}`);
    ok('  没设密钥时不校验，直接就能访问数据接口',
      (await fetch(`http://127.0.0.1:${PORT + 5}/api/state`)).status === 200);
    auto1.child.kill();
    await sleep(400);
    try { fs.rmSync(auto1.cfgFile, { force: true }); } catch {}

    const auto2 = await bootWith({ listen: { host: 'auto', port: PORT + 6 } }, PORT + 6);
    ok('host=auto 但没填对外地址 => 只监听本机',
      Boolean(auto2.health) && auto2.state && auto2.state.bindAll === false,
      `bindAll=${auto2.state && auto2.state.bindAll}`);
    ok('  这种情况也不会有密钥',
      Boolean(auto2.state) && auto2.state.authRequired === false);
    auto2.child.kill();
    await sleep(400);
    try { fs.rmSync(auto2.cfgFile, { force: true }); } catch {}

    // 显式写了 0.0.0.0、没密钥 => 照常启动，不校验（用户没说要有密钥）
    const auto3 = await bootWith({ listen: { host: '0.0.0.0', port: PORT + 7 } }, PORT + 7);
    ok('显式 0.0.0.0 且没密钥 => 照常启动、不校验',
      Boolean(auto3.health) && auto3.state && auto3.state.authRequired === false,
      `日志含提醒=${/没有设置访问密钥/.test(auto3.out)}`);
    ok('  不带密钥也能访问数据接口',
      (await fetch(`http://127.0.0.1:${PORT + 7}/api/state`)).status === 200);

    // 用户在控制台里决定「要密钥」
    const setKey = await fetch(`http://127.0.0.1:${PORT + 7}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wb-relay': '1' },
      body: JSON.stringify({ apiKeys: ['my-own-secret'] }),
    });
    ok('控制台里自己设一个密钥', setKey.status === 200);
    ok('  设了之后不带密钥 => 401',
      (await fetch(`http://127.0.0.1:${PORT + 7}/api/state`)).status === 401);
    ok('  带上密钥 => 200',
      (await fetch(`http://127.0.0.1:${PORT + 7}/api/state`, { headers: { 'x-api-key': 'my-own-secret' } })).status === 200);
    ok('  密钥已写进 config.json',
      (auto3.disk().apiKeys || [])[0] === 'my-own-secret');

    // 再决定「不要了」
    await fetch(`http://127.0.0.1:${PORT + 7}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wb-relay': '1', 'x-api-key': 'my-own-secret' },
      body: JSON.stringify({ apiKeys: [] }),
    });
    ok('  清空密钥后又不需要校验了',
      (await fetch(`http://127.0.0.1:${PORT + 7}/api/state`)).status === 200 &&
      (auto3.disk().apiKeys || []).length === 0);
    auto3.child.kill();
    await sleep(400);
    try { fs.rmSync(auto3.cfgFile, { force: true }); } catch {}

    // 老配置里 host 写死 127.0.0.1、但又填了对外地址 —— 那个地址本来用不了，自动纠正
    const auto4 = await bootWith({ listen: { host: '127.0.0.1', port: PORT + 8, lanBaseUrl: `http://10.19.100.57:${PORT + 8}` } }, PORT + 8);
    ok('host 写死 127.0.0.1 但填了对外地址 => 自动改成对外监听',
      Boolean(auto4.health) && auto4.state && auto4.state.bindAll === true,
      `bindAll=${auto4.state && auto4.state.bindAll}，日志=${/已自动改成 0\.0\.0\.0/.test(auto4.out)}`);
    ok('  也不会自作主张加密钥',
      Boolean(auto4.state) && auto4.state.authRequired === false);
    // 没设密钥，所以直接访问就行 —— 这正是「填了地址就能拉模型」的最小路径
    const lanProbe = await fetch(`http://10.19.100.57:${PORT + 8}/v1/models`);
    const lanModels = await lanProbe.json();
    ok('  用填的局域网地址直接就能拉到模型（无需密钥）',
      lanProbe.ok && (lanModels.data || []).length >= 30,
      `http://10.19.100.57:${PORT + 8}/v1/models → ${(lanModels.data || []).length} 个模型`);
    const lanPage = await fetch(`http://10.19.100.57:${PORT + 8}/`);
    ok('  同一地址也能打开控制台页面', lanPage.ok, `HTTP ${lanPage.status}`);
    auto4.child.kill();
    await sleep(400);
    try { fs.rmSync(auto4.cfgFile, { force: true }); } catch {}
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
