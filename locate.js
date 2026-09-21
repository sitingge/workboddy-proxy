/*
 * 自动定位 WorkBuddy 的 CLI —— 国内站和国外站各找各的，不写死任何盘符或路径。
 *
 * 对每个站点，顺序都是（找到就停）：
 *   1. 配置/命令行里手写的路径（用户说了算）
 *   2. 上次找到的缓存（.wb-location.json）
 *   3. 问系统：正在运行的 WorkBuddy 进程的 exe 路径
 *   4. 问系统：PATH 里的 codebuddy / cbc
 *   5. 问系统：注册表卸载信息里的安装位置
 *   6. 按盘符遍历目录树（有深度上限和超时，只读目录名）
 *
 * 关键点：两个站点的 CLI 长得一模一样（都叫 codebuddy），所以「找到一个」不等于「找到对的那个」。
 * 每找到一个候选，都要读它旁边的 product.json 认一下是哪个站（见 sites.js），认不出来的
 * 单独列出来交给用户自己指定，绝不硬塞给某个站。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sites = require('./sites.js');

const CACHE_NAME = '.wb-location.json';
const CACHE_VERSION = 2;
// CLI 入口相对于安装目录的位置，覆盖常见的几种布局
const CLI_RELATIVE = [
  ['resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'],
  ['resources', 'cli', 'bin', 'codebuddy'],
  ['app.asar.unpacked', 'cli', 'bin', 'codebuddy'],
  ['cli', 'bin', 'codebuddy'],
];
// 遍历时直接跳过的目录名（小写比较），避免钻进系统目录和大缓存
const SKIP_DIRS = new Set([
  'windows', '$recycle.bin', 'system volume information', 'node_modules', '.git', '.cache',
  'recovery', '$windows.~bt', '$windows.~ws', 'perflogs', 'msocache', 'temp', 'tmp',
  'cache', 'logs', 'crashpad', 'code cache', 'gpucache', 'blob_storage',
]);
// 目录名像不像 WorkBuddy 的窝 —— 像的先翻，能省不少时间
const HINT_DIR = /(workbuddy|workboddy|codebuddy|tencent)/i;
const isWin = process.platform === 'win32';

/* ---------------- 工具 ---------------- */

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function cachePath(appDir) {
  return path.join(appDir, CACHE_NAME);
}

