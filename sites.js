/*
 * 站点（国内站 / 国外站）
 *
 * 这台机器上可以同时装两个 WorkBuddy：
 *   - 国内站：安装目录里 product.json 的 productName 是 "WorkBuddy"，配置目录 ~/.workbuddy（老版本还有 ~/.codebuddy），
 *             云端配置里写的是 https://copilot.tencent.com，端点文件里是 "internal"
 *   - 国外站：productName 是 "WorkBuddy AI"，配置目录 ~/.workbuddy-ai，
 *             云端配置里写的是 https://www.workbuddy.ai，端点文件里是 "external"
 *
 * 这个文件只做三件事，都不写任何 WorkBuddy 的文件：
 *   1. 说清两个站点分别是什么（目录名、进程名、怎么认出它）
 *   2. 从一个站点目录里读出：端点地址、频率标记、登录的账号、装在哪
 *   3. 判断「某个 CLI 路径 / 安装目录属于哪个站点」
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 站点的先后顺序就是「两个都在时」的默认优先级 —— 国内站排第一，所以默认用国内站
const SITE_ORDER = ['cn', 'intl'];

const SITES = {
  cn: {
    key: 'cn',
    label: '国内站',
    short: '国内',
    // 这台机器的配置目录。按顺序试，第一个存在的就是它；都没有就取第一个显示用。
    // .codebuddy 是老版本留下的，内容跟 .workbuddy 一样，作为兜底。
    homes: ['.workbuddy', '.codebuddy'],
    // 安装目录名 / 进程名的线索，只在没有 product.json 可读时当弱证据用
    hints: [/workbuddy(?!\s*ai)/i, /codebuddy/i],
    negativeHints: [/workbuddy[\s_-]*ai/i],
    exeNames: ['WorkBuddy'],
    channel: 'internal',
    productNames: ['WorkBuddy'],
    endpoint: 'https://copilot.tencent.com',
  },
  intl: {
    key: 'intl',
    label: '国外站',
    short: '国外',
    homes: ['.workbuddy-ai'],
    hints: [/workbuddy[\s_-]*ai/i],
    negativeHints: [],
    exeNames: ['WorkBuddyAI'],
    channel: 'external',
    productNames: ['WorkBuddy AI'],
    endpoint: 'https://www.workbuddy.ai',
  },
};

function siteLabel(key) {
  return (SITES[key] && SITES[key].label) || String(key || '');
}

function isSiteKey(key) {
  return Object.prototype.hasOwnProperty.call(SITES, key);
}

/* ---------------- 小工具 ---------------- */

