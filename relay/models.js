/*
 * WorkBuddy 可用模型清单
 *
 * 三个来源，优先级从高到低：
 *   1. WorkBuddy 自己缓存的云端配置（~/.workbuddy/local_storage/*.info）—— 这是账号实际下发的清单，最新
 *   2. CLI 安装目录里的内置目录（product.json）—— 缓存缺失时的兜底
 *   3. 用户自己加的自定义模型（~/.workbuddy/models.json）—— 补充进去
 *
 * 只做只读解析，不写任何 WorkBuddy 的文件。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 清单缓存有效期。控制台每 5 秒轮询状态，所以最迟这么久之后就能看到 WorkBuddy 的模型变化；
// 想立刻刷新就用控制台的「拉取最新模型」按钮。
const TTL_MS = 15 * 1000;
let cache = null;

/* ---------- 来源 1：云端配置缓存 ---------- */

function readLiveConfig() {
  const dirs = [
    path.join(os.homedir(), '.workbuddy', 'local_storage'),
    path.join(os.homedir(), '.codebuddy', 'local_storage'),
  ];
  const hits = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile() || st.size < 3000) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      // 结构是 [{ data: { models: [...] , agents, modelPromotions } }]
      const data = Array.isArray(j) ? j[0] && j[0].data : j && j.data;
      if (!data || !Array.isArray(data.models) || !data.models.length) continue;
      hits.push({ file: p, mtime: st.mtimeMs, data });
    }
  }
  if (!hits.length) return null;
  // 模型最多的那份就是主配置
  hits.sort((a, b) => b.data.models.length - a.data.models.length || b.mtime - a.mtime);
  return hits[0];
}

/* ---------- 来源 2：内置目录 ---------- */

function readProductJson(cliJs) {
  // cliJs 形如 ...\cli\bin\codebuddy，内置目录在 cli\product.json
  const candidates = [
    path.join(path.dirname(path.dirname(cliJs)), 'product.json'),
    path.join(path.dirname(path.dirname(cliJs)), 'product.internal.json'),
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(j.models) && j.models.length) {
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch {}
        return { file: p, models: j.models, mtime };
      }
    } catch {}
  }
  return null;
}

/* ---------- 来源 3：用户自定义模型 ---------- */

function readCustomModels(cwd) {
  const files = [
    path.join(os.homedir(), '.workbuddy', 'models.json'),
    path.join(os.homedir(), '.codebuddy', 'models.json'),
    cwd ? path.join(cwd, '.workbuddy', 'models.json') : null,
    cwd ? path.join(cwd, '.codebuddy', 'models.json') : null,
  ].filter(Boolean);

  const out = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!Array.isArray(j.models)) continue;
    for (const m of j.models) {
      if (!m || !m.id) continue;
      out.push({ ...m, __source: 'custom', __file: f });
    }
  }
  return out;
}

/* ---------- 归一化 ---------- */

const MEDIA_KINDS = new Set(['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video']);
// 这几个是「快速 / 均衡 / 极致」这类档位别名，排在最前面方便选
const ALIAS_ORDER = ['auto', 'fast-model', 'balanced-model', 'deep-model'];

function kindOf(m) {
  const tags = Array.isArray(m.tags) ? m.tags : [];
  if (tags.some((t) => MEDIA_KINDS.has(t))) return tags.some((t) => t.includes('video')) ? 'video' : 'image';
  if (m.supportsToolCall) return 'chat';
  return 'completion';
}

function normalize(m, source) {
  return {
    id: String(m.id),
    name: m.name || String(m.id),
    vendor: m.vendor || '',
    kind: kindOf(m),
    credits: typeof m.credits === 'string' ? m.credits : '',
    contextLength: m.maxInputTokens || 0,
    maxOutputTokens: m.maxOutputTokens || 0,
    supportsTools: Boolean(m.supportsToolCall),
    supportsImages: Boolean(m.supportsImages),
    supportsReasoning: Boolean(m.supportsReasoning),
    isDefault: Boolean(m.isDefault),
    description: m.descriptionZh || m.descriptionEn || '',
    // 自定义模型自己的接入信息，只在控制台里展示
    customUrl: m.url || '',
    source,
  };
}

function sortModels(list) {
  const rank = (m) => {
    const i = ALIAS_ORDER.indexOf(m.id);
    if (i >= 0) return i;
    if (m.kind === 'chat') return 10;
    if (m.kind === 'completion') return 20;
    return 30;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/* ---------- 对外的加载入口 ---------- */

function load(cliJs, cwd, { force = false } = {}) {
  if (cache && !force && Date.now() - cache.loadedAt < TTL_MS) return cache;

  const live = readLiveConfig();
  let list = [];
  let source = '';
  let sourceFile = '';
  let sourceMtime = 0;

  if (live) {
    list = live.data.models.map((m) => normalize(m, 'cloud'));
    source = '云端配置缓存';
    sourceFile = live.file;
    sourceMtime = live.mtime;
  } else {
    const prod = readProductJson(cliJs);
    if (prod) {
      list = prod.models.map((m) => normalize(m, 'builtin'));
      source = '内置目录（未找到云端缓存）';
      sourceFile = prod.file;
      sourceMtime = prod.mtime || 0;
    } else {
      source = '未找到任何模型来源';
    }
  }

  // 官方为该 agent 推荐的模型（缓存里 agents 里带 models 白名单）
  const recommended = new Set();
  try {
    const cliAgent = (live ? live.data.agents : [])?.find?.((a) => a && a.name === 'cli');
    for (const id of cliAgent?.models || []) recommended.add(id);
  } catch {}

  // 自定义模型补充（同 id 覆盖）
  const custom = readCustomModels(cwd);
  for (const c of custom) {
    const norm = normalize(c, 'custom');
    norm.customUrl = c.url || '';
    const i = list.findIndex((x) => x.id === norm.id);
    if (i >= 0) list[i] = { ...list[i], ...norm, kind: norm.kind === 'completion' ? list[i].kind : norm.kind };
    else list.push(norm);
  }

  for (const m of list) m.recommended = recommended.has(m.id);
  list = sortModels(list);

  cache = {
    loadedAt: Date.now(),
    source,
    sourceFile,
    sourceMtime,
    models: list,
    customCount: custom.length,
    promotions: live?.data?.modelPromotions || [],
  };
  return cache;
}

// 促销信息（限时折扣之类），控制台里展示用
function promotionsFor(catalog, modelId) {
  return catalog.promotions.filter((p) => p && p.enabled !== false && Array.isArray(p.modelIds) && p.modelIds.includes(modelId));
}

module.exports = { load, promotionsFor, TTL_MS };
