#!/usr/bin/env node
/*
 * wb-relay —— 把本机 WorkBuddy 的能力反代成一个本地 HTTP 服务
 *
 * 前端：OpenAI 兼容接口（/v1/models、/v1/chat/completions，支持 SSE 流式）
 * 后端：常驻 WorkBuddy CLI 进程，通过 stdin/stdout 的 stream-json 长连接多轮对话
 *
 * 支持两个站点，各自独立：
 *   国内站（cn）  —— productName "WorkBuddy"，配置目录 ~/.workbuddy，端点 copilot.tencent.com
 *   国外站（intl）—— productName "WorkBuddy AI"，配置目录 ~/.workbuddy-ai，端点 www.workbuddy.ai
 *
 * 两个站点都装了就默认只用国内站，可以在控制台切成「只用国外站」或「两个都用」；
 * 只装了一个就只用它。模型清单按站点分开读，每条模型都标出属于哪个站。
 *
 * 为什么用常驻进程而不是每次拉一个新的：CLI 冷启动要好几秒，
 * 常驻之后第二轮起只要 2 秒左右（实测）。
 *
 * 无第三方依赖，只用 Node 内置模块。
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const models = require('./models.js');
const sites = require('./sites.js');
const { locateAll } = require('./locate.js');

const VERSION = '2.1.0';
const APP_DIR = __dirname;

// 让 CLI 把 token 级增量也吐出来。不给这个参数时，CLI 只在整条消息写完时才发一次
// assistant 事件 —— SSE 里就是「卡半天、然后一次来一整句」。
// 老版本 CLI 可能不认识它，起进程时会立刻报错退出，那时去掉它重起一次（见 Worker.start）。
const PARTIAL_FLAG = '--include-partial-messages';
let partialUnsupported = false;

// 站点模式：auto = 两个都在就用国内站；cn / intl = 只用那一个；both = 两个都用（国内站优先）
const SITE_MODES = ['auto', 'cn', 'intl', 'both'];
const MODE_LABEL = {
  auto: '自动（两个都在时用国内站）',
  cn: '只用国内站',
  intl: '只用国外站',
  both: '两个都用（国内站优先）',
};

const DEFAULT_CONFIG = {
  listen: {
    host: '127.0.0.1',
    port: 8790,
    // 对外地址由你自己填，程序不替你决定。留空就只用自动检测到的本机/局域网地址。
    // 公网/自定义地址，如 "https://abc.example.com" 或 "http://1.2.3.4:8790"
    publicBaseUrl: '',
    // 局域网地址，如 "http://10.19.100.57:8790"。留空 = 自动检测网卡（检测可能不准，所以允许手填覆盖）
    lanBaseUrl: '',
    // 套了 nginx / caddy / 隧道之后，浏览器发的 Origin 是你的公网域名，
    // 跟 Host 对不上会被跨站校验挡掉 —— 把那些域名写在这里放行。
    // 支持 https://example.com、https://*.example.com 子域通配，或 "*" 全放（不推荐）
    trustedOrigins: [],
  },
  // 留空 = 本机回环不校验；填了就必须带 Authorization: Bearer <key>
  apiKeys: [],
  // 两个站点共用的会话参数（工具权限、工作目录根、系统提示词这些跟站点无关）
  cli: {
    nodeExe: '', // 空 = 用运行本程序的 node
    cliJs: '', // 老写法：国内站的手写 CLI 路径（新写法请用 sites.cn.cliJs）
    cwd: '', // 空 = <程序目录>\workspace，下面会再按站点分成 cn / intl 两个子目录
    verbose: true,
    // 默认不给工具权限：未授权时文件/命令类工具会被拦下，只能纯聊天问答
    allowTools: false,
    allowedTools: '', // 配合 allowTools，如 "Read,Grep,WebSearch"
    // 流式输出的粒度：
    // true  = 让 CLI 把 token 级增量也吐出来，SSE 里一个字一个字往外走（默认）
    // false = 老行为，等整条消息写完才发一次 —— 事件少、兼容性最稳，内容一样
    partialMessages: true,
    systemPrompt: '', // 追加到系统提示词
    model: '', // 两个站点共用的默认模型；每个站点还可以各自覆盖（见 sites.<站>.model）
  },
  // 站点：怎么找、用哪个、每个站的默认模型
  sites: {
    // auto = 检测到几个就用几个（两个都在时默认国内站，跟你说的「默认国内站」一致）
    mode: 'auto',
    cn: { cliJs: '', home: '', model: '' },
    intl: { cliJs: '', home: '', model: '' },
  },
  sessions: {
    maxWorkers: 4, // 最多几个并行会话进程
    idleMs: 30 * 60 * 1000, // 会话空闲这么久就回收
    turnTimeoutMs: 15 * 60 * 1000, // 单轮最长等待
    keepAliveHintMs: 15000, // SSE 心跳间隔
    // 开机就把首选站点 default 会话的 CLI 进程拉起来，省掉第一次调用要等的冷启动
    prewarm: true,
  },
  models: ['workbuddy-auto'],
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    const isFlag = next === undefined || next.startsWith('--');
    out[key] = isFlag ? true : (i++, next);
  }
  return out;
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch.slice();
  if (typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
  return out;
}

function loadConfig(args) {
  const configPath = typeof args.config === 'string' ? args.config : path.join(APP_DIR, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    try {
      // 记事本存成「UTF-8 带 BOM」很常见，BOM 会让 JSON.parse 直接失败，先剥掉
      const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
      fileCfg = JSON.parse(raw);
    } catch (e) {
      console.error(`[config] 解析 ${configPath} 失败：${e.message}`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    console.log(`[config] 已生成默认配置：${configPath}`);
  }

  const cfg = deepMerge(DEFAULT_CONFIG, fileCfg);

  // 命令行覆盖
  if (args.port) cfg.listen.port = Number(args.port);
  if (typeof args.host === 'string') cfg.listen.host = args.host;
  if (typeof args.key === 'string') cfg.apiKeys = [args.key];
  if (typeof args['trusted-origins'] === 'string') {
    cfg.listen.trustedOrigins = args['trusted-origins'].split(',').map((x) => x.trim()).filter(Boolean);
  }
  // 对外地址由用户自己定，命令行只是图个方便
  if (typeof args['public-url'] === 'string') cfg.listen.publicBaseUrl = args['public-url'];
  if (typeof args['lan-url'] === 'string') cfg.listen.lanBaseUrl = args['lan-url'];
  if (typeof args.model === 'string') cfg.cli.model = args.model;
  if (typeof args.cwd === 'string') cfg.cli.cwd = args.cwd;
  if (typeof args['allow-tools'] === 'string') {
    cfg.cli.allowTools = true;
    cfg.cli.allowedTools = args['allow-tools'];
  } else if (args['allow-tools'] === true) {
    cfg.cli.allowTools = true;
  }

  // 站点配置先规整一遍，缺字段的补上，模式写错的回退到 auto
  cfg.sites = cfg.sites && typeof cfg.sites === 'object' ? cfg.sites : {};
  if (!SITE_MODES.includes(String(cfg.sites.mode))) cfg.sites.mode = 'auto';
  for (const key of sites.SITE_ORDER) {
    const one = cfg.sites[key] && typeof cfg.sites[key] === 'object' ? cfg.sites[key] : {};
    cfg.sites[key] = {
      cliJs: typeof one.cliJs === 'string' ? one.cliJs : '',
      home: typeof one.home === 'string' ? one.home : '',
      model: typeof one.model === 'string' ? one.model : '',
    };
  }

  // 用户手写的值要留着，写回配置时不能把自动找到的路径固化进去
  cfg.cli.cliJsUser = typeof cfg.cli.cliJs === 'string' ? cfg.cli.cliJs : '';
  cfg.cli.nodeExeUser = typeof cfg.cli.nodeExe === 'string' ? cfg.cli.nodeExe : '';
  if (!cfg.cli.nodeExe) cfg.cli.nodeExe = process.execPath;

  // 命令行给的路径优先级最高，但只影响本次运行，不写回配置文件
  cfg._cliJsArg = typeof args['cli-js'] === 'string' ? args['cli-js'] : '';
  cfg._siteArg = typeof args.site === 'string' ? args.site.trim() : '';

  if (!cfg.cli.cwd) cfg.cli.cwd = path.join(APP_DIR, 'workspace');
  fs.mkdirSync(cfg.cli.cwd, { recursive: true });
  // 两个站点各自一个干净的工作目录：一个站点不会看到另一个站点写下的项目级配置
  for (const key of sites.SITE_ORDER) fs.mkdirSync(path.join(cfg.cli.cwd, key), { recursive: true });

  // host = "auto"：你填了对外地址，就顺手对外监听；没填就只监听本机。
  // 这样「填入局域网/公网地址」本身就足以让它生效，不用再去改 --host。
  // 明确写了 127.0.0.1 但同时又填了对外地址时，也按 auto 处理 —— 你既然填了那个地址，
  // 就说明你想让它能在那个地址上访问；否则填了也是白填。
  const rawHost = String(cfg.listen.host || 'auto').trim().toLowerCase();
  const filledExternal = Boolean(String(cfg.listen.lanBaseUrl || '').trim() || String(cfg.listen.publicBaseUrl || '').trim());
  if (rawHost === 'auto' || rawHost === '') {
    cfg.listen.host = filledExternal ? '0.0.0.0' : '127.0.0.1';
    cfg._hostMode = filledExternal ? 'auto→对外（因为填了对外地址）' : 'auto→仅本机（没填对外地址）';
  } else if (rawHost === '127.0.0.1' && filledExternal) {
    cfg.listen.host = '0.0.0.0';
    cfg._hostMode = '你填了对外地址，所以自动改成对外监听（原来写的是 127.0.0.1）';
    console.log('[config] 检测到配置里填了对外地址，但 host 写的是 127.0.0.1 —— 那个地址本来就用不了，已自动改成 0.0.0.0');
  }

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.listen.host);

  // 密钥是可选项，由用户自己决定要不要。这里不自动生成、也不因为缺密钥拒绝启动 ——
  // 只是把风险说清楚。
  if (!loopback && cfg.apiKeys.length === 0) {
    console.log('');
    console.log('  ⚠ 现在对外监听，但没有设置访问密钥（apiKeys 为空）——');
    console.log('     局域网/公网里任何人都能用它跑模型，也能改这里的设置。');
    console.log('     想加一把的话：控制台里「访问密钥」填一个，或在 config.json 的 apiKeys 里写。');
    console.log('');
  }

  cfg._configPath = configPath;
  cfg._loopback = loopback;
  return cfg;
}

/* ------------------------------------------------------------------ *
 * 站点状态：两个站点各自找到了什么、现在启用哪些
 * ------------------------------------------------------------------ */

