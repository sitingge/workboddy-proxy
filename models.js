/*
 * WorkBuddy 可用模型清单 —— 国内站、国外站各读各的
 *
 * 每个站点三个来源，优先级从高到低：
 *   1. 该站点自己缓存的云端配置（<配置目录>/local_storage/*.info）—— 账号实际下发的清单，最新
 *   2. 该站点 CLI 安装目录里的内置目录（product.json）—— 缓存缺失时的兜底
 *   3. 该站点配置目录里的自定义模型（models.json）—— 补充进去
 *
 * 两个站点的模型清单是分开的：同一个 id（比如 Kimi-K2.6）两边都有但含义不同，
 * 所以每条模型都带 site 字段，合并时也会用前缀把归属写清楚（见 merged()）。
 *
 * 只做只读解析，不写任何 WorkBuddy 的文件。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sites = require('./sites.js');

// 清单缓存有效期（按站点各算一份）。控制台每 5 秒轮询状态，所以最迟这么久之后就能看到变化；
// 想立刻刷新就用控制台的「拉取最新模型」按钮。
const TTL_MS = 15 * 1000;
const cache = new Map(); // site → catalog

/* ---------- 来源 1：该站点的云端配置缓存 ---------- */

function readLiveConfig(home) {
  const live = sites.readCloudConfig(home);
  if (!live) return null;
  return { file: live.file, mtime: live.mtime, data: live.data };
}

/* ---------- 来源 2：该站点 CLI 的内置目录 ---------- */

function readProductJson(cliJs) {
  if (!cliJs) return null;
  const p = sites.productJsonPath(cliJs);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(j.models) && j.models.length) {
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch {}
      return { file: p, models: j.models, mtime };
    }
  } catch {}
  return null;
}

/* ---------- 来源 3：该站点的自定义模型 ---------- */