// 缓存格式：
//   v2  { version:2, sites:{ cn:{cliJs,...}, intl:{cliJs,...} } }
//   v1  { cliJs, installDir, source }   —— 老版本只有国内站，当成国内站的记录读
function readCache(appDir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(cachePath(appDir), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  if (j.sites && typeof j.sites === 'object') return { version: CACHE_VERSION, sites: j.sites };
  if (typeof j.cliJs === 'string') return { version: 1, sites: { cn: j } };
  return null;
}

function writeCache(appDir, data) {
  try { fs.writeFileSync(cachePath(appDir), JSON.stringify(data, null, 2) + '\n', 'utf8'); } catch {}
}

function clearCache(appDir) {
  try { fs.rmSync(cachePath(appDir), { force: true }); } catch {}
}

// 在某个安装目录里找 CLI 入口
function probeDir(dir) {
  if (!dir) return null;
  for (const parts of CLI_RELATIVE) {
    const p = path.join(dir, ...parts);
    if (isFile(p)) return p;
  }
  return null;
}

// 找到目录但 CLI 没解包时的提示（app.asar 里打包着，没法直接跑）
function hasPackedAsar(dir) {
  return isFile(path.join(dir, 'resources', 'app.asar')) || isFile(path.join(dir, 'app.asar'));
}

function psOne(script, timeoutMs) {
  if (!isWin) return '';
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

const lines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

/* ---------------- 各种候选来源（只负责「提出候选」，不判断站点） ---------------- */

// 3. 正在运行的 WorkBuddy 进程。两个站点的 exe 名字不一样（WorkBuddy / WorkBuddyAI），
//    但版本或渠道可能改名，所以这里不靠名字，把所有像 WorkBuddy 的进程路径都捞出来，
//    后面统一用 product.json 分类。
function candidatesFromProcesses() {
  const out = [];
  const byName = psOne(
    'Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ' +
    "Where-Object { $_.Path -like '*WorkBuddy*' -or $_.Path -like '*workbuddy*' } | " +
    'Select-Object -ExpandProperty Path -Unique',
    8000,
  );
  for (const exe of lines(byName)) {
    const dir = path.dirname(exe);
    const hit = probeDir(dir);
    if (hit) out.push({ cliJs: hit, installDir: dir, from: '运行中的进程：' + path.basename(exe) });
  }
  return out;
}

// 4. PATH 里的 codebuddy / cbc
function candidatesFromPath() {
  const out = [];
  for (const name of ['codebuddy', 'cbc', 'codebuddy.cmd', 'codebuddy.exe']) {
    let found = '';
    try {
      found = execFileSync(isWin ? 'where' : 'which', [name],
        { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* 没这个命令 */ }
    for (const p of lines(found)) {
      if (isFile(p)) out.push({ cliJs: p, installDir: path.dirname(path.dirname(path.dirname(path.dirname(p)))), from: 'PATH 里的 ' + name });
    }
  }
  return out;
}

// 5. 注册表里的卸载信息。InstallLocation 经常是空的，所以顺便从 DisplayIcon / UninstallString 里挖路径。
function candidatesFromRegistry() {
  const out = [];
  const raw = psOne(
    "$keys = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
    'Get-ItemProperty $keys -ErrorAction SilentlyContinue | ' +
    "Where-Object { $_.DisplayName -like '*WorkBuddy*' } | " +
    'ForEach-Object { $_.InstallLocation; $_.DisplayIcon; $_.UninstallString }',
    10000,
  );
  const dirs = [];
  for (const line of lines(raw)) {
    const cleaned = line.replace(/^"|"$/g, '').replace(/,\d+$/, '').trim();
    if (!cleaned) continue;
    dirs.push(cleaned, path.dirname(cleaned), path.dirname(path.dirname(cleaned)));
  }
  for (const d of dirs) {
    if (!d) continue;
    const hit = probeDir(d);
    if (hit) out.push({ cliJs: hit, installDir: d, from: '注册表卸载信息' });
  }
  return out;
}

// 6. 按盘符遍历
function driveRoots() {
  if (!isWin) return ['/'];
  const roots = [];
  for (let i = 67; i <= 90; i++) { // C..Z
    const d = String.fromCharCode(i) + ':\\';
    try { if (fs.statSync(d).isDirectory()) roots.push(d); } catch {}
  }
  return roots;
}

function defaultRoots() {
  return [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
    os.homedir(),
    process.env.LOCALAPPDATA || '',
    process.env.APPDATA || '',
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || '',
    process.env.ProgramData || '',
  ].filter((p) => isDir(p));
}

/**
 * 遍历目录树，把所有像是 WorkBuddy 安装目录的地方都找出来（不再「找到第一个就收工」——
 * 两个站点都得找，所以必须看全）。
 * 名字像 WorkBuddy 的目录会被插到队首优先翻，实测能省一大半时间。
 *
 * @returns {{hits:Array<{cliJs:string,installDir:string,from:string}>, packed:string[],
 *            visited:number, timedOut:boolean}}
 */
function scanRootsAll({ roots = null, maxDepth = 3, deadlineMs = 20000, log = () => {} } = {}) {
  const list = roots || [...new Set([...defaultRoots(), ...driveRoots()])];
  const t0 = Date.now();
  const hits = [];
  const packed = [];
  const seen = new Set();
  let visited = 0;
  let timedOut = false;

  const addHit = (hit) => {
    const key = path.resolve(hit.cliJs).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(hit);
  };

  for (const root of list) {
    if (Date.now() - t0 > deadlineMs) { timedOut = true; break; }
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      if (Date.now() - t0 > deadlineMs) { timedOut = true; break; }
      const { dir, depth } = queue.shift();
      visited++;
      const hit = probeDir(dir);
      if (hit) addHit({ cliJs: hit, installDir: dir, from: '目录遍历' });
      if (hasPackedAsar(dir)) packed.push(dir);
      if (depth >= maxDepth) continue;

      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const hint = [];
      const normal = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const name = e.name.toLowerCase();
        if (SKIP_DIRS.has(name) || name.startsWith('$')) continue;
        if (name === 'appdata' && depth > 0) continue;
        const item = { dir: path.join(dir, e.name), depth: depth + 1 };
        // 名字像 WorkBuddy 的先翻
        if (HINT_DIR.test(e.name)) hint.push(item);
        else normal.push(item);
      }
      // 同一个目录下：名字像的先翻（插到队首），其余照原来的顺序排后面
      queue.unshift(...hint);
      queue.push(...normal);
    }
  }
  if (timedOut) log(`[locate] 遍历超时（已看 ${visited} 个目录），就找到这么多`);
  else log(`[locate] 遍历完成，看了 ${visited} 个目录，找到 ${hits.length} 个候选`);
  return { hits, packed, visited, timedOut };
}

// 老接口：找到第一个能用就算（冒烟测试和「CLI 被挪走了，随便再找一个」还在用）
function scanRoots(opts = {}) {
  const r = scanRootsAll(opts);
  if (r.hits.length) return { cliJs: r.hits[0].cliJs, source: '目录遍历', installDir: r.hits[0].installDir, visited: r.visited };
  return r.packed.length ? { packed: r.packed } : null;
}

/* ---------------- 认站点 ---------------- */

/**
 * 给一批候选分类，挑出每个站点的那一个。
 * @returns {{bySite:object, unclassified:Array, conflicts:Array}}
 */
function assignToSites(candidates, want) {
  const bySite = {};
  const unclassified = [];
  const conflicts = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = path.resolve(c.cliJs).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const cls = sites.classifyCli(c.cliJs);
    // product.json 认不出来时用路径名兜一下；再不行就交给用户自己指定
    const guessed = cls.site || sites.classifyByPath(c.cliJs);
    const by = cls.site ? cls.by : (guessed ? '按目录名猜的（旁边没有 product.json）' : cls.by);

    if (!guessed) {
      unclassified.push({ cliJs: c.cliJs, installDir: c.installDir, from: c.from, by: cls.by });
      continue;
    }
    if (!want.includes(guessed)) continue;
    if (bySite[guessed]) {
      conflicts.push({ site: guessed, kept: bySite[guessed].cliJs, dropped: c.cliJs });
      continue;
    }
    bySite[guessed] = {
      cliJs: c.cliJs,
      installDir: c.installDir || '',
      source: c.from,
      classifiedBy: by,
      productName: (cls.info && cls.info.productName) || '',
      productEndpoint: (cls.info && cls.info.endpoint) || '',
    };
  }
  return { bySite, unclassified, conflicts };
}

/* ---------------- 对外入口 ---------------- */

/**
 * 把两个站点的 CLI 都找出来。
 *
 * @param {object} opts
 * @param {string} opts.appDir            本程序目录（缓存文件放这里）
 * @param {string[]} [opts.want]          要找哪几个站点，默认两个都找
 * @param {object} [opts.cfg]             每个站点的手写覆盖：{ cn:{cliJs,home}, intl:{cliJs,home} }
 * @param {boolean} [opts.force]          忽略缓存，强制重新找
 * @param {Function} [opts.log]
 * @returns {{sites:object, unclassified:Array, conflicts:Array, packed?:string[]}}
 *   sites[key] = { ok, cliJs?, installDir?, source?, classifiedBy?, productName?, productEndpoint?, error? }
 */
function locateAll({ appDir, want = sites.SITE_ORDER.slice(), cfg = {}, force = false, log = () => {} } = {}) {
  const out = { sites: {}, unclassified: [], conflicts: [] };
  const cache = force ? null : readCache(appDir);
  const cachedSites = (cache && cache.sites) || {};
  const pending = [];

  for (const key of want) {
    const siteCfg = cfg[key] || {};
    out.sites[key] = { ok: false };

    // 1. 手写路径最高优先
    const explicit = String(siteCfg.cliJs || '').trim();
    if (explicit) {
      if (isFile(explicit)) {
        // 手写也要认一下：写反了（把国外站的路径填到国内站）就明确告诉你，但不拦着不用
        const cls = sites.classifyCli(explicit);
        out.sites[key] = {
          ok: true,
          cliJs: explicit,
          installDir: cls.info ? path.dirname(path.dirname(path.dirname(cls.info.file))) : path.dirname(path.dirname(path.dirname(explicit))),
          source: '配置里手写的路径',
          classifiedBy: cls.by,
          productName: (cls.info && cls.info.productName) || '',
          productEndpoint: (cls.info && cls.info.endpoint) || '',
          mismatch: cls.site && cls.site !== key ? cls.site : '',
        };
        continue;
      }
      log(`[locate] ${sites.siteLabel(key)} 配置里的路径不存在，忽略并继续自动查找：${explicit}`);
    }

    // 2. 缓存
    const hit = cachedSites[key];
    if (hit && hit.cliJs) {
      if (isFile(hit.cliJs)) {
        out.sites[key] = {
          ok: true,
          cliJs: hit.cliJs,
          installDir: hit.installDir || '',
          source: hit.source ? '上次记住的（' + hit.source + '）' : '上次记住的路径',
          classifiedBy: hit.classifiedBy || '',
          productName: hit.productName || '',
          productEndpoint: hit.productEndpoint || '',
          fromCache: true,
        };
        continue;
      }
      log(`[locate] ${sites.siteLabel(key)} 上次记住的路径已失效（${hit.cliJs}），重新查找`);
    }
    pending.push(key);
  }

  if (!pending.length) return out;

  // 3~5. 问系统（三个来源一起收，别为了等一个慢的来源拖时间）
  const fromSystem = [];
  for (const [fn, label] of [[candidatesFromProcesses, '进程'], [candidatesFromPath, 'PATH'], [candidatesFromRegistry, '注册表']]) {
    try {
      const got = fn();
      if (got.length) log(`[locate] ${label} 里找到 ${got.length} 个候选`);
      fromSystem.push(...got);
    } catch { /* 这个来源不可用就算了 */ }
  }
  let assigned = assignToSites(fromSystem, pending);
  for (const [key, v] of Object.entries(assigned.bySite)) if (!out.sites[key].ok) out.sites[key] = { ok: true, ...v };
  out.unclassified.push(...assigned.unclassified);
  out.conflicts.push(...assigned.conflicts);

  // 6. 还有站点没找到就遍历盘符
  const stillMissing = pending.filter((k) => !out.sites[k].ok);
  if (stillMissing.length) {
    log(`[locate] 还差 ${stillMissing.map(sites.siteLabel).join('、')}，开始按盘符遍历（只读目录名）`);
    const scanned = scanRootsAll({ log });
    out.packed = scanned.packed;
    assigned = assignToSites(scanned.hits, stillMissing);
    for (const [key, v] of Object.entries(assigned.bySite)) if (!out.sites[key].ok) out.sites[key] = { ok: true, ...v };
    out.unclassified.push(...assigned.unclassified);
    out.conflicts.push(...assigned.conflicts);
  }

  // 落盘：只记住找到的；没找到的保留旧记录（路径以后回来了还能直接用）
  const merged = { ...cachedSites };
  for (const key of want) {
    const s = out.sites[key];
    if (s && s.ok && !s.fromCache) {
      merged[key] = {
        cliJs: s.cliJs,
        installDir: s.installDir || '',
        source: s.source || '',
        classifiedBy: s.classifiedBy || '',
        productName: s.productName || '',
        productEndpoint: s.productEndpoint || '',
        foundAt: new Date().toISOString(),
      };
    }
  }
  writeCache(appDir, { version: CACHE_VERSION, sites: merged, savedAt: new Date().toISOString() });

  // 报错文案：说清楚差在哪、下一步怎么填
  for (const key of want) {
    const s = out.sites[key];
    if (s.ok) continue;
    s.error = (out.packed || []).length
      ? `找到了 WorkBuddy 安装目录，但里面的 CLI 还打包在 app.asar 里，没法直接调用。请把${sites.siteLabel(key)}完整跑过一次，或在控制台里手动填 CLI 路径。`
      : `没有找到${sites.siteLabel(key)}的 CLI。请把它装好并至少登录一次，或在控制台里手动填 CLI 路径（形如 <安装目录>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy）。`;
  }

  return out;
}

// 老接口：只找一个（默认国内站），保留给老调用方
function locate({ appDir, explicit = '', force = false, log = () => {} } = {}) {
  const r = locateAll({ appDir, want: ['cn'], cfg: { cn: { cliJs: explicit } }, force, log });
  const cn = r.sites.cn || { ok: false };
  return cn.ok
    ? { ok: true, cliJs: cn.cliJs, installDir: cn.installDir, source: cn.source, classifiedBy: cn.classifiedBy }
    : { ok: false, error: cn.error || '没有找到 WorkBuddy。', packed: r.packed };
}

module.exports = {
  locate,
  locateAll,
  scanRoots,
  scanRootsAll,
  assignToSites,
  candidatesFromProcesses,
  candidatesFromPath,
  candidatesFromRegistry,
  readCache,
  writeCache,
  clearCache,
  cachePath,
  probeDir,
  CACHE_NAME,
  CACHE_VERSION,
};