function readJsonFile(p) {
  try {
    // 记事本存成「UTF-8 带 BOM」很常见，BOM 会让 JSON.parse 直接失败
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function statOf(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function existingDir(p) {
  const st = statOf(p);
  return Boolean(st && st.isDirectory());
}

/* ---------------- 配置目录（这台机器的「家」） ---------------- */

/**
 * 站点在这一刻实际使用的配置目录。override 是用户在控制台里手填的。
 * @returns {{dir:string, exists:boolean, all:string[], source:string}}
 */
function homeDir(key, override = '') {
  const site = SITES[key];
  if (!site) return { dir: '', exists: false, all: [], source: '未知站点' };
  const all = site.homes.map((h) => path.join(os.homedir(), h));
  if (override && String(override).trim()) {
    const dir = path.resolve(String(override).trim());
    return { dir, exists: existingDir(dir), all, source: '控制台里手填的' };
  }
  for (const dir of all) {
    if (existingDir(dir)) return { dir, exists: true, all, source: '自动检测' };
  }
  return { dir: all[0], exists: false, all, source: '没找到（还没装过 / 没登录过）' };
}

/* ---------------- local_storage 里的小文件 ---------------- */

// local_storage 里的文件名是内容哈希，会随版本变，所以只能按内容找。
// 小文件基本都是「一个 JSON 字符串」：端点地址、频率标记。
function readSmallStrings(home) {
  const lsDir = path.join(home, 'local_storage');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(lsDir); } catch { return out; }
  for (const name of names) {
    const p = path.join(lsDir, name);
    const st = statOf(p);
    if (!st || !st.isFile() || st.size > 512) continue;
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (!raw.startsWith('"')) continue;
    let v;
    try { v = JSON.parse(raw); } catch { continue; }
    if (typeof v === 'string' && v) out.push({ file: p, value: v, mtime: st.mtimeMs });
  }
  return out;
}

/**
 * 这个站点现在连的是哪个地址（WorkBuddy 自己记的）。
 * @returns {{url:string, file:string, mtime:number, source:string}|null}
 */
function readEndpoint(home) {
  if (!home || !existingDir(home)) return null;
  for (const s of readSmallStrings(home)) {
    if (/^https?:\/\//i.test(s.value)) return { url: s.value.replace(/\/+$/, ''), file: s.file, mtime: s.mtime, source: 'WorkBuddy 自己记的端点' };
  }
  // 兜底：云端配置里也有一个 endpoint 字段
  const cfg = readCloudConfig(home);
  if (cfg && cfg.data && typeof cfg.data.endpoint === 'string' && cfg.data.endpoint) {
    return { url: cfg.data.endpoint.replace(/\/+$/, ''), file: cfg.file, mtime: cfg.mtime, source: '云端配置缓存里的端点' };
  }
  return null;
}

/**
 * 这个站点被划到哪一边：internal = 国内，external = 国外。
 * @returns {{channel:string, file:string}|null}
 */
function readChannel(home) {
  if (!home || !existingDir(home)) return null;
  for (const s of readSmallStrings(home)) {
    if (s.value === 'internal' || s.value === 'external') return { channel: s.value, file: s.file };
  }
  return null;
}

/* ---------------- 登录的账号 ---------------- */

/**
 * 当前登录的账号。WorkBuddy 自己写的账号快照，只读。
 * @returns {{uid:string, nickname:string, type:string, editionType:string, isPro:boolean,
 *            isAdmin:boolean, savedAt:number, file:string, loggedIn:boolean}|null}
 */
function readAccount(home) {
  if (!home || !existingDir(home)) return null;
  const p = path.join(home, 'storage', 'skeleton', 'account-snapshot.json');
  const j = readJsonFile(p);
  const primary = j && (j.primary || (j.uid ? j : null));
  if (!primary) return null;
  const hasId = Boolean(primary.uid || primary.nickname);
  return {
    uid: String(primary.uid || ''),
    nickname: String(primary.nickname || ''),
    type: String(primary.type || ''),
    editionType: String(primary.editionType || ''),
    isPro: Boolean(primary.isPro),
    isAdmin: Boolean(primary.isAdmin),
    savedAt: Number(primary.savedAt || 0),
    file: p,
    loggedIn: hasId,
  };
}

/* ---------------- 云端配置缓存（模型清单也在里面） ---------------- */

// local_storage 里那份最大的 .info：结构是 [{ userId, data: { models, agents, endpoint, ... }, ts }]
// 有的版本会写成 base64+gzip（H4sI... 开头），两种都要认。
function parseInfoFile(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
  if (!raw) return null;
  if (/^H4sI/.test(raw)) {
    try {
      raw = require('node:zlib').gunzipSync(Buffer.from(raw, 'base64')).toString('utf8');
    } catch { return null; }
  }
  if (raw[0] !== '[' && raw[0] !== '{') return null;
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  return j;
}

/**
 * 这个站点里最新的一份云端配置缓存（模型清单的来源）。
 * @returns {{file:string, mtime:number, userId:string, ts:number, data:object}|null}
 */
function readCloudConfig(home) {
  if (!home) return null;
  const lsDir = path.join(home, 'local_storage');
  let names = [];
  try { names = fs.readdirSync(lsDir); } catch { return null; }
  const hits = [];
  for (const name of names) {
    const p = path.join(lsDir, name);
    const st = statOf(p);
    if (!st || !st.isFile() || st.size < 200) continue;
    const j = parseInfoFile(p);
    if (!j) continue;
    const root = Array.isArray(j) ? j[0] : j;
    const data = (root && root.data) || null;
    if (!data || !Array.isArray(data.models) || !data.models.length) continue;
    hits.push({ file: p, mtime: st.mtimeMs, userId: String((root && root.userId) || ''), ts: Number((root && root.ts) || 0), data });
  }
  if (!hits.length) return null;
  // 模型最多的那份就是主配置；一样多时取更新的
  hits.sort((a, b) => b.data.models.length - a.data.models.length || b.mtime - a.mtime);
  return hits[0];
}

/* ---------------- 安装目录 / CLI 属于哪个站点 ---------------- */

// CLI 入口形如 <安装目录>\resources\app.asar.unpacked\cli\bin\codebuddy，
// 它旁边就是 product.json（<安装目录>\...\cli\product.json）
function productJsonPath(cliJs) {
  if (!cliJs) return '';
  const cliDir = path.dirname(path.dirname(cliJs)); // ...\cli
  const candidates = [path.join(cliDir, 'product.json'), path.join(cliDir, 'product.internal.json')];
  for (const p of candidates) if (statOf(p)) return p;
  return candidates[0];
}

/**
 * 读某个 CLI 的 product.json（站点自带的说明书）。
 * @returns {{file:string, mtime:number, productName:string, endpoint:string, platform:string,
 *            customUserDataDir:string}|null}
 */
function readProductInfo(cliJs) {
  const p = productJsonPath(cliJs);
  const raw = readJsonFile(p);
  if (!raw) return null;
  const attrs = (raw.authentication && raw.authentication.attributes) || {};
  return {
    file: p,
    mtime: (statOf(p) || {}).mtimeMs || 0,
    productName: String(raw.productName || ''),
    endpoint: String(raw.endpoint || ''),
    platform: String(attrs.platform || ''),
    customUserDataDir: String((raw.config && raw.config.customUserDataDir) || ''),
  };
}

/**
 * 只看 product.json 的内容，判断这份安装属于哪个站点。
 * @returns {'cn'|'intl'|null} null = 认不出来
 */
function classifyProductInfo(info) {
  if (!info) return null;
  const platform = String(info.platform || '').toLowerCase();
  const udd = String(info.customUserDataDir || '').toLowerCase();
  const name = String(info.productName || '');
  const endpoint = String(info.endpoint || '').toLowerCase();

  // 国外站：这三处任意一处点名就够了
  if (platform === 'workbuddy-ai' || udd === '.workbuddy-ai') return 'intl';
  if (/workbuddy[\s_-]*ai/i.test(name)) return 'intl';
  if (/workbuddy\.ai|codebuddy\.ai/.test(endpoint) && !/tencent\.com|codebuddy\.cn|workbuddy\.cn/.test(endpoint)) return 'intl';

  // 国内站
  if (platform === 'workbuddy' || udd === '.workbuddy' || udd === '.codebuddy') return 'cn';
  if (/^workbuddy$/i.test(name.trim()) || /^codebuddy$/i.test(name.trim())) return 'cn';
  if (/copilot\.tencent\.com|codebuddy\.cn|workbuddy\.cn/.test(endpoint)) return 'cn';

  if (/[\s_-]ai\b/i.test(name)) return 'intl';
  return null;
}

/**
 * 给一个 CLI 路径 / 安装目录归类。
 * @returns {{site:'cn'|'intl'|null, by:string, info:object|null}}
 */
function classifyCli(cliJs) {
  const info = readProductInfo(cliJs);
  const site = classifyProductInfo(info);
  return { site, by: info ? 'product.json（' + (info.productName || '无名') + '）' : '没有 product.json', info };
}

/**
 * 没有 product.json 时，只能靠路径上的名字猜。只在弱证据场景用。
 * 只看目录部分：CLI 的文件名本身就叫 codebuddy，拿它当线索等于「人人都是国内站」。
 * @returns {'cn'|'intl'|null}
 */
function classifyByPath(p) {
  const s = String(p || '');
  if (!s) return null;
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  const probe = cut > 0 ? s.slice(0, cut) : s;
  if (!probe) return null;
  for (const key of SITE_ORDER) {
    const site = SITES[key];
    // 先看「明确不是它」的形状：装了国外站之后目录名里也带 WorkBuddy，不能算到国内站头上
    if (site.negativeHints.some((re) => re.test(probe))) continue;
    if (site.hints.some((re) => re.test(probe))) return key;
  }
  return null;
}

/* ---------------- 一个站点的静态画像 ---------------- */

/**
 * 只读地把一个站点「现在长什么样」收集起来：装在哪、连哪个地址、登的谁的号。
 * 不含「CLI 进程能不能跑起来」这种需要动手的部分，那是 locate.js 的事。
 */
function describeStatic(key, { homeOverride = '' } = {}) {
  const site = SITES[key];
  if (!site) return null;
  const home = homeDir(key, homeOverride);
  const endpoint = readEndpoint(home.dir);
  const channel = readChannel(home.dir);
  const account = readAccount(home.dir);
  const cloud = readCloudConfig(home.dir);
  return {
    key,
    label: site.label,
    short: site.short,
    home: home.dir,
    homeExists: home.exists,
    homeSource: home.source,
    homeCandidates: home.all,
    endpoint: endpoint ? endpoint.url : '',
    endpointFile: endpoint ? endpoint.file : '',
    endpointSource: endpoint ? endpoint.source : '',
    endpointExpected: site.endpoint,
    channel: channel ? channel.channel : '',
    channelFile: channel ? channel.file : '',
    channelExpected: site.channel,
    account: account
      ? {
        uid: account.uid,
        nickname: account.nickname,
        type: account.type,
        editionType: account.editionType,
        isPro: account.isPro,
        isAdmin: account.isAdmin,
        savedAt: account.savedAt,
        file: account.file,
        loggedIn: account.loggedIn,
      }
      : null,
    loggedIn: Boolean(account && account.loggedIn),
    cloud: cloud
      ? { file: cloud.file, mtime: cloud.mtime, userId: cloud.userId, ts: cloud.ts, modelCount: cloud.data.models.length }
      : null,
  };
}

module.exports = {
  SITE_ORDER,
  SITES,
  siteLabel,
  isSiteKey,
  homeDir,
  readEndpoint,
  readChannel,
  readAccount,
  readCloudConfig,
  readSmallStrings,
  productJsonPath,
  readProductInfo,
  classifyProductInfo,
  classifyCli,
  classifyByPath,
  describeStatic,
};