function readCustomModels(home, cwd) {
  const files = [
    home ? path.join(home, 'models.json') : null,
    cwd ? path.join(cwd, '.workbuddy', 'models.json') : null,
    cwd ? path.join(cwd, '.codebuddy', 'models.json') : null,
  ].filter(Boolean);

  const out = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
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
// 这几个是「自动 / 默认 / 快速 / 均衡 / 极致」这类档位别名，排在最前面方便选
const ALIAS_ORDER = ['auto', 'default-model', 'fast-model', 'balanced-model', 'primary-model', 'deep-model'];

function kindOf(m) {
  const tags = Array.isArray(m.tags) ? m.tags : [];
  if (tags.some((t) => MEDIA_KINDS.has(t))) return tags.some((t) => t.includes('video')) ? 'video' : 'image';
  if (m.supportsToolCall) return 'chat';
  return 'completion';
}

function normalize(m, source, site) {
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
    site,
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

/* ---------- 单个站点的清单 ---------- */

/**
 * 读一个站点的模型清单。
 * @param {object} o
 * @param {string} o.site      站点 key（cn / intl）
 * @param {string} [o.cliJs]   该站点的 CLI 路径（内置目录兜底要用）
 * @param {string} [o.home]    该站点的配置目录（留空自动取）
 * @param {string} [o.cwd]     工作目录（找自定义模型用）
 * @param {boolean} [o.force]  忽略缓存
 */
function load({ site, cliJs = '', home = '', cwd = '', force = false } = {}) {
  const homeInfo = sites.homeDir(site, home);
  const homeDir = homeInfo.dir;
  const key = site + '|' + cliJs + '|' + homeDir;
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.loadedAt < TTL_MS) return hit;

  const live = readLiveConfig(homeDir);
  let list = [];
  let source = '';
  let sourceFile = '';
  let sourceMtime = 0;

  if (live) {
    list = live.data.models.map((m) => normalize(m, 'cloud', site));
    source = '云端配置缓存';
    sourceFile = live.file;
    sourceMtime = live.mtime;
  } else {
    const prod = readProductJson(cliJs);
    if (prod) {
      list = prod.models.map((m) => normalize(m, 'builtin', site));
      source = '内置目录（未找到云端缓存）';
      sourceFile = prod.file;
      sourceMtime = prod.mtime || 0;
    } else {
      source = homeInfo.exists ? '未找到任何模型来源' : '配置目录不存在（这个站点还没登录过）';
    }
  }

  // 官方为该 agent 推荐的模型（缓存里 agents 里带 models 白名单）
  const recommended = new Set();
  try {
    const cliAgent = (live ? live.data.agents : [])?.find?.((a) => a && a.name === 'cli');
    for (const id of cliAgent?.models || []) recommended.add(id);
  } catch {}

  // 自定义模型补充（同 id 覆盖）
  const custom = readCustomModels(homeDir, cwd);
  for (const c of custom) {
    const norm = normalize(c, 'custom', site);
    norm.customUrl = c.url || '';
    const i = list.findIndex((x) => x.id === norm.id);
    if (i >= 0) list[i] = { ...list[i], ...norm, kind: norm.kind === 'completion' ? list[i].kind : norm.kind };
    else list.push(norm);
  }

  for (const m of list) m.recommended = recommended.has(m.id);
  list = sortModels(list);

  const out = {
    site,
    siteLabel: sites.siteLabel(site),
    loadedAt: Date.now(),
    source,
    sourceFile,
    sourceMtime,
    home: homeDir,
    homeExists: homeInfo.exists,
    cliJs,
    models: list,
    customCount: custom.length,
    promotions: (live && live.data && live.data.modelPromotions) || [],
  };
  cache.set(key, out);
  return out;
}

// 促销信息（限时折扣之类），控制台里展示用
function promotionsFor(catalog, modelId) {
  return (catalog.promotions || []).filter((p) => p && p.enabled !== false && Array.isArray(p.modelIds) && p.modelIds.includes(modelId));
}

/* ---------- 多站点：合并与解析 ---------- */

const prefixed = (site, id) => site + '/' + id;

/**
 * 把几个站点的清单合成一份对外用的列表。
 *
 * id 的规则（这样既不会撞车，又不用改客户端习惯）：
 *   - 首选站点（activeSites 的第一个）的模型：id 原样，比如 auto、deepseek-v4-pro
 *   - 其它站点的模型：id 加站点前缀，比如 intl/gpt-5.6-sol
 *   - 不管哪种，都额外带 site（cn/intl）、site_label、site_model_id 三个非标准字段
 *
 * @param {string[]} activeSites  参与的顺序（第一个是首选站点）
 * @param {object} catalogs       { cn: catalog, intl: catalog }
 * @param {string[]} [aliases]    控制台里追加的别名
 */
function merged(activeSites, catalogs, aliases = []) {
  const primary = activeSites[0] || '';
  const data = [];
  const perSite = {};

  for (const site of activeSites) {
    const cat = catalogs[site];
    if (!cat) continue;
    perSite[site] = {
      source: cat.source,
      sourceFile: cat.sourceFile,
      sourceMtime: cat.sourceMtime,
      loadedAt: cat.loadedAt,
      customCount: cat.customCount,
      count: cat.models.length,
      home: cat.home,
    };
    for (const m of cat.models) {
      const exposed = site === primary ? m.id : prefixed(site, m.id);
      data.push({
        ...m,
        exposedId: exposed,
        siteModelId: m.id,
        site,
        siteLabel: cat.siteLabel || sites.siteLabel(site),
        prefix: site === primary ? '' : site + '/',
      });
    }
  }

  for (const extra of aliases) {
    if (!data.some((x) => x.exposedId === extra)) {
      data.push({
        id: extra,
        exposedId: extra,
        siteModelId: extra,
        name: extra,
        kind: 'alias',
        credits: '',
        contextLength: 0,
        supportsTools: false,
        supportsImages: false,
        isDefault: false,
        description: '',
        source: 'alias',
        site: primary,
        siteLabel: sites.siteLabel(primary),
        prefix: '',
      });
    }
  }

  const counts = { total: data.length, chat: 0, completion: 0, image: 0, video: 0, alias: 0 };
  for (const m of data) if (counts[m.kind] !== undefined) counts[m.kind]++;

  return { activeSites, primary, models: data, perSite, counts };
}

/**
 * 客户端要的模型名 → 落到哪个站点、哪个真实模型 id。
 * 规则（按先后）：
 *   1. 空 / workbuddy-auto → 首选站点 + 该站点配置的默认模型
 *   2. 带站点前缀 "intl/xxx" / "cn/xxx" → 就是那个站点（该站点没启用时明确报错）
 *   3. 光是一个 id：只在某一个启用站点里有 → 就归它
 *   4. 两边都有（比如 Kimi-K2.6）→ 归首选站点
 *   5. 启用的站点里都没有，但被停用的站点里有 → 报错并告诉用户去哪个站用
 *
 * @returns {{site:string, model:string, exposedId:string, error?:string}}
 */
function resolveModel(requested, activeSites, catalogs, { defaultModel = '', defaultModelOf = null } = {}) {
  const primary = activeSites[0] || '';
  const raw = typeof requested === 'string' ? requested.trim() : '';
  const defaultFor = (site) => {
    const per = defaultModelOf ? defaultModelOf(site) : '';
    return per || defaultModel || '';
  };

  if (!raw || raw === 'workbuddy-auto') {
    return { site: primary, model: defaultFor(primary), exposedId: defaultFor(primary) || 'auto' };
  }

  const m = /^(cn|intl)\s*\/\s*(.+)$/i.exec(raw);
  if (m) {
    const site = m[1].toLowerCase();
    const id = m[2].trim();
    if (!sites.isSiteKey(site)) return { site: primary, model: raw, exposedId: raw, error: `不认识的站点前缀：${m[1]}` };
    if (!activeSites.includes(site)) {
      return {
        site, model: id, exposedId: raw,
        error: `模型 "${id}" 属于${sites.siteLabel(site)}，但现在没启用那个站点。请到控制台的「站点」里把模式改成「只用${sites.siteLabel(site)}」或「两个都用」。`,
      };
    }
    return { site, model: id, exposedId: site === primary ? id : prefixed(site, id) };
  }

  const owners = activeSites.filter((s) => (catalogs[s]?.models || []).some((x) => x.id === raw));
  if (owners.length === 1) return { site: owners[0], model: raw, exposedId: owners[0] === primary ? raw : prefixed(owners[0], raw) };
  if (owners.length > 1) return { site: primary, model: raw, exposedId: raw };

  // 启用站点里都没有 —— 看看是不是属于没启用的那个站点，是的话给一句人话
  for (const s of sites.SITE_ORDER) {
    if (activeSites.includes(s)) continue;
    const cat = catalogs[s];
    if (cat && cat.models.some((x) => x.id === raw)) {
      return {
        site: s, model: raw, exposedId: raw,
        error: `模型 "${raw}" 属于${sites.siteLabel(s)}，但现在没启用那个站点。请到控制台的「站点」里切换模式。`,
      };
    }
  }
  // 谁都没有：交给首选站点的 CLI 去报错（错误原样回给调用方，比我们猜要准）
  return { site: primary, model: raw, exposedId: raw };
}

module.exports = { load, merged, resolveModel, promotionsFor, TTL_MS };