// siteState[key] = 定位结果 + 这个站点现在的画像（端点、账号、配置目录…）
let siteState = {};
let locateExtra = { unclassified: [], conflicts: [], packed: [] };
let activeSites = []; // 参与服务的站点，第一个是首选站点
let primarySite = '';
let modeWarnings = [];

function siteCfgOf(key) {
  return (cfg.sites && cfg.sites[key]) || { cliJs: '', home: '', model: '' };
}

// 每个站点一个工作目录，互不干扰
function siteCwd(key) {
  return path.join(cfg.cli.cwd, key);
}

function buildSiteState({ force = false } = {}) {
  const want = sites.SITE_ORDER.slice();
  const locCfg = {};
  for (const key of want) {
    const siteCfg = siteCfgOf(key);
    // 老配置把国内站的路径写在 cli.cliJs 里；命令行 --cli-js 只对国内站生效
    const legacy = key === 'cn' ? (cfg.cli.cliJsUser || cfg._cliJsArg || '') : '';
    locCfg[key] = { cliJs: siteCfg.cliJs || legacy, home: siteCfg.home || '' };
  }
  const res = locateAll({ appDir: APP_DIR, want, cfg: locCfg, force, log: (m) => console.log(m) });
  locateExtra = {
    unclassified: res.unclassified || [],
    conflicts: res.conflicts || [],
    packed: res.packed || [],
  };
  const next = {};
  for (const key of want) {
    const found = res.sites[key] || { ok: false, error: '没有找到这个站点' };
    const stat = sites.describeStatic(key, { homeOverride: siteCfgOf(key).home }) || {};
    next[key] = { ...found, ...stat, toolsCache: (siteState[key] && siteState[key].toolsCache) || null };
    const st = next[key];
    console.log(`[locate] ${st.label}  ${st.ok ? st.cliJs : '（没找到：' + st.error + '）'}`);
    if (st.ok) console.log(`[locate]   来源 ${st.source}${st.classifiedBy ? ' · ' + st.classifiedBy : ''}`);
    console.log(`[locate]   端点 ${st.endpoint || '未知'}${st.channel ? ' · ' + st.channel : ''}` +
      ` · 账号 ${st.account && st.account.loggedIn ? (st.account.nickname || st.account.uid) : '未登录'}` +
      ` · 配置目录 ${st.home || '未知'}${st.homeExists ? '' : '（不存在）'}`);
  }
  for (const u of locateExtra.unclassified) {
    console.log(`[locate] 找到一份 CLI 但不认识是哪个站：${u.cliJs}（${u.by}）—— 可以在控制台里手动指定`);
  }
  siteState = next;
}

// 现在到底用哪几个站点：模式 + 实际找到什么；指定的站点没找到就退而求其次，保证服务照常能用
function computeActiveSites() {
  const warnings = [];
  const available = sites.SITE_ORDER.filter((k) => siteState[k] && siteState[k].ok);
  const mode = cfg.sites.mode;
  let want = [];

  if (mode === 'both') want = available.slice();
  else if (mode === 'cn' || mode === 'intl') want = available.includes(mode) ? [mode] : [];
  else want = available.includes('cn') ? ['cn'] : (available.includes('intl') ? ['intl'] : []);

  if (!want.length && available.length) {
    want = [available[0]];
    warnings.push(`你指定只用${sites.siteLabel(mode)}，但这台机器上没找到它；已临时改用${sites.siteLabel(want[0])}，免得服务用不了。`);
  }
  if (!available.length) {
    warnings.push('国内站和国外站的 CLI 都没找到 —— 服务照常启动，但模型列表是空的、对话会失败。请在控制台里手动填 CLI 路径，或把它们装好。');
  }
  activeSites = want;
  primarySite = want[0] || '';
  modeWarnings = warnings;
  return warnings;
}

function refreshSiteState({ force = false } = {}) {
  buildSiteState({ force });
  return computeActiveSites();
}

function relocate(reason) {
  console.log(`[locate] 重新查找（${reason}）`);
  const warnings = refreshSiteState({ force: true });
  for (const w of warnings) console.log('[locate] ' + w);
  return {
    ok: activeSites.length > 0,
    sites: siteState,
    unclassified: locateExtra.unclassified,
    conflicts: locateExtra.conflicts,
    warnings,
  };
}

const args = parseArgs(process.argv.slice(2)); if (args.help || args.h) {
  console.log(`wb-relay ${VERSION}

用法: node wb-relay.js [选项]

  --port <n>              监听端口（默认 8790）
  --host <addr>           监听地址：127.0.0.1 只本机（默认）；0.0.0.0 允许局域网/公网
  --key <key>             访问密钥
  --trusted-origins <列表> 反向代理的域名白名单，逗号分隔，如 "https://abc.example.com,https://*.example.com"
  --public-url <地址>     对外（公网/自定义）地址，如 https://abc.example.com
  --lan-url <地址>        局域网地址，如 http://10.19.100.57:8790；不填则自动检测网卡
  --model <id>            默认模型（两个站点共用；各站点还能在自己的配置里覆盖）
  --cwd <dir>             工作目录根（默认 <程序目录>\\workspace，下面按站点分成 cn / intl）
  --cli-js <file>         手动指定「国内站」的 CLI 路径（国外站请写进 config.json 的 sites.intl.cliJs）
  --site <cn|intl|both>   临时改站点模式，覆盖 config.json 里的 sites.mode
  --allow-tools [列表]    放开工具权限（危险）：如 --allow-tools "Read,Grep"
  --config <file>         指定配置文件

接口:
  GET  /health
  GET  /v1/models
  POST /v1/chat/completions   OpenAI 兼容，支持 stream（可用 x-wb-site 点名站点）
  POST /v1/wb/prompt          { prompt, session?, model?, site? } 简易接口
`);
  process.exit(0);
}

const cfg = loadConfig(args);
if (cfg._siteArg) {
  if (SITE_MODES.includes(cfg._siteArg)) cfg.sites.mode = cfg._siteArg;
  else console.log(`[config] --site 只认 ${SITE_MODES.join(' / ')}，收到的是 "${cfg._siteArg}"，忽略`);
}
for (const w of refreshSiteState({ force: false })) console.log('[site] ' + w);
// 启动时实际绑定的地址。控制台改了监听范围后要拿它对比，才知道要不要重启
const listenHostAtStart = cfg.listen.host;

/* ------------------------------------------------------------------ *
 * 会话进程：一个常驻 CLI 进程 = 一段连续对话（按站点分开）
 * ------------------------------------------------------------------ */

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

function extractText(ev) {
  const msg = ev.message || ev;
  const content = msg.content;
  const parts = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === 'string') parts.push(c);
      else if (c && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'text' || !c.type)) parts.push(c.text);
    }
  }
  return parts.join('');
}

class Worker {
  constructor(cfg, key, systemPrompt, model, site) {
    this.cfg = cfg;
    this.key = key;
    this.site = site;
    this.systemPrompt = systemPrompt || '';
    this.model = model || ''; // 空 = 交给 WorkBuddy 自己的 auto
    this.child = null;
    this.buf = '';
    this.queue = Promise.resolve();
    this.sessionId = null;
    this.turns = 0;
    this.pending = null;
    this.lastUsed = Date.now();
    this.stderrTail = [];
    this.starting = null;
    this.partialRetry = false;
  }

  // 这个会话用哪个 CLI：跟着该站点当前定位到的路径走
  get cliJs() {
    const st = siteState[this.site];
    return (st && st.cliJs) || '';
  }

  get cwd() {
    return siteCwd(this.site);
  }

  spawnArgs() {
    const c = this.cfg.cli;
    const a = [this.cliJs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];
    // 关掉逐字流（控制台里的开关）或者这个 CLI 版本不认这个参数时，就不带它
    if (c.partialMessages !== false && !partialUnsupported) a.push(PARTIAL_FLAG);
    if (c.verbose) a.push('--verbose');
    if (this.model) a.push('--model', this.model);
    if (c.allowTools) {
      a.push('-y');
      if (c.allowedTools) {
        a.push('--allowedTools', c.allowedTools);
      } else {
        // 勾选框一个都没勾 = 什么工具都不给。
        // 不能靠「不传 --allowedTools」来表达这个意思 —— 那样配合 -y 反而是全部放开。
        a.push('--disallowedTools', toolCatalog(this.site).map((t) => t.name).join(','));
      }
    }
    if (this.systemPrompt) a.push('--append-system-prompt', this.systemPrompt);
    return a;
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      // CLI 可能被挪走/卸载重装，先确认路径还在，不在就把两个站点都重找一次
      if (!this.cliJs || !fs.existsSync(this.cliJs)) {
        const before = this.cliJs || '（空）';
        const res = relocate(`CLI 路径不存在：${before}`);
        const now = siteState[this.site];
        if (!now || !now.ok || !now.cliJs) {
          reject(new Error((now && now.error) || (res.warnings || []).join('；') || 'CLI 路径不可用'));
          return;
        }
      }
      log(`[worker:${this.key}] 启动 CLI 进程（${sites.siteLabel(this.site)}）`);
      const child = spawn(this.cfg.cli.nodeExe, this.spawnArgs(), {
        cwd: this.cwd,
        env: { ...process.env, CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let settled = false;
      const ok = () => { if (!settled) { settled = true; resolve(); } };
      const bad = (e) => { if (!settled) { settled = true; reject(e); } };

      child.on('error', (e) => bad(new Error(`无法启动 CLI：${e.message}`)));
      child.on('exit', (code, signal) => {
        const wasPending = this.pending;
        this.child = null;
        this.starting = null;
        if (wasPending) {
          wasPending.reject(new Error(`CLI 进程退出（code=${code} signal=${signal}）${this.stderrText()}`));
          this.pending = null;
        }
        if (settled) {
          log(`[worker:${this.key}] CLI 进程结束 code=${code}`);
          return;
        }
        // 启动即退出，而且这是第一次带逐字增量参数起：很可能这个 CLI 版本不认它。
        // 去掉参数原样重起一次 —— 逐字流只是个体验加成，不值得为它把整个服务搞挂。
        if (!this.partialRetry && !partialUnsupported) {
          this.partialRetry = true;
          settled = true;
          partialUnsupported = true;
          log(`[worker:${this.key}] 带 ${PARTIAL_FLAG} 起不来（${this.stderrText().trim() || 'code=' + code}），` +
            '判断这个 CLI 版本不支持它，改回整条消息模式重起一次');
          this.start().then(resolve, reject);
          return;
        }
        bad(new Error(`CLI 进程启动即退出（code=${code}）${this.stderrText()}`));
      });

      child.stdout.on('data', (d) => {
        this.buf += d.toString('utf8');
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          this.onEvent(ev, ok);
        }
      });
      child.stderr.on('data', (d) => {
        const s = d.toString('utf8');
        this.stderrTail.push(s);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        const t = s.trim();
        if (t && /error|失败|Error/i.test(t)) log(`[worker:${this.key}][stderr] ${t.slice(0, 300)}`);
      });

      // 有些版本 init 事件来得晚，用超时兜底放行
      setTimeout(ok, 8000);
    });
    return this.starting;
  }

