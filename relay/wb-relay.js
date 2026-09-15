#!/usr/bin/env node
/*
 * wb-relay —— 把本机 WorkBuddy 的能力反代成一个本地 HTTP 服务
 *
 * 前端：OpenAI 兼容接口（/v1/models、/v1/chat/completions，支持 SSE 流式）
 * 后端：常驻一个 WorkBuddy CLI 进程，通过 stdin/stdout 的 stream-json 长连接多轮对话
 *
 * 为什么用常驻进程而不是每次拉一个新的：CLI 冷启动在这台机器上要 3~8 秒，
 * 常驻之后第二轮起只要 2 秒左右（实测）。
 *
 * 无第三方依赖，只用 Node 内置模块。
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const models = require('./models.js');
const { locate } = require('./locate.js');

const VERSION = '1.1.0';
const APP_DIR = __dirname;

const DEFAULT_CONFIG = {
  listen: { host: '127.0.0.1', port: 8790 },
  // 留空 = 本机回环不校验；填了就必须带 Authorization: Bearer <key>
  apiKeys: [],
  cli: {
    nodeExe: '', // 空 = 用运行本程序的 node
    cliJs: '', // 空 = 自动查找 WorkBuddy 的 CLI（见 locate.js）
    cwd: '', // 空 = <程序目录>\workspace，故意用一个干净目录
    verbose: true,
    // 默认不给工具权限：未授权时文件/命令类工具会被拦下，只能纯聊天问答
    allowTools: false,
    allowedTools: '', // 配合 allowTools，如 "Read,Grep,WebSearch"
    systemPrompt: '', // 追加到系统提示词
    model: '', // 固定模型，如 "deepseek-v4-pro"；空 = 用 WorkBuddy 的 auto
  },
  sessions: {
    maxWorkers: 4, // 最多几个并行会话进程
    idleMs: 30 * 60 * 1000, // 会话空闲这么久就回收
    turnTimeoutMs: 15 * 60 * 1000, // 单轮最长等待
    keepAliveHintMs: 15000, // SSE 心跳间隔
    // 开机就把 default 会话的 CLI 进程拉起来，省掉第一次调用要等的约 10 秒冷启动
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
      fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error(`[config] 解析 ${configPath} 失败：${e.message}`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    console.log(`[config] 已生成默认配置：${configPath}`);
  }

  let cfg = deepMerge(DEFAULT_CONFIG, fileCfg);

  // 命令行覆盖
  if (args.port) cfg.listen.port = Number(args.port);
  if (typeof args.host === 'string') cfg.listen.host = args.host;
  if (typeof args.key === 'string') cfg.apiKeys = [args.key];
  if (typeof args.model === 'string') cfg.cli.model = args.model;
  if (typeof args.cwd === 'string') cfg.cli.cwd = args.cwd;
  if (typeof args['allow-tools'] === 'string') {
    cfg.cli.allowTools = true;
    cfg.cli.allowedTools = args['allow-tools'];
  } else if (args['allow-tools'] === true) {
    cfg.cli.allowTools = true;
  }

  // 用户手写的值要留着，写回配置时不能把自动找到的路径固化进去
  cfg.cli.cliJsUser = typeof cfg.cli.cliJs === 'string' ? cfg.cli.cliJs : '';
  cfg.cli.nodeExeUser = typeof cfg.cli.nodeExe === 'string' ? cfg.cli.nodeExe : '';
  if (!cfg.cli.nodeExe) cfg.cli.nodeExe = process.execPath;

  // 命令行给的路径优先级最高，但只影响本次运行，不写回配置文件
  cfg.cli._cliJsArg = typeof args['cli-js'] === 'string' ? args['cli-js'] : '';
  applyLocation(locate({ appDir: APP_DIR, explicit: cfg.cli._cliJsArg || cfg.cli.cliJsUser, log: (m) => console.log(m) }), true, cfg);

  if (!cfg.cli.cwd) cfg.cli.cwd = path.join(APP_DIR, 'workspace');
  fs.mkdirSync(cfg.cli.cwd, { recursive: true });

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.listen.host);
  if (!loopback && cfg.apiKeys.length === 0) {
    console.error('[config] 拒绝启动：监听地址对外（' + cfg.listen.host + '）但没有配置 apiKeys。');
    console.error('         要么改回 127.0.0.1，要么在 config.json 的 apiKeys 里放一个密钥。');
    process.exit(1);
  }

  cfg._configPath = configPath;
  cfg._loopback = loopback;
  return cfg;
}

// 把定位结果装进配置；启动阶段失败就直接退出，运行阶段失败只报错
function applyLocation(res, fatal, target) {
  if (res.ok) {
    target.cli.cliJs = res.cliJs;
    target.cli.installDir = res.installDir || '';
    target.cli.locateSource = res.source || '';
    target._toolCache = null;
    try { models.load(res.cliJs, target.cli.cwd || '', { force: true }); } catch {}
    console.log(`[locate] CLI    ${res.cliJs}`);
    console.log(`[locate] 来源   ${res.source}`);
    return true;
  }
  console.error('[locate] ' + res.error);
  if (fatal) process.exit(1);
  return false;
}

let relocating = false;
// 重新查找：缓存路径失效、CLI 被挪走时调用
function relocate(reason) {
  if (relocating) return { ok: false, error: '正在重新查找，请稍候' };
  relocating = true;
  try {
    console.log(`[locate] 重新查找（${reason}）`);
    const res = locate({ appDir: APP_DIR, explicit: cfg.cli._cliJsArg || cfg.cli.cliJsUser, force: true, log: (m) => console.log(m) });
    applyLocation(res, false, cfg);
    return res;
  } finally {
    relocating = false;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(`wb-relay ${VERSION}

用法: node wb-relay.js [选项]

  --port <n>              监听端口（默认 8790）
  --host <addr>           监听地址（默认 127.0.0.1；对外必须同时配 apiKeys）
  --key <key>             访问密钥
  --model <id>            固定模型（默认跟随 WorkBuddy 的 auto）
  --cwd <dir>             会话工作目录（默认 <程序目录>\\workspace）
  --cli-js <file>         手动指定 WorkBuddy CLI 路径（默认自动查找，见 locate.js）
  --allow-tools [列表]    放开工具权限（危险）：如 --allow-tools "Read,Grep"
  --config <file>         指定配置文件

接口:
  GET  /health
  GET  /v1/models
  POST /v1/chat/completions   OpenAI 兼容，支持 stream
  POST /v1/wb/prompt          { prompt, session? } 简易接口
`);
  process.exit(0);
}

const cfg = loadConfig(args);

/* ------------------------------------------------------------------ *
 * 会话进程：一个常驻 CLI 进程 = 一段连续对话
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
  constructor(cfg, key, systemPrompt, model) {
    this.cfg = cfg;
    this.key = key;
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
  }

  spawnArgs() {
    const c = this.cfg.cli;
    const a = [c.cliJs, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (c.verbose) a.push('--verbose');
    if (this.model) a.push('--model', this.model);
    if (c.allowTools) {
      a.push('-y');
      if (c.allowedTools) {
        a.push('--allowedTools', c.allowedTools);
      } else {
        // 勾选框一个都没勾 = 什么工具都不给。
        // 不能靠「不传 --allowedTools」来表达这个意思 —— 那样配合 -y 反而是全部放开。
        a.push('--disallowedTools', toolCatalog().map((t) => t.name).join(','));
      }
    }
    if (this.systemPrompt) a.push('--append-system-prompt', this.systemPrompt);
    return a;
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const c = this.cfg.cli;
      // CLI 可能被挪走/卸载重装，先确认路径还在，不在就重新找一次
      if (!fs.existsSync(c.cliJs)) {
        const res = relocate('CLI 路径不存在：' + c.cliJs);
        if (!res.ok) { reject(new Error(res.error)); return; }
      }
      log(`[worker:${this.key}] 启动 CLI 进程`);
      const child = spawn(c.nodeExe, this.spawnArgs(), {
        cwd: c.cwd,
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
        if (!settled) bad(new Error(`CLI 进程启动即退出（code=${code}）${this.stderrText()}`));
        else log(`[worker:${this.key}] CLI 进程结束 code=${code}`);
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

    if (ev.type === 'assistant') {
      const text = extractText(ev);
      // CLI 每轮会推多条 assistant 事件，后一条通常是前一条的完整版；
      // 只把「新增的后半段」当增量发出去，避免重复内容。
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
        p.reject(new Error(finalText || 'CLI 返回错误'));
      } else {
        if (!p.emitted && finalText && p.onDelta) p.onDelta(finalText);
        const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
        if (denials.length) log(`[worker:${this.key}] 有 ${denials.length} 次工具调用被权限拦下（需要工具时用 --allow-tools 启动）`);
        p.resolve({
          text: finalText || p.emitted,
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

function getWorker(key, systemPrompt, model) {
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
  w = new Worker(cfg, key, systemPrompt, model);
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

// 客户端要的模型 → 实际传给 CLI 的 --model
// 空 / workbuddy-auto = 用控制台里设的默认模型，默认模型也空就交给 WorkBuddy 自己选
function resolveModel(requested) {
  const r = typeof requested === 'string' ? requested.trim() : '';
  if (!r || r === 'workbuddy-auto') return cfg.cli.model || '';
  return r;
}

// 会话进程的身份 = 会话名 + 模型（CLI 的模型是启动参数，换模型只能换进程）
function workerIdOf(sessionName, model) {
  return `${sessionName}::${model || 'auto'}`;
}

// 工具清单：直接读 WorkBuddy 内置目录里的 tools，分类只是为了控制台上好找
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

function toolCatalog() {
  if (cfg._toolCache) return cfg._toolCache;
  const p = path.join(path.dirname(path.dirname(cfg.cli.cliJs)), 'product.json');
  let names = [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    names = (j.tools || []).map((t) => t && t.name).filter(Boolean);
  } catch {}
  if (!names.length) names = Object.keys(TOOL_GROUP); // 读不到就退回已知工具名
  const list = names.map((name) => ({ name, group: TOOL_GROUP[name] || '其它' }));
  list.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  cfg._toolCache = list;
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

function sendJson(res, code, obj, cors = true) {
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

// 控制台改完配置后写回 config.json（只写已知字段，不碰别的）
function persistConfig() {
  const out = {
    listen: cfg.listen,
    apiKeys: cfg.apiKeys,
    cli: {
      // 只写用户自己填的值；自动找到的路径不固化进配置，挪了位置下次会自动重找
      nodeExe: cfg.cli.nodeExeUser,
      cliJs: cfg.cli.cliJsUser,
      cwd: cfg.cli.cwd,
      verbose: cfg.cli.verbose,
      allowTools: cfg.cli.allowTools,
      allowedTools: cfg.cli.allowedTools,
      systemPrompt: cfg.cli.systemPrompt,
      model: cfg.cli.model,
    },
    sessions: cfg.sessions,
    models: cfg.models,
  };
  try {
    fs.writeFileSync(cfg._configPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  } catch (e) {
    log('[config] 写回 config.json 失败：' + e.message);
  }
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      version: VERSION,
      uptime: process.uptime(),
      workers: [...workers.keys()],
      cli: cfg.cli.cliJs,
      auth: cfg.apiKeys.length > 0,
      tools: cfg.cli.allowTools,
    });
  }

  if (!checkAuth(req)) return sendJson(res, 401, errBody('无效的 API Key', 'authentication_error'));

  // 网页控制台
  if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    return sendFile(res, path.join(APP_DIR, 'public', 'index.html'), 'text/html; charset=utf-8');
  }

  // 把 WorkBuddy 里能用的模型全部报出去
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const cat = models.load(cfg.cli.cliJs, cfg.cli.cwd);
    const kindFilter = url.searchParams.get('kind');
    const data = (kindFilter ? cat.models.filter((m) => m.kind === kindFilter) : cat.models).map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'workbuddy-relay',
      // 下面几个是非标准字段，普通客户端会忽略，脚本和控制台能用
      name: m.name,
      kind: m.kind,
      credits: m.credits,
      context_length: m.contextLength,
      supports_tools: m.supportsTools,
      supports_images: m.supportsImages,
      recommended: m.recommended,
    }));
    for (const extra of cfg.models) {
      if (!data.some((x) => x.id === extra)) {
        data.push({ id: extra, object: 'model', created: 0, owned_by: 'workbuddy-relay', kind: 'alias' });
      }
    }
    return sendJson(res, 200, { object: 'list', data, _source: cat.source, _count: data.length });
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
      if (origin) {
        let same = false;
        try { same = new URL(origin).host === req.headers.host; } catch {}
        if (!same) return sendJson(res, 403, errBody('请求来源与本站不一致，拒绝执行', 'forbidden'), false);
      }
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const cat = models.load(cfg.cli.cliJs, cfg.cli.cwd);
      const counts = { total: cat.models.length, chat: 0, completion: 0, image: 0, video: 0 };
      for (const m of cat.models) if (counts[m.kind] !== undefined) counts[m.kind]++;
      return sendJson(res, 200, {
        version: VERSION,
        uptime: process.uptime(),
        listen: cfg.listen,
        cliPath: cfg.cli.cliJs,
        cwd: cfg.cli.cwd,
        locate: {
          source: cfg.cli.locateSource || '',
          installDir: cfg.cli.installDir || '',
          userOverride: cfg.cli.cliJsUser || '',
          cacheFile: require('./locate.js').cachePath(APP_DIR),
        },
        authRequired: cfg.apiKeys.length > 0,
        config: {
          cli: {
            allowTools: cfg.cli.allowTools,
            allowedTools: cfg.cli.allowedTools,
            systemPrompt: cfg.cli.systemPrompt,
            model: cfg.cli.model,
            verbose: cfg.cli.verbose,
          },
          sessions: {
            maxWorkers: cfg.sessions.maxWorkers,
            idleMs: cfg.sessions.idleMs,
            turnTimeoutMs: cfg.sessions.turnTimeoutMs,
            prewarm: cfg.sessions.prewarm,
          },
          models: cfg.models,
        },
        catalog: {
          source: cat.source,
          sourceFile: cat.sourceFile,
          sourceMtime: cat.sourceMtime,
          loadedAt: cat.loadedAt,
          customCount: cat.customCount,
          counts,
          models: cat.models,
        },
        tools: toolCatalog(),
        sessions: [...workers.values()].map((w) => {
          const [session, model] = w.key.split('::');
          return {
            id: w.key,
            session,
            model: model === 'auto' ? '' : model,
            turns: w.turns,
            idleMs: w.idleMs,
            busy: Boolean(w.pending),
          };
        }),
        restartOnly: [
          '监听地址、端口、访问密钥（改 config.json 后重启程序）',
          'CLI 路径、工作目录、verbose 开关',
          '这里改的设置只对「新建」的会话生效，已存在的会话要清空后才会按新设置重建',
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
        const known = new Set(toolCatalog().map((t) => t.name));
        const picked = cli.allowedTools.split(',').map((x) => x.trim()).filter(Boolean);
        const unknown = picked.filter((x) => !known.has(x));
        if (unknown.length) warnings.push('不认识这些工具名，照样写入了：' + unknown.join(', '));
        cfg.cli.allowedTools = picked.join(',');
      }
      if (typeof cli.systemPrompt === 'string') cfg.cli.systemPrompt = cli.systemPrompt.slice(0, 20000);

      if (typeof cli.model === 'string') {
        const m = cli.model.trim();
        if (m) {
          const cat = models.load(cfg.cli.cliJs, cfg.cli.cwd);
          if (!cat.models.some((x) => x.id === m)) {
            warnings.push(`模型 "${m}" 不在当前清单里，依然写入了，但 WorkBuddy 不认的话会报错`);
          }
        }
        cfg.cli.model = m;
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

      persistConfig();
      log(`[console] 配置已更新：工具权限=${cfg.cli.allowTools ? '放开' : '关闭'} 默认模型=${cfg.cli.model || 'auto'} 白名单=${cfg.cli.allowedTools || '(全部)'}`);
      return sendJson(res, 200, { ok: true, warnings, activeSessions: [...workers.keys()] }, false);
    }

    if (url.pathname === '/api/models/refresh' && req.method === 'POST') {
      const before = models.load(cfg.cli.cliJs, cfg.cli.cwd).models.map((m) => m.id);
      let cat;
      try {
        cat = models.load(cfg.cli.cliJs, cfg.cli.cwd, { force: true });
      } catch (e) {
        return sendJson(res, 500, errBody('重新读取模型清单失败：' + e.message), false);
      }
      const after = cat.models.map((m) => m.id);
      const added = after.filter((x) => !before.includes(x));
      const removed = before.filter((x) => !after.includes(x));
      log(`[console] 重新拉取模型：${after.length} 个（新增 ${added.length}，移除 ${removed.length}）`);
      return sendJson(res, 200, {
        ok: true,
        count: after.length,
        source: cat.source,
        sourceFile: cat.sourceFile,
        sourceMtime: cat.sourceMtime,
        fileAgeMs: cat.sourceMtime ? Date.now() - cat.sourceMtime : null,
        loadedAt: cat.loadedAt,
        added,
        removed,
        changed: added.length > 0 || removed.length > 0,
      }, false);
    }

    if (url.pathname === '/api/locate' && req.method === 'POST') {
      const loc = relocate('控制台手动触发');
      return sendJson(res, loc.ok ? 200 : 500, loc, false);
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
    const sessionName = typeof body.session === 'string' && body.session.trim() ? body.session.trim() : 'default';
    const model = resolveModel(body.model);
    const wkey = workerIdOf(sessionName, model);
    if (body.new) {
      for (const [k, w] of [...workers]) {
        if (k.split('::')[0] === sessionName) { w.kill(); workers.delete(k); }
      }
    }
    try {
      const w = getWorker(wkey, typeof body.system === 'string' ? body.system : '', model);
      const r = await w.ask({ content: [{ type: 'text', text: prompt }] }, {});
      return sendJson(res, 200, {
        text: r.text,
        session: sessionName,
        model: model || 'auto',
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

    const sessionName = sessionKeyOf(req, body);
    const requestedModel = typeof body.model === 'string' && body.model ? body.model : 'workbuddy-auto';
    const model = resolveModel(requestedModel);
    const workerKey = workerIdOf(sessionName, model);

    if (Boolean(body.new_session) || req.headers['x-wb-new-session'] === '1') {
      for (const [k, w] of [...workers]) {
        if (k.split('::')[0] === sessionName) { w.kill(); workers.delete(k); }
      }
    }

    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;

    let worker;
    try {
      // 只在会话第一次真正开始时，把客户端的 system 提示词带进去
      const freshSystem = (!workers.has(workerKey) && picked.systemPrompt) ? picked.systemPrompt : '';
      worker = getWorker(workerKey, freshSystem || cfg.cli.systemPrompt, model);
    } catch (e) {
      return sendJson(res, 429, errBody(e.message, 'rate_limit_error'));
    }

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
          'x-wb-session': sessionName,
          'x-wb-model': model || 'auto',
          'x-wb-cli-session': r.sessionId,
        });
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
    });

    const chunk = (delta, finish = null) => ({
      id, object: 'chat.completion.chunk', created, model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const write = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    write(chunk({ role: 'assistant', content: '' }));

    // 等 CLI 出结果可能很久（跑 agent 任务时），用 SSE 注释行保持连接
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, cfg.sessions.keepAliveHintMs);

    let includeUsage = Boolean(body.stream_options && body.stream_options.include_usage);
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

server.listen(cfg.listen.port, cfg.listen.host, () => {
  console.log('');
  console.log(`  wb-relay ${VERSION}`);
  console.log(`  监听      http://${cfg.listen.host}:${cfg.listen.port}`);
  console.log(`  CLI       ${cfg.cli.cliJs}`);
  console.log(`            （来源：${cfg.cli.locateSource || '未记录'}）`);
  console.log(`  工作目录  ${cfg.cli.cwd}`);
  console.log(`  模型      ${cfg.cli.model || '(跟随 WorkBuddy auto)'}`);
  console.log(`  工具权限  ${cfg.cli.allowTools ? '已放开 ' + (cfg.cli.allowedTools || '(全部)') : '未放开（纯问答）'}`);
  console.log(`  鉴权      ${cfg.apiKeys.length ? '需要 API Key' : cfg._loopback ? '本机回环，未设密钥' : '需要 API Key'}`);
  console.log('');
  console.log('  试一下：');
  console.log(`    curl http://127.0.0.1:${cfg.listen.port}/health`);
  console.log(`    curl -N -X POST http://127.0.0.1:${cfg.listen.port}/v1/chat/completions \\`);
  console.log('      -H "content-type: application/json" \\');
  console.log('      -d "{\\"model\\":\\"workbuddy-auto\\",\\"stream\\":true,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}"');
  console.log('');

  if (cfg.sessions.prewarm) {
    const defaultModel = cfg.cli.model || '';
    const w = getWorker(workerIdOf('default', defaultModel), cfg.cli.systemPrompt, defaultModel);
    w.start().then(
      () => log('[pool] default 会话已预热，首次调用无需等待进程冷启动'),
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