  stderrText() {
    const t = this.stderrTail.join('').trim();
    return t ? ` stderr=${t.slice(-400)}` : '';
  }

  onEvent(ev, onReady) {
    const p = this.pending;
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) this.sessionId = ev.session_id;
      if (onReady) onReady();
      return;
    }
    if (!p) return;
    if (ev.session_id) this.sessionId = ev.session_id;

    // 带 --include-partial-messages 时，模型边生成边推这些事件。
    // 正文在 content_block_delta / text_delta 里；thinking_delta 是思考过程，不算答复，丢掉。
    if (ev.type === 'stream_event') {
      const e = ev.event;
      if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
        p.live += e.delta.text;
        if (p.onDelta) p.onDelta(e.delta.text);
      }
      return;
    }

    if (ev.type === 'assistant') {
      const text = extractText(ev);
      // 记下最后一条 assistant 文本：出错时 CLI 常常把原因放在这里（比如 "401 Unauthorized"），
      // 而 result 事件里的 result 字段是空的 —— 不留着的话用户只能看到一句「CLI 返回错误」
      if (text) p.lastText = text;
      const sent = p.live || p.emitted;
      if (sent) {
        // 正文已经逐字发过一遍，这个 assistant 事件是同一段话的整条快照 —— 再发就是重复。
        // 只在快照比已发的更长（中间漏了增量）时才补发尾巴。
        if (text.length > sent.length && text.startsWith(sent)) {
          const tail = text.slice(sent.length);
          if (p.live) p.live = text; else p.emitted = text;
          if (p.onDelta) p.onDelta(tail);
        }
        return;
      }
      // 没有逐字增量可用时才走这条：CLI 每轮会推多条 assistant 事件，
      // 后一条通常是前一条的完整版；只把「新增的后半段」当增量发出去，避免重复内容。
      if (text && text.length > p.emitted.length && text.startsWith(p.emitted)) {
        const delta = text.slice(p.emitted.length);
        p.emitted = text;
        if (p.onDelta) p.onDelta(delta);
      }
      return;
    }

    if (ev.type === 'result') {
      this.pending = null;
      this.turns++;
      this.lastUsed = Date.now();
      const finalText = typeof ev.result === 'string' ? ev.result : '';
      if (ev.is_error) {
        p.reject(new Error(finalText || p.lastText || 'CLI 返回错误'));
      } else {
        // 兜底：整轮一条都没发过，或者最终文本比已发的长，就把缺的那截补上
        const sent = p.live || p.emitted;
        if (finalText && p.onDelta && (!sent || (finalText.length > sent.length && finalText.startsWith(sent)))) {
          p.onDelta(sent ? finalText.slice(sent.length) : finalText);
        }
        const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
        if (denials.length) log(`[worker:${this.key}] 有 ${denials.length} 次工具调用被权限拦下（需要工具时用 --allow-tools 启动）`);
        p.resolve({
          text: finalText || p.emitted || p.live,
          sessionId: this.sessionId,
          usage: ev.usage || null,
          cost: ev.total_cost_usd,
          durationMs: ev.duration_ms,
        });
      }
    }
  }

  // 一段对话里同一时刻只跑一轮，其余排队
  ask(input, { onDelta }) {
    const run = () => this._askOne(input, onDelta);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async _askOne(input, onDelta) {
    await this.start();
    if (!this.child) throw new Error('CLI 进程不可用');
    this.lastUsed = Date.now();

    const payload = {
      type: 'user',
      message: { role: 'user', content: input.content },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === p) {
          this.pending = null;
          this.kill();
          reject(new Error(`单轮超时（${this.cfg.sessions.turnTimeoutMs}ms）`));
        }
      }, this.cfg.sessions.turnTimeoutMs);

      const p = {
        emitted: '',
        live: '',
        onDelta,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.pending = p;
      this.child.stdin.write(JSON.stringify(payload) + '\n', (e) => {
        if (e) {
          clearTimeout(timer);
          this.pending = null;
          reject(new Error(`写入 CLI stdin 失败：${e.message}`));
        }
      });
    });
  }

  kill() {
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill(); } catch {}
      this.child = null;
    }
    if (this.pending) {
      this.pending.reject(new Error('会话已被关闭'));
      this.pending = null;
    }
    this.starting = null;
  }

  get idleMs() {
    return Date.now() - this.lastUsed;
  }
}

const workers = new Map();

function getWorker(key, systemPrompt, model, site) {
  let w = workers.get(key);
  if (w) {
    w.lastUsed = Date.now();
    return w;
  }
  if (workers.size >= cfg.sessions.maxWorkers) {
    // 先回收最闲的
    let victim = null;
    for (const cand of workers.values()) {
      if (!cand.pending && (!victim || cand.idleMs > victim.idleMs)) victim = cand;
    }
    if (!victim) throw new Error(`并发会话数已达上限 ${cfg.sessions.maxWorkers}，请稍后重试`);
    log(`[pool] 回收空闲会话 ${victim.key}`);
    victim.kill();
    workers.delete(victim.key);
  }
  w = new Worker(cfg, key, systemPrompt, model, site);
  workers.set(key, w);
  return w;
}

setInterval(() => {
  for (const [k, w] of workers) {
    if (!w.pending && w.idleMs > cfg.sessions.idleMs) {
      log(`[pool] 回收超时会话 ${k}`);
      w.kill();
      workers.delete(k);
    }
  }
}, 60000).unref();

/* ------------------------------------------------------------------ *
 * 模型清单：按站点分开读，对外合并成一份
 * ------------------------------------------------------------------ */

// 读一个站点的清单（models.js 自己带 15 秒缓存，这里不用再缓存）
function catalogOf(key, { force = false } = {}) {
  const st = siteState[key] || {};
  return models.load({
    site: key,
    cliJs: st.cliJs || '',
    home: siteCfgOf(key).home || '',
    cwd: siteCwd(key),
    force,
  });
}

// 所有站点的清单（含没启用的 —— 报错时要告诉用户「这个模型属于哪个站」）
function allCatalogs({ force = false } = {}) {
  const out = {};
  for (const key of sites.SITE_ORDER) out[key] = catalogOf(key, { force });
  return out;
}

// 对外的合并清单（只含启用的站点）
function mergedCatalog({ force = false } = {}) {
  const cats = allCatalogs({ force });
  return { cats, merged: models.merged(activeSites, cats, cfg.models || []) };
}

// 某个站点的默认模型：站点自己的设置优先，其次是全局默认
function defaultModelFor(key) {
  return siteCfgOf(key).model || cfg.cli.model || '';
}

/**
 * 客户端要的模型名 → 落到哪个站点、哪个真实模型 id。
 * 除了模型名本身，还认请求头 x-wb-site / body.site（明确点名要用哪个站）。
 */
function resolveTarget(requested, siteHint = '') {
  const { cats } = mergedCatalog();
  const opts = { defaultModel: cfg.cli.model || '', defaultModelOf: defaultModelFor };
  const raw = typeof requested === 'string' ? requested.trim() : '';
  const hint = String(siteHint || '').trim().toLowerCase();

  if (hint) {
    if (!sites.isSiteKey(hint)) {
      return { error: `site 只认 cn（国内站）或 intl（国外站），收到的是 "${siteHint}"` };
    }
    if (!activeSites.includes(hint)) {
      return { error: `${sites.siteLabel(hint)}现在没有启用（当前模式：${MODE_LABEL[cfg.sites.mode]}）。请到控制台的「站点」里切换模式，或者换个模型名。` };
    }
    // 点名了站点，模型名就不用再带前缀了
    const bare = raw.replace(/^(cn|intl)\s*\/\s*/i, '');
    if (!bare || bare === 'workbuddy-auto') return { site: hint, model: defaultModelFor(hint), exposedId: bare || 'auto' };
    return { site: hint, model: bare, exposedId: hint === primarySite ? bare : hint + '/' + bare };
  }
  return models.resolveModel(raw, activeSites, cats, opts);
}

function notReadyError() {
  const missing = sites.SITE_ORDER.filter((k) => !(siteState[k] && siteState[k].ok)).map(sites.siteLabel);
  return `现在没有任何可用的站点（缺：${missing.join('、') || '未知'}）。请到控制台的「站点」里检查：要么把它装好，要么手动填 CLI 路径。`;
}

/* ------------------------------------------------------------------ *
 * OpenAI 兼容层
 * ------------------------------------------------------------------ */

function toCliContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') out.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      const m = /^data:([^;,]+);base64,(.+)$/.exec(part.image_url.url);
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else out.push({ type: 'text', text: `[图片URL未转发：${part.image_url.url.slice(0, 120)}]` });
    }
  }
  if (!out.length) out.push({ type: 'text', text: '' });
  return out;
}

const lastUserText = (content) => toCliContent(content).filter((c) => c.type === 'text').map((c) => c.text).join('');

function pickMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let systemPrompt = '';
  let lastUser = null;
  for (const m of messages) {
    if (m.role === 'system' && !systemPrompt) systemPrompt = lastUserText(m.content);
    if (m.role === 'user') lastUser = m;
  }
  if (!lastUser) throw new Error('messages 里没有 user 角色的内容');
  return { systemPrompt, content: toCliContent(lastUser.content) };
}

function sessionKeyOf(req, body) {
  const hdr = req.headers['x-wb-session'];
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  if (typeof body.user === 'string' && body.user.trim()) return body.user.trim();
  return 'default';
}

// 会话进程的身份 = 站点 + 会话名 + 模型（CLI 的模型是启动参数，换模型只能换进程）
function workerIdOf(site, sessionName, model) {
  return `${site}::${sessionName}::${model || 'auto'}`;
}

// 反过来把 worker key 拆开。会话名里带 :: 也不会拆错：站点固定在最前，模型固定在最后。
function splitWorkerId(id) {
  const parts = String(id || '').split('::');
  const site = sites.isSiteKey(parts[0]) ? parts[0] : '';
  const rest = site ? parts.slice(1) : parts;
  if (!rest.length) return { site, session: 'default', model: '' };
  const tail = rest[rest.length - 1];
  const hasModelPart = rest.length > 1;
  const model = (hasModelPart && tail !== 'auto') ? tail : '';
  const session = (hasModelPart ? rest.slice(0, -1) : rest).join('::') || 'default';
  return { site, session, model };
}

// HTTP 头只能放 ASCII。会话名可能是中文，直接用会让 Node 抛 ERR_INVALID_CHAR，
// 所以非 ASCII 的一律转成百分号编码（客户端解一下就能还原）。
function headerSafe(v) {
  const s = String(v ?? '');
  return /^[\x20-\x7e]*$/.test(s) ? s : encodeURIComponent(s);
}

// 工具清单：直接读该站点内置目录里的 tools，分类只是为了控制台上好找
const TOOL_GROUP = {
  Read: '只读 / 安全', Glob: '只读 / 安全', Grep: '只读 / 安全', WebFetch: '只读 / 安全', WebSearch: '只读 / 安全',
  TaskList: '只读 / 安全', TaskGet: '只读 / 安全', TaskOutput: '只读 / 安全', TaskStop: '只读 / 安全',
  ListMcpResources: '只读 / 安全', ReadMcpResource: '只读 / 安全', ToolSearch: '只读 / 安全',
  AskUserQuestion: '只读 / 安全', ExitPlanMode: '只读 / 安全',
  Write: '会改文件', Edit: '会改文件', NotebookEdit: '会改文件',
  Bash: '执行命令 / 危险', PowerShell: '执行命令 / 危险', Agent: '执行命令 / 危险', TaskCreate: '执行命令 / 危险',
  TaskUpdate: '执行命令 / 危险', Skill: '执行命令 / 危险', StructuredOutput: '执行命令 / 危险',
  DeferExecuteTool: '执行命令 / 危险', SendMessage: '执行命令 / 危险', TeamCreate: '执行命令 / 危险',
  TeamDelete: '执行命令 / 危险', ImageGen: '执行命令 / 危险', VideoGen: '执行命令 / 危险',
  WeChatReply: '执行命令 / 危险', WeComReply: '执行命令 / 危险', MessageColleague: '执行命令 / 危险',
  SpeakInChannel: '执行命令 / 危险', EnterPlanMode: '执行命令 / 危险',
};

// 两个站点的工具集可能不一样（比如国外站下线了多模态），所以按站点各读一份
function toolCatalog(site) {
  const key = sites.isSiteKey(site) ? site : primarySite;
  const st = siteState[key];
  const stamp = ((st && st.cliJs) || '') + '|' + key;
  if (st && st.toolsCache && st.toolsCache.for === stamp) return st.toolsCache.list;

  let names = [];
  const cliJs = st && st.cliJs;
  if (cliJs) {
    try {
      const j = JSON.parse(fs.readFileSync(sites.productJsonPath(cliJs), 'utf8').replace(/^\uFEFF/, ''));
      names = (j.tools || []).map((t) => t && t.name).filter(Boolean);
    } catch {}
  }
  if (!names.length) names = Object.keys(TOOL_GROUP); // 读不到就退回已知工具名
  const list = names.map((name) => ({ name, group: TOOL_GROUP[name] || '其它' }));
  list.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  if (st) st.toolsCache = { for: stamp, list };
  return list;
}

function checkAuth(req) {
  if (cfg.apiKeys.length === 0) return true;
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
  return cfg.apiKeys.some((k) => {
    const a = Buffer.from(k), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// 监听 0.0.0.0 时，列出别的设备能真正访问到的地址。
// 机器上装了 Clash / 虚拟机 / VPN 的话会有一堆虚拟网卡，把它们的地址列出来只会误导 ——
// 手机连 198.18.0.1 是连不上的。所以按网卡名和地址段打分筛一遍。
const VIRTUAL_IFACE = /(tun|tap|vpn|clash|nekoray|mihomo|wintun|wireguard|tailscale|zerotier|hyper-?v|vmware|virtualbox|vbox|wsl|mumu|docker|meta|utun|radmin|hamachi|virtual|vethernet)/i;
const UNREACHABLE_ADDR = /^(198\.1[89]\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/; // 基准测试段 / CGNAT

function scoreIface(name, addr) {
  let s = 0;
  if (VIRTUAL_IFACE.test(name)) s -= 100;
  if (UNREACHABLE_ADDR.test(addr)) s -= 100;
  if (/^192\.168\./.test(addr)) s += 30;
  else if (/^10\./.test(addr)) s += 20;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) s += 15;
  else s += 5;
  if (/wi-?fi|wlan|wireless|ethernet|以太网|无线|本地连接/i.test(name)) s += 10;
  return s;
}

function lanUrls() {
  const port = cfg.listen.port;
  const all = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue; // 链路本地，没用
      all.push({ url: `http://${a.address}:${port}`, iface: name, score: scoreIface(name, a.address) });
    }
  }
  const good = all.filter((x) => x.score >= 0);
  // 一块真实网卡都没有（比如整机只在 VPN 后面）就退回全部，总比什么都不显示强
  const picked = (good.length ? good : all)
    .sort((a, b) => b.score - a.score)
    .filter((x, i, arr) => arr.findIndex((y) => y.url === x.url) === i);
  return picked.map((x) => ({ url: x.url, iface: x.iface, likely: x.score >= 0 }));
}

// 去掉结尾斜杠，方便拼 /v1
const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

// 用户可能只写 "10.19.100.57" 或 "http://10.19.100.57"。
// 少端口是最常见的坑：那样会去访问 80 端口，那儿什么都没有，所以补上实际监听端口。
// 但只对 IP / localhost 这么做 —— 域名（http://abc.example.com）多半是走 80 的反代，不能乱补。
function normalizeBaseUrl(input, port) {
  let s = String(input || '').trim();
  if (!s) return { value: '', notes: [] };
  const notes = [];
  if (!/^https?:\/\//i.test(s)) {
    s = 'http://' + s;
    notes.push(`没写 http://，已补成 ${s}`);
  }
  let u;
  try { u = new URL(s); } catch { return { value: s, notes: [...notes, '这个地址解析不了'] }; }

  const bareHost = u.hostname.replace(/^\[|\]$/g, '');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost)
    || /^[0-9a-f:]+$/i.test(bareHost) && bareHost.includes(':');
  const isLocal = bareHost.toLowerCase() === 'localhost';

  if (!u.port) {
    if ((isIp || isLocal) && u.protocol === 'http:') {
      u.port = String(port);
      notes.push(`没写端口，已按程序监听的端口补成 ${u.protocol}//${u.host}`);
    } else if (u.protocol === 'http:') {
      notes.push('没写端口，按 80 端口处理（域名一般走反代/隧道，所以没替你补端口；如果这里其实是直连本机端口，请写成 IP:端口）');
    }
  }
  u.pathname = '';
  u.search = '';
  u.hash = '';
  return { value: trimSlash(u.toString()), notes };
}

// 判断某条对外地址“现在能不能用”，不能就给出具体原因和改法
function endpointStatus(base) {
  let u;
  try { u = new URL(base); } catch { return { available: false, reason: '地址解析不了' }; }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const host = u.hostname;

  if (port !== Number(cfg.listen.port)) {
    return {
      available: false,
      reason: `地址里的端口是 ${port}，但程序监听的是 ${cfg.listen.port}`,
      fix: `把地址改成 ${u.protocol}//${host}:${cfg.listen.port}`,
    };
  }

  if (['127.0.0.1', 'localhost', '::1'].includes(host)) return { available: true };

  if (cfg._loopback) {
    return {
      available: false,
      reason: '程序现在只监听本机（127.0.0.1），别的设备连不到这个地址',
      fix: '点这一栏下面的「保存设置」—— 会自动把监听改成对外，然后重启一次程序就生效',
    };
  }

  const localIps = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) localIps.push(a.address);
  }
  // 绑的是某一块网卡的具体地址时，只有那个地址能连
  if (cfg.listen.host !== '0.0.0.0' && cfg.listen.host !== '::') {
    if (host !== cfg.listen.host) {
      return {
        available: false,
        reason: `程序只绑在 ${cfg.listen.host} 这块网卡上`,
        fix: '把 listen.host 改成 0.0.0.0（或用这个地址对应的那块网卡地址）',
      };
    }
    return { available: true };
  }

  if (localIps.includes(host)) {
    return {
      available: true,
      // 本机能通不代表别的设备能通，防火墙是最常见的第二道坎
      note: '如果别的设备还是连不上，多半是 Windows 防火墙拦了。以管理员运行一次：'
        + `netsh advfirewall firewall add rule name="wb-relay ${cfg.listen.port}" dir=in action=allow protocol=TCP localport=${cfg.listen.port}`,
    };
  }

  return {
    available: null,
    reason: '这是外网地址，本机没法替你验证',
    fix: '确认隧道/反代已经生效，然后在别的设备上试；或点「测一下」看能不能拉到模型',
  };
}

// 给别的程序用的接入地址表。手填的优先，没填才用自动检测的结果。
function endpoints() {
  const port = cfg.listen.port;
  const out = [];
  const push = (label, base, note, autodetected) => {
    const b = trimSlash(base);
    if (!b) return;
    const st = endpointStatus(b);
    out.push({
      label,
      baseUrl: b + '/v1',
      pageUrl: b + '/',
      modelsUrl: b + '/v1/models',
      note: note || '',
      autodetected: Boolean(autodetected),
      available: st.available,
      reason: st.reason || '',
      fix: st.fix || '',
      extraNote: st.note || '',
    });
  };

  push('本机', `http://127.0.0.1:${port}`, '这台电脑自己用');

  const customLan = trimSlash(cfg.listen.lanBaseUrl);
  if (customLan) {
    push('局域网（你手填的）', customLan, '在控制台里自己填的');
  } else if (!cfg._loopback) {
    for (const x of lanUrls()) {
      push('局域网（自动检测）', x.url, (x.iface || '') + (x.likely ? '' : ' · 虚拟网卡，设备可能连不上'), true);
    }
  } else if (cfg.listen.port) {
    // 只监听本机时，局域网地址不会生效，但把提示留出来
    out.push({
      label: '局域网',
      baseUrl: '',
      pageUrl: '',
      modelsUrl: '',
      note: '还没填对外地址。在上面写上你真实的局域网地址（例如 http://10.19.100.57:' + port +
        '）或公网域名，保存后这条就会变成可直接用的接入地址',
      autodetected: true,
    });
  }

  const custom = trimSlash(cfg.listen.publicBaseUrl);
  if (custom) push('公网/自定义（你手填的）', custom, '在控制台里自己填的');

  return out;
}

// 改配置的接口要能证明请求来自控制台页面。同源放行；
// 套了反代时浏览器发的 Origin 是公网域名，需要 trustedOrigins 里显式声明。
function originAllowed(origin, host) {
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (o.host === host) return true;
  for (const raw of cfg.listen.trustedOrigins || []) {
    const pat = String(raw || '').trim();
    if (!pat) continue;
    if (pat === '*') return true;
    if (pat === origin) return true;
    const m = /^([a-z][a-z0-9+.-]*):\/\/\*\.(.+)$/i.exec(pat); // https://*.example.com
    if (m) {
      if (o.protocol !== m[1] + ':') continue;
      const base = m[2].toLowerCase();
      if (o.hostname.toLowerCase() === base || o.hostname.toLowerCase().endsWith('.' + base)) return true;
      continue;
    }
    try { if (new URL(pat).host === o.host) return true; } catch {}
  }
  return false;
}

function sendJson(res, code, obj, cors = true, extraHeaders = null) {
  const body = JSON.stringify(obj);
  const head = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  };
  if (cors) {
    head['access-control-allow-origin'] = '*';
    head['access-control-allow-headers'] = '*';
    head['access-control-allow-methods'] = 'GET,POST,OPTIONS';
  }
  if (extraHeaders) Object.assign(head, extraHeaders);
  res.writeHead(code, head);
  res.end(body);
}

function sendFile(res, file, type) {
  fs.readFile(file, (e, buf) => {
    if (e) return sendJson(res, 500, errBody(`读取 ${file} 失败：${e.message}`), false);
    res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' });
    res.end(buf);
  });
}

// 写回 config.json（只写已知字段，不碰别的）
function persistConfigTo(target, configPath) {
  const out = {
    listen: target.listen,
    apiKeys: target.apiKeys,
    cli: {
      // 只写用户自己填的值；自动找到的路径不固化进配置，挪了位置下次会自动重找
      nodeExe: target.cli.nodeExeUser,
      cliJs: target.cli.cliJsUser,
      cwd: target.cli.cwd,
      verbose: target.cli.verbose,
      allowTools: target.cli.allowTools,
      allowedTools: target.cli.allowedTools,
      systemPrompt: target.cli.systemPrompt,
      model: target.cli.model,
    },
    sites: { mode: target.sites.mode, cn: target.sites.cn, intl: target.sites.intl },
    sessions: target.sessions,
    models: target.models,
  };
  try {
    fs.writeFileSync(configPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    console.error('[config] 写回 config.json 失败：' + e.message);
    return false;
  }
}

function persistConfig() {
  return persistConfigTo(cfg, cfg._configPath);
}

const errBody = (msg, type = 'invalid_request_error', code = null) => ({ error: { message: msg, type, code } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON：' + e.message)); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * 站点连通自检（只在你点按钮时才真的去连，不跟着轮询跑）
 * ------------------------------------------------------------------ */

const lastSiteCheck = {}; // site → 最近一次结果

// 把技术错误翻译成「这台机器上通常是什么原因」
function netErrorHint(e) {
  const s = String((e && e.code) || '') + ' ' + String((e && e.message) || '');
  if (/secure TLS connection|ECONNRESET|socket disconnected|EPROTO/i.test(s)) {
    return 'TLS 握手被中断。最常见的两个原因：①代理（Clash/VPN）把该域名走了直连、或者那个节点出不去 —— 把它切到能出网的节点；'
      + '②安全软件在解密 HTTPS。注意：系统代理不是所有程序都认，所以「浏览器能打开这个网址」不代表这里的 CLI 能连上。';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(s)) return '域名解析不了 —— 检查 DNS，或者代理软件退出后 DNS 没恢复。';
  if (/ETIMEDOUT|timed? ?out/i.test(s)) return '连接超时 —— 网络本身不通，或者被规则拦掉了。';
  if (/CERT|self.signed|unable to verify|UNABLE_TO_VERIFY/i.test(s)) return '证书校验失败 —— 多半是中间人代理（公司网关 / 抓包工具）在解密 HTTPS。';
  return '';
}

function checkSiteConnectivity(key, timeoutMs = 8000) {
  const st = siteState[key] || {};
  const endpoint = st.endpoint || (sites.SITES[key] && sites.SITES[key].endpoint) || '';
  const cliJs = st.cliJs || '';
  return new Promise((resolve) => {
    const base = {
      site: key,
      siteLabel: sites.siteLabel(key),
      endpoint,
      cliPath: cliJs,
      cliExists: Boolean(cliJs && fs.existsSync(cliJs)),
      at: Date.now(),
    };
    if (!endpoint) return resolve({ ...base, ok: false, error: '不知道该连哪个地址（这个站点没被检测到，也没有端点信息）' });
    let u;
    try { u = new URL('/plugin', endpoint); } catch { return resolve({ ...base, ok: false, error: '端点地址解析不了：' + endpoint }); }
    const t0 = Date.now();
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'user-agent': 'wb-relay/' + VERSION },
    }, (res) => {
      res.resume();
      const status = res.statusCode || 0;
      resolve({
        ...base,
        ok: status < 500,
        status,
        ms: Date.now() - t0,
        note: status < 500
          ? `连得上（返回 HTTP ${status} 就说明网络和 TLS 都通，没登录是另一回事）`
          : `连上了但对方返回 ${status}，多半是中间那层代理/网关有问题`,
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', (e) => resolve({
      ...base,
      ok: false,
      ms: Date.now() - t0,
      error: e.message,
      code: e.code || '',
      hint: netErrorHint(e),
    }));
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 控制台状态
 * ------------------------------------------------------------------ */

function sitesPayload({ force = false } = {}) {
  const { cats, merged } = mergedCatalog({ force });
  const list = sites.SITE_ORDER.map((key) => {
    const st = siteState[key] || {};
    const cat = cats[key] || { models: [] };
    return {
      key,
      label: st.label || sites.siteLabel(key),
      short: st.short || '',
      ok: Boolean(st.ok),
      error: st.error || '',
      // 是自动找到的还是你手填的
      cliJs: st.cliJs || '',
      installDir: st.installDir || '',
      source: st.source || '',
      classifiedBy: st.classifiedBy || '',
      productName: st.productName || '',
      productEndpoint: st.productEndpoint || '',
      userCliJs: siteCfgOf(key).cliJs || '',
      userHome: siteCfgOf(key).home || '',
      mismatch: st.mismatch || '',
      // 站点画像
      home: st.home || '',
      homeExists: Boolean(st.homeExists),
      homeSource: st.homeSource || '',
      homeCandidates: st.homeCandidates || [],
      endpoint: st.endpoint || '',
      endpointSource: st.endpointSource || '',
      endpointExpected: st.endpointExpected || '',
      channel: st.channel || '',
      channelExpected: st.channelExpected || '',
      account: st.account || null,
      loggedIn: Boolean(st.loggedIn),
      cloud: st.cloud || null,
      model: defaultModelFor(key),
      enabled: activeSites.includes(key),
      primary: primarySite === key,
      catalog: {
        count: (cat.models || []).length,
        source: cat.source || '',
        sourceFile: cat.sourceFile || '',
        sourceMtime: cat.sourceMtime || 0,
        loadedAt: cat.loadedAt || 0,
        customCount: cat.customCount || 0,
        home: cat.home || '',
        counts: merged.perSite[key] || { count: 0 },
      },
      check: lastSiteCheck[key] || null,
    };
  });
  return {
    mode: cfg.sites.mode,
    modeLabel: MODE_LABEL[cfg.sites.mode] || cfg.sites.mode,
    activeSites: activeSites.slice(),
    primary: primarySite,
    list,
    warnings: modeWarnings.slice(),
    unclassified: locateExtra.unclassified || [],
    conflicts: locateExtra.conflicts || [],
    cacheFile: require('./locate.js').cachePath(APP_DIR),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  if (url.pathname === '/health') {
    // 对外暴露时 /health 不带鉴权，所以只回最基本的信息，不泄露会话名和路径
    if (cfg.apiKeys.length > 0 && !checkAuth(req)) {
      return sendJson(res, 200, { status: 'ok', version: VERSION, authRequired: true });
    }
    const primary = siteState[primarySite] || {};
    return sendJson(res, 200, {
      status: 'ok',
      version: VERSION,
      uptime: process.uptime(),
      workers: [...workers.keys()],
      // 老字段：首选站点的 CLI 路径
      cli: primary.cliJs || '',
      auth: cfg.apiKeys.length > 0,
      tools: cfg.cli.allowTools,
      siteMode: cfg.sites.mode,
      sites: activeSites.map((key) => {
        const st = siteState[key] || {};
        return {
          key,
          label: st.label || sites.siteLabel(key),
          cli: st.cliJs || '',
          account: st.account ? (st.account.nickname || st.account.uid) : '',
          loggedIn: Boolean(st.loggedIn),
        };
      }),
    });
  }

  // 控制台页面本身不需要密钥（就是一张静态页面，没有秘密）。
  // 否则配了密钥之后，浏览器连页面都打不开 —— 它拿到的是 401 JSON 而不是网页。
  // 真正的数据和控制能力仍然在后面所有 /api/* /v1/* 上校验。
  if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    return sendFile(res, path.join(APP_DIR, 'public', 'index.html'), 'text/html; charset=utf-8');
  }

  if (!checkAuth(req)) return sendJson(res, 401, errBody('无效或缺失的 API Key', 'authentication_error'));

  // 把两个站点里能用的模型全部报出去，每条都标出属于哪个站
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const { merged } = mergedCatalog();
    const kindFilter = url.searchParams.get('kind');
    const picked = kindFilter ? merged.models.filter((m) => m.kind === kindFilter) : merged.models;
    const data = picked.map((m) => ({
      id: m.exposedId,
      object: 'model',
      created: 0,
      owned_by: 'workbuddy-relay',
      // 下面几个是非标准字段，普通客户端会忽略，脚本和控制台能用
      name: m.name,
      kind: m.kind,
      site: m.site,
      site_label: m.siteLabel,
      site_model_id: m.siteModelId,
      credits: m.credits,
      context_length: m.contextLength,
      supports_tools: m.supportsTools,
      supports_images: m.supportsImages,
      recommended: m.recommended,
    }));
    const primaryCat = merged.perSite[primarySite] || {};
    return sendJson(res, 200, {
      object: 'list',
      data,
      _count: data.length,
      // 老字段：首选站点的来源（脚本可能在看它）
      _source: primaryCat.source || '',
      _sites: activeSites.slice(),
      _site_mode: cfg.sites.mode,
      _site_sources: Object.fromEntries(Object.entries(merged.perSite).map(([k, v]) => [k, { source: v.source, count: v.count }])),
      _site_labels: Object.fromEntries(sites.SITE_ORDER.map((k) => [k, sites.siteLabel(k)])),
      _hint: activeSites.length > 1
        ? `两个站点都启用了：首选站点（${sites.siteLabel(primarySite)}）的模型 id 是原样；另一个站点的模型带前缀，例如 intl/xxx。也可以用请求头 x-wb-site 点名要用哪个站。`
        : '',
    });
  }

  /* ---------- 控制台接口 ---------- */

  if (url.pathname.startsWith('/api/')) {
    // 这些接口能改权限（等于改这台机器的执行权），所以要能证明请求来自控制台页面：
    // 跨站表单发不出自定义头，带 Origin 时必须同源
    if (req.method === 'POST') {
      if (req.headers['x-wb-relay'] !== '1') {
        return sendJson(res, 403, errBody('缺少 x-wb-relay 请求头，拒绝执行', 'forbidden'), false);
      }
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin, req.headers.host)) {
        return sendJson(res, 403, errBody(
          `请求来源 ${origin} 未被放行。如果你是通过反向代理/域名访问的，请把该域名加进 config.json 的 listen.trustedOrigins。`,
          'forbidden',
        ), false);
      }
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const { cats, merged } = mergedCatalog();
      const siteInfo = sitesPayload();
      const primary = siteState[primarySite] || {};
      const primaryPer = merged.perSite[primarySite] || {};
      return sendJson(res, 200, {
        version: VERSION,
        uptime: process.uptime(),
        listen: cfg.listen,
        bindAll: !cfg._loopback,
        lanUrls: lanUrls(),
        endpoints: endpoints(),
        modelHint: defaultModelFor(primarySite) || 'workbuddy-auto',
        // 老字段：都指「首选站点」
        cliPath: primary.cliJs || '',
        cwd: primarySite ? siteCwd(primarySite) : cfg.cli.cwd,
        locate: {
          source: primary.source || '',
          installDir: primary.installDir || '',
          userOverride: siteCfgOf(primarySite).cliJs || cfg.cli.cliJsUser || '',
          cacheFile: require('./locate.js').cachePath(APP_DIR),
        },
        authRequired: cfg.apiKeys.length > 0,
        // 控制台要能把密钥显示/复制出来，方便填到别的程序里
        apiKey: cfg.apiKeys[0] || '',
        hostMode: cfg._hostMode || '',
        sites: siteInfo,
        config: {
          cli: {
            allowTools: cfg.cli.allowTools,
            allowedTools: cfg.cli.allowedTools,
            partialMessages: cfg.cli.partialMessages !== false,
            systemPrompt: cfg.cli.systemPrompt,
            model: cfg.cli.model,
            verbose: cfg.cli.verbose,
            cwd: cfg.cli.cwd,
          },
          sites: { mode: cfg.sites.mode, cn: cfg.sites.cn, intl: cfg.sites.intl },
          sessions: {
            maxWorkers: cfg.sessions.maxWorkers,
            idleMs: cfg.sessions.idleMs,
            turnTimeoutMs: cfg.sessions.turnTimeoutMs,
            prewarm: cfg.sessions.prewarm,
          },
          models: cfg.models,
        },
        catalog: {
          source: primaryPer.source || '',
          sourceFile: primaryPer.sourceFile || '',
          sourceMtime: primaryPer.sourceMtime || 0,
          loadedAt: Date.now(),
          customCount: merged.models.filter((m) => m.source === 'custom').length,
          counts: merged.counts,
          models: merged.models,
          activeSites: merged.activeSites.slice(),
          primary: merged.primary,
          perSite: merged.perSite,
          // 每个站点各自的完整清单（含未启用的站点）—— 控制台里给「该站默认模型」下拉用
          bySite: Object.fromEntries(sites.SITE_ORDER.map((k) => [k, (cats[k] && cats[k].models) || []])),
        },
        tools: toolCatalog(primarySite),
        sessions: [...workers.values()].map((w) => {
          const parsed = splitWorkerId(w.key);
          return {
            id: w.key,
            site: parsed.site,
            siteLabel: sites.siteLabel(parsed.site),
            session: parsed.session,
            model: parsed.model,
            turns: w.turns,
            idleMs: w.idleMs,
            busy: Boolean(w.pending),
          };
        }),
        restartOnly: [
          '监听地址、端口、访问密钥（改 config.json 后重启程序）',
          '工作目录根（下面按站点分成 cn / intl，改完对新会话生效）',
          '这里改的设置只对「新建」的会话生效，已存在的会话要清空后才会按新设置重建',
          '站点的手填路径、站点模式、反代域名白名单都是例外，改完立刻生效',
        ],
      }, false);
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, errBody(e.message), false); }
      const warnings = [];
      const cli = body.cli || {};
      const ses = body.sessions || {};

      if (typeof cli.allowTools === 'boolean') cfg.cli.allowTools = cli.allowTools;
      if (typeof cli.allowedTools === 'string') {
        const known = new Set(toolCatalog(primarySite).map((t) => t.name));
        const picked = cli.allowedTools.split(',').map((x) => x.trim()).filter(Boolean);
        const unknown = picked.filter((x) => !known.has(x));
        if (unknown.length) warnings.push('不认识这些工具名，照样写入了：' + unknown.join(', '));
        cfg.cli.allowedTools = picked.join(',');
      }
      if (typeof cli.systemPrompt === 'string') cfg.cli.systemPrompt = cli.systemPrompt.slice(0, 20000);

      if (typeof cli.partialMessages === 'boolean') {
        // 这个参数是在 CLI 进程启动时定下的，所以改完只对新会话起作用
        if (cli.partialMessages !== cfg.cli.partialMessages) {
          warnings.push(`流式输出已切成「${cli.partialMessages ? '逐字' : '整条消息'}」——` +
            '已经跑着的会话还按老方式，清空会话后新建的才按新方式');
        }
        cfg.cli.partialMessages = cli.partialMessages;
      }

      if (typeof cli.model === 'string') {
        const m = cli.model.trim();
        if (m) {
          const { cats } = mergedCatalog();
          if (!sites.SITE_ORDER.some((k) => (cats[k]?.models || []).some((x) => x.id === m))) {
            warnings.push(`模型 "${m}" 不在任何站点的清单里，依然写入了，但 WorkBuddy 不认的话会报错`);
          }
        }
        cfg.cli.model = m;
      }

      // ---- 站点设置 ----
      let siteChanged = false;
      const siteBody = body.sites && typeof body.sites === 'object' ? body.sites : null;
      if (siteBody) {
        if (typeof siteBody.mode === 'string') {
          const m = siteBody.mode.trim();
          if (SITE_MODES.includes(m)) {
            if (m !== cfg.sites.mode) siteChanged = true;
            cfg.sites.mode = m;
          } else {
            warnings.push(`站点模式只认 ${SITE_MODES.join(' / ')}，收到的是 "${m}"，已忽略`);
          }
        }
        for (const key of sites.SITE_ORDER) {
          const one = siteBody[key];
          if (!one || typeof one !== 'object') continue;
          if (typeof one.cliJs === 'string') {
            const v = one.cliJs.trim();
            if (v !== cfg.sites[key].cliJs) siteChanged = true;
            if (v) {
              if (!fs.existsSync(v)) warnings.push(`${sites.siteLabel(key)} 的手填 CLI 路径不存在：${v}（先存着，等它出现了就能用）`);
              else {
                const cls = sites.classifyCli(v);
                if (cls.site && cls.site !== key) {
                  warnings.push(`${sites.siteLabel(key)} 里填的路径看起来是${sites.siteLabel(cls.site)}的安装（识别依据：${cls.by}），已照样使用，但请确认没填反。`);
                }
              }
            }
            cfg.sites[key].cliJs = v;
          }
          if (typeof one.home === 'string') {
            const v = one.home.trim();
            if (v !== cfg.sites[key].home) siteChanged = true;
            if (v && !fs.existsSync(v)) warnings.push(`${sites.siteLabel(key)} 的手填配置目录不存在：${v}`);
            cfg.sites[key].home = v;
          }
          if (typeof one.model === 'string') {
            const v = one.model.trim();
            if (v) {
              const cat = catalogOf(key, { force: true });
              if (!cat.models.some((x) => x.id === v)) warnings.push(`${sites.siteLabel(key)} 的默认模型 "${v}" 不在该站清单里，依然写入了`);
            }
            cfg.sites[key].model = v;
          }
        }
      }

      const clamp = (v, lo, hi, name) => {
        const n = Number(v);
        if (!Number.isFinite(n)) { warnings.push(name + ' 不是数字，已忽略'); return null; }
        const c = Math.min(hi, Math.max(lo, Math.round(n)));
        if (c !== n) warnings.push(`${name} 超出范围（${lo}~${hi}），已按 ${c} 处理`);
        return c;
      };
      if (ses.maxWorkers !== undefined) { const v = clamp(ses.maxWorkers, 1, 16, '最大并行会话数'); if (v) cfg.sessions.maxWorkers = v; }
      if (ses.idleMs !== undefined) { const v = clamp(ses.idleMs, 60000, 86400000, '空闲回收'); if (v) cfg.sessions.idleMs = v; }
      if (ses.turnTimeoutMs !== undefined) { const v = clamp(ses.turnTimeoutMs, 60000, 7200000, '单轮超时'); if (v) cfg.sessions.turnTimeoutMs = v; }
      if (typeof ses.prewarm === 'boolean') cfg.sessions.prewarm = ses.prewarm;

      if (Array.isArray(body.models)) {
        cfg.models = body.models.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
      }

      // 站点设置变了就立刻重新判定（手填路径要马上能用，不用重启）
      if (siteChanged) {
        for (const x of refreshSiteState({ force: false })) warnings.push(x);
        warnings.push('站点设置已重新判定，立刻生效。已经跑起来的会话不会被迁移，想按新设置重建请清空会话。');
      }

      // 对外接入地址：用户自己填，程序只负责补全和让它可以真的生效
      let filledExternal = false;
      const applyBase = (raw, field, label) => {
        const { value, notes } = normalizeBaseUrl(raw, cfg.listen.port);
        for (const n of notes) warnings.push(`${label}：${n}`);
        cfg.listen[field] = value;
        if (value && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(value)) filledExternal = true;
        return value;
      };

      if (typeof body.publicBaseUrl === 'string') {
        const s = applyBase(body.publicBaseUrl, 'publicBaseUrl', '公网/自定义地址');
        if (s) {
          // 填了域名就顺手放行它的 Origin，省得待会儿「保存设置」莫名其妙 403
          try {
            const o = new URL(s);
            const origin = o.protocol + '//' + o.host;
            const list = cfg.listen.trustedOrigins || [];
            if (!list.includes(origin)) {
              cfg.listen.trustedOrigins = [...list, origin];
              warnings.push(`已把 ${origin} 加进反代域名白名单（不然从那个域名打开控制台时，保存设置会被 403 挡掉）`);
            }
          } catch {
            warnings.push(`"${s}" 不是一个能解析的合法网址`);
          }
        }
      }
      if (typeof body.lanBaseUrl === 'string') {
        applyBase(body.lanBaseUrl, 'lanBaseUrl', '局域网地址');
      }

      // 对外地址填了但只监听本机时，自动把监听改成对外（否则那个地址填了也白填）
      const wantsExternal = filledExternal
        || Boolean(trimSlash(cfg.listen.lanBaseUrl)) || Boolean(trimSlash(cfg.listen.publicBaseUrl));
      if (wantsExternal && cfg._loopback) {
        cfg.listen.host = '0.0.0.0';
        cfg._hostMode = 'auto→对外（因为填了对外地址）';
        warnings.push('监听范围已改成对外（0.0.0.0）—— 需要重启程序才会生效');
      }

      // 访问密钥：完全由用户决定。留空 = 不校验（谁都能访问）；填了就按它校验。
      if (Array.isArray(body.apiKeys) || typeof body.apiKeys === 'string') {
        const list = (Array.isArray(body.apiKeys) ? body.apiKeys : [body.apiKeys])
          .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5);
        const had = cfg.apiKeys.length > 0;
        cfg.apiKeys = list;
        if (list.length && !had) warnings.push('已开启访问密钥校验 —— 从别的设备访问时要在右上角填这个密钥');
        if (!list.length && had) warnings.push('已关闭访问密钥校验 —— 现在任何能连上的人都能使用和改设置');
        if (list.length && !cfg._loopback) {
          warnings.push('注意：这个服务是对外监听的，密钥就是唯一的门禁，别用太短的');
        }
      }

      // 反代域名白名单：改完立刻生效，不用重启
      if (Array.isArray(body.trustedOrigins)) {
        const list = body.trustedOrigins.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
        for (const o of list) {
          if (o !== '*' && !/^https?:\/\//i.test(o)) {
            warnings.push(`来源 "${o}" 不像一个网址（要带 http:// 或 https://），照样写入了但匹配不到`);
          }
        }
        cfg.listen.trustedOrigins = list;
      }

      persistConfig();
      log(`[console] 配置已更新：站点模式=${cfg.sites.mode} 启用=${activeSites.join('+') || '无'} 工具权限=${cfg.cli.allowTools ? '放开' : '关闭'} 流式=${cfg.cli.partialMessages !== false ? '逐字' : '整条消息'} 默认模型=${cfg.cli.model || 'auto'} 白名单=${cfg.cli.allowedTools || '(全部)'}`);
      return sendJson(res, 200, {
        ok: true,
        warnings,
        activeSessions: [...workers.keys()],
        apiKeys: cfg.apiKeys,
        sites: sitesPayload(),
        // 监听范围变了的话，必须重启才生效 —— 顺手把重启命令给出去
        needsRestart: cfg.listen.host !== listenHostAtStart,
        restartCommand: `cd /d "${APP_DIR}" && node wb-relay.js`,
        endpoints: endpoints(),
      }, false);
    }

    if (url.pathname === '/api/models/refresh' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch { /* 允许空 body */ }
      const beforeCats = allCatalogs();
      const beforeMerged = models.merged(activeSites, beforeCats, cfg.models || []);
      const before = beforeMerged.models.map((m) => m.exposedId);

      const only = typeof body.site === 'string' && sites.isSiteKey(body.site) ? body.site : '';
      let cats;
      try {
        cats = only ? { ...beforeCats, [only]: catalogOf(only, { force: true }) } : allCatalogs({ force: true });
      } catch (e) {
        return sendJson(res, 500, errBody('重新读取模型清单失败：' + e.message), false);
      }
      const merged = models.merged(activeSites, cats, cfg.models || []);
      const after = merged.models.map((m) => m.exposedId);
      const added = after.filter((x) => !before.includes(x));
      const removed = before.filter((x) => !after.includes(x));

      const perSite = {};
      for (const key of sites.SITE_ORDER) {
        const now = cats[key] || { models: [] };
        const prev = beforeCats[key] || { models: [] };
        const nowIds = (now.models || []).map((m) => m.id);
        const prevIds = (prev.models || []).map((m) => m.id);
        const one = {
          label: sites.siteLabel(key),
          enabled: activeSites.includes(key),
          count: nowIds.length,
          source: now.source || '',
          sourceFile: now.sourceFile || '',
          sourceMtime: now.sourceMtime || 0,
          fileAgeMs: now.sourceMtime ? Date.now() - now.sourceMtime : null,
          loadedAt: now.loadedAt || Date.now(),
          added: nowIds.filter((x) => !prevIds.includes(x)),
          removed: prevIds.filter((x) => !nowIds.includes(x)),
        };
        one.changed = one.added.length > 0 || one.removed.length > 0;
        perSite[key] = one;
      }

      const primaryPer = merged.perSite[primarySite] || {};
      log(`[console] 重新拉取模型：共 ${after.length} 个` +
        sites.SITE_ORDER.map((k) => ` · ${sites.siteLabel(k)} ${perSite[k].count} 个${perSite[k].enabled ? '' : '（未启用）'}`).join(''));
      return sendJson(res, 200, {
        ok: true,
        count: after.length,
        changed: added.length > 0 || removed.length > 0,
        added,
        removed,
        // 老字段：首选站点的信息
        source: primaryPer.source || '',
        sourceFile: primaryPer.sourceFile || '',
        sourceMtime: primaryPer.sourceMtime || 0,
        fileAgeMs: primaryPer.sourceMtime ? Date.now() - primaryPer.sourceMtime : null,
        loadedAt: Date.now(),
        perSite,
        activeSites: activeSites.slice(),
      }, false);
    }

    if (url.pathname === '/api/locate' && req.method === 'POST') {
      const loc = relocate('控制台手动触发');
      const primary = siteState[primarySite] || {};
      const found = sites.SITE_ORDER.filter((k) => siteState[k] && siteState[k].ok).map(sites.siteLabel);
      return sendJson(res, 200, {
        ok: activeSites.length > 0,
        // 老字段：首选站点
        cliJs: primary.cliJs || '',
        source: primary.source || '',
        // 新字段
        sites: sitesPayload().list,
        activeSites: activeSites.slice(),
        primary: primarySite,
        unclassified: locateExtra.unclassified || [],
        conflicts: locateExtra.conflicts || [],
        warnings: loc.warnings || [],
        summary: found.length
          ? `找到：${found.join('、')}；当前启用：${activeSites.map(sites.siteLabel).join('、')}`
          : '国内站和国外站的 CLI 都没找到（服务照常运行，但没有模型可用）',
      }, false);
    }

    // 站点连通自检：真的去连一次那个站点的端点，把「为什么连不上」说清楚
    if (url.pathname === '/api/sites/check' && req.method === 'POST') {
      let body = {};
      try { body = await readBody(req); } catch { /* 允许空 body */ }
      const want = typeof body.site === 'string' && sites.isSiteKey(body.site) ? [body.site] : sites.SITE_ORDER.slice();
      const results = [];
      for (const key of want) {
        const r = await checkSiteConnectivity(key);
        lastSiteCheck[key] = r;
        results.push(r);
        log(`[console] 连通自检 ${sites.siteLabel(key)}：${r.ok ? `通（HTTP ${r.status}，${r.ms}ms）` : '不通 —— ' + (r.error || '')}`);
      }
      return sendJson(res, 200, { ok: true, results }, false);
    }

    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, errBody(e.message), false); }
      let cleared = 0;
      if (body.all) {
        for (const w of workers.values()) { w.kill(); cleared++; }
        workers.clear();
      } else if (typeof body.id === 'string' && body.id) {
        const w = workers.get(body.id);
        if (w) { w.kill(); workers.delete(body.id); cleared = 1; }
      } else {
        return sendJson(res, 400, errBody('需要 id 或 all:true'), false);
      }
      log(`[console] 清空了 ${cleared} 个会话`);
      return sendJson(res, 200, { ok: true, cleared }, false);
    }

    return sendJson(res, 404, errBody('未知路径：' + url.pathname, 'not_found'), false);
  }

  if (url.pathname === '/v1/wb/prompt' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, errBody(e.message)); }
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt) return sendJson(res, 400, errBody('缺少 prompt'));
    if (!activeSites.length) return sendJson(res, 503, errBody(notReadyError(), 'server_error'));

    const sessionName = typeof body.session === 'string' && body.session.trim() ? body.session.trim() : 'default';
    const target = resolveTarget(body.model, req.headers['x-wb-site'] || body.site || '');
    if (target.error) return sendJson(res, 400, errBody(target.error));
    const wkey = workerIdOf(target.site, sessionName, target.model);
    if (body.new) {
      for (const [k, w] of [...workers]) {
        if (splitWorkerId(k).session === sessionName) { w.kill(); workers.delete(k); }
      }
    }
    try {
      const w = getWorker(wkey, typeof body.system === 'string' ? body.system : '', target.model, target.site);
      const r = await w.ask({ content: [{ type: 'text', text: prompt }] }, {});
      return sendJson(res, 200, {
        text: r.text,
        session: sessionName,
        model: target.model || 'auto',
        site: target.site,
        site_label: sites.siteLabel(target.site),
        cli_session_id: r.sessionId,
        usage: r.usage,
        duration_ms: r.durationMs,
      });
    } catch (e) {
      log(`[/v1/wb/prompt] 出错：${e.message}`);
      return sendJson(res, 500, errBody(e.message, 'server_error'));
    }
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, errBody(e.message)); }

    let picked;
    try { picked = pickMessages(body); } catch (e) { return sendJson(res, 400, errBody(e.message)); }

    if (!activeSites.length) return sendJson(res, 503, errBody(notReadyError(), 'server_error'));

    const sessionName = sessionKeyOf(req, body);
    const requestedModel = typeof body.model === 'string' && body.model ? body.model : 'workbuddy-auto';
    const target = resolveTarget(requestedModel, req.headers['x-wb-site'] || body.site || '');
    if (target.error) return sendJson(res, 400, errBody(target.error));
    const workerKey = workerIdOf(target.site, sessionName, target.model);

    if (Boolean(body.new_session) || req.headers['x-wb-new-session'] === '1') {
      for (const [k, w] of [...workers]) {
        if (splitWorkerId(k).session === sessionName) { w.kill(); workers.delete(k); }
      }
    }

    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;

    let worker;
    try {
      // 只在会话第一次真正开始时，把客户端的 system 提示词带进去
      const freshSystem = (!workers.has(workerKey) && picked.systemPrompt) ? picked.systemPrompt : '';
      worker = getWorker(workerKey, freshSystem || cfg.cli.systemPrompt, target.model, target.site);
    } catch (e) {
      return sendJson(res, 429, errBody(e.message, 'rate_limit_error'));
    }

    // 站点归属也通过 HTTP 头告诉调用方（JSON 里还有一份带中文标签的）
    const siteBody = {
      'x-wb-site': target.site,
      'x-wb-site-label': sites.siteLabel(target.site),
      'x-wb-model': target.model || 'auto',
      'x-wb-session': sessionName,
    };
    const siteHeaders = {
      'x-wb-site': target.site,
      'x-wb-model': headerSafe(target.model || 'auto'),
      'x-wb-session': headerSafe(sessionName),
    };

    if (!stream) {
      try {
        const r = await worker.ask({ content: picked.content }, {});
        return sendJson(res, 200, {
          id, object: 'chat.completion', created,
          model: requestedModel,
          choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
          usage: r.usage ? {
            prompt_tokens: r.usage.input_tokens || 0,
            completion_tokens: r.usage.output_tokens || 0,
            total_tokens: (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0),
          } : undefined,
          ...siteBody,
          'x-wb-cli-session': r.sessionId,
        }, true, siteHeaders);
      } catch (e) {
        log(`[/v1/chat/completions] 出错：${e.message}`);
        return sendJson(res, 500, errBody(e.message, 'server_error'));
      }
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
      ...siteHeaders,
    });

    const chunk = (delta, finish = null) => ({
      id, object: 'chat.completion.chunk', created, model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const write = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    write(chunk({ role: 'assistant', content: '' }));

    // 等 CLI 出结果可能很久（跑 agent 任务时），用 SSE 注释行保持连接
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, cfg.sessions.keepAliveHintMs);

    const includeUsage = Boolean(body.stream_options && body.stream_options.include_usage);
    try {
      const r = await worker.ask({ content: picked.content }, { onDelta: (d) => write(chunk({ content: d })) });
      write(chunk({}, 'stop'));
      if (includeUsage && r.usage) {
        write({
          id, object: 'chat.completion.chunk', created, model: requestedModel, choices: [],
          usage: {
            prompt_tokens: r.usage.input_tokens || 0,
            completion_tokens: r.usage.output_tokens || 0,
            total_tokens: (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0),
          },
        });
      }
      if (!res.writableEnded) res.write('data: [DONE]\n\n');
    } catch (e) {
      log(`[/v1/chat/completions:stream] 出错：${e.message}`);
      write({ error: { message: e.message, type: 'server_error' } });
      if (!res.writableEnded) res.write('data: [DONE]\n\n');
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  sendJson(res, 404, errBody('未知路径：' + url.pathname, 'not_found'));
});

// 端口被占用之类的启动失败，给一句人话，别甩一堆堆栈
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  [启动失败] 端口 ${cfg.listen.port} 已经被占用了。`);
    console.error('             多半是已经有一个 wb-relay 在跑 —— 关掉那个窗口，或者在任务管理器里结束 node。');
    console.error(`             想同时跑两个就换端口：node wb-relay.js --port ${Number(cfg.listen.port) + 1}`);
    console.error('');
    process.exit(1);
  }
  if (e.code === 'EACCES') {
    console.error(`\n  [启动失败] 没有权限监听端口 ${cfg.listen.port}（1024 以下的端口需要管理员）。换个大端口吧。\n`);
    process.exit(1);
  }
  console.error(`\n  [启动失败] ${e.message}\n`);
  process.exit(1);
});

server.listen(cfg.listen.port, cfg.listen.host, () => {
  const local = `http://127.0.0.1:${cfg.listen.port}`;
  const lan = cfg._loopback ? [] : lanUrls();
  console.log('');
  console.log(`  wb-relay ${VERSION}`);
  console.log(`  本机访问  ${local}   ← 本机始终可用`);
  for (const x of lan) console.log(`  局域网    ${x.url}${x.likely ? '' : '  (虚拟网卡，设备可能连不上)'}  [${x.iface}]`);
  console.log(`  监听      ${cfg.listen.host}:${cfg.listen.port}${cfg._loopback ? '（只监听本机）' : '（所有网卡）'}`);
  console.log(`  站点模式  ${MODE_LABEL[cfg.sites.mode] || cfg.sites.mode}`);
  for (const key of sites.SITE_ORDER) {
    const st = siteState[key] || {};
    const who = st.account && st.account.loggedIn ? (st.account.nickname || st.account.uid) : '未登录';
    const perModel = siteCfgOf(key).model;
    console.log(`  ${activeSites.includes(key) ? '●' : '○'} ${st.label || sites.siteLabel(key)}` +
      `${activeSites.includes(key) ? '（启用中）' : '（未启用）'}  ${st.ok ? st.cliJs : '（没找到 CLI：' + (st.error || '') + '）'}`);
    console.log(`      端点 ${st.endpoint || '未知'}  ·  账号 ${who}  ·  模型 ${(catalogOf(key).models || []).length} 个` +
      `  ·  默认模型 ${perModel || cfg.cli.model || '(交给 WorkBuddy 自己选)'}`);
    console.log(`      配置目录 ${st.home || '未知'}${st.homeExists ? '' : '（不存在）'}`);
  }
  console.log(`  工作目录  根 ${cfg.cli.cwd}，下面按站点分成 cn / intl`);
  console.log(`  工具权限  ${cfg.cli.allowTools
    ? (cfg.cli.allowedTools ? '白名单：' + cfg.cli.allowedTools : '已放开但白名单为空 → 不给任何工具')
    : '未放开（纯问答）'}`);
  console.log(`  流式输出  ${cfg.cli.partialMessages !== false
    ? '逐字（流式请求一个字一个字往外推）'
    : '整条消息（等整段写完才发；控制台里可以切回逐字）'}`);
  console.log(`  鉴权      ${cfg.apiKeys.length ? '需要 API Key' : cfg._loopback ? '本机回环，未设密钥' : '需要 API Key'}`);
  if (!cfg._loopback) {
    console.log(`  反代域名  ${(cfg.listen.trustedOrigins || []).join(', ') || '(未配置；套反代后控制台改设置会 403)'}`);
  }
  console.log('');
  console.log(`  控制台：浏览器打开 ${local}${lan.length ? '（或上面局域网地址）' : ''}`);
  if (activeSites.length > 1) {
    console.log('  两个站点都在跑：国内站的模型 id 原样（如 deepseek-v4-pro），国外站的带 intl/ 前缀（如 intl/gpt-5.6-sol）');
  }
  if (cfg._loopback) {
    console.log('  想从手机/别的电脑访问：加 --host 0.0.0.0 --key <一个长随机串> 重启');
  } else if (cfg.apiKeys.length === 0) {
    console.log('  注意：对外监听但没设密钥 —— 现在任何能连上的人都能用它跑模型、也能改设置');
  }
  if (!cfg._loopback && cfg.cli.allowTools) {
    console.log('');
    console.log('  ⚠ 警告：现在同时对局域网/公网提供访问，而且工具权限是放开的。');
    console.log('     任何拿到密钥的人都能在这台机器上读写文件、执行命令。');
    console.log('     不要把这种状态直接暴露到公网；要么关掉工具权限，要么只在自己可信的网络里用。');
  }
  console.log('');

  if (cfg.sessions.prewarm && primarySite) {
    const defaultModel = defaultModelFor(primarySite);
    const w = getWorker(workerIdOf(primarySite, 'default', defaultModel), cfg.cli.systemPrompt, defaultModel, primarySite);
    w.start().then(
      () => log(`[pool] ${sites.siteLabel(primarySite)} 的 default 会话已预热，首次调用无需等待进程冷启动`),
      (e) => log('[pool] 预热失败（不影响使用）：' + e.message),
    );
  }
});

function shutdown() {
  log('退出中，关闭所有会话…');
  for (const w of workers.values()) w.kill();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
