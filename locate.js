/*
 * 自动定位 WorkBuddy 的 CLI，不写死任何盘符或路径。
 *
 * 顺序（找到就停）：
 *   1. 配置或命令行里手写的路径（用户说了算）
 *   2. 上次找到的缓存 .wb-location.json
 *   3. 问系统：正在运行的 WorkBuddy 进程的 exe 路径
 *   4. 问系统：PATH 里的 codebuddy / cbc
 *   5. 问系统：注册表卸载信息里的 InstallLocation
 *   6. 按盘符遍历目录树（有深度上限和超时，只读目录名）
 *
 * 找到后写进缓存，下次直接用；缓存里的路径如果不存在了，自动重新走一遍。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CACHE_NAME = '.wb-location.json';
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
const isWin = process.platform === 'win32';

/* ---------------- 工具 ---------------- */

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function cachePath(appDir) {
  return path.join(appDir, CACHE_NAME);
}

function readCache(appDir) {
  try { return JSON.parse(fs.readFileSync(cachePath(appDir), 'utf8')); } catch { return null; }
}

function writeCache(appDir, data) {
  try { fs.writeFileSync(cachePath(appDir), JSON.stringify(data, null, 2) + '\n', 'utf8'); } catch {}
}

function clearCache(appDir) {
  try { fs.rmSync(cachePath(appDir), { force: true }); } catch {}
}

// 在某个安装目录里找 CLI 入口
function probeDir(dir) {
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

/* ---------------- 各种来源 ---------------- */

// 3. 正在运行的 WorkBuddy 进程
function fromRunningProcess() {
  const out = psOne(
    "Get-Process -Name WorkBuddy,'WorkBuddy*' -ErrorAction SilentlyContinue | " +
    'Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path',
    8000,
  );
  if (!out) return null;
  const exe = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (!exe) return null;
  const p = probeDir(path.dirname(exe));
  return p ? { cliJs: p, source: '运行中的 WorkBuddy 进程', installDir: path.dirname(exe) } : null;
}

// 4. PATH 里的 codebuddy / cbc
function fromPath() {
  for (const name of ['codebuddy', 'cbc', 'codebuddy.cmd', 'codebuddy.exe']) {
    const found = (() => {
      try {
        return execFileSync(isWin ? 'where' : 'which', [name],
          { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch { return ''; }
    })();
    if (!found) continue;
    const first = found.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && isFile(first)) return { cliJs: first, source: 'PATH 里的 ' + name, installDir: '' };
  }
  return null;
}

// 5. 注册表里的卸载信息
function fromRegistry() {
  const out = psOne(
    "$keys = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
    "Get-ItemProperty $keys -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.DisplayName -like '*WorkBuddy*' } | " +
    'Select-Object -ExpandProperty InstallLocation -Unique',
    10000,
  );
  for (const dir of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    for (const d of [dir, path.dirname(dir)]) {
      const p = probeDir(d);
      if (p) return { cliJs: p, source: '注册表卸载信息', installDir: d };
    }
  }
  return null;
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

function scanRoots({ maxDepth = 3, deadlineMs = 12000, log = () => {}, roots: rootsOverride = null } = {}) {
  const extraRoots = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
    os.homedir(),
    process.env.LOCALAPPDATA || '',
    process.env.APPDATA || '',
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || '',
    process.env.ProgramData || '',
  ].filter((p) => { try { return p && fs.statSync(p).isDirectory(); } catch { return false; } });

  const roots = rootsOverride || [...new Set([...extraRoots, ...driveRoots()])];
  const t0 = Date.now();
  const packed = [];
  let visited = 0;

  for (const root of roots) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      if (Date.now() - t0 > deadlineMs) {
        log(`[locate] 遍历超时（已看 ${visited} 个目录），先放弃`);
        return packed.length ? { packed } : null;
      }
      const { dir, depth } = queue.shift();
      visited++;
      const hit = probeDir(dir);
      if (hit) return { cliJs: hit, source: '目录遍历', installDir: dir, visited };
      if (depth < maxDepth) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const name = e.name.toLowerCase();
          if (SKIP_DIRS.has(name) || name.startsWith('$')) continue;
          if (name === 'appdata' && depth > 0) continue;
          queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
      if (depth === 0) {
        // 根目录本身是安装目录的情况顺便记一下（用于给出更准的错误提示）
        if (hasPackedAsar(root)) packed.push(root);
      }
    }
  }
  log(`[locate] 遍历完成，看了 ${visited} 个目录，没找到 CLI`);
  return packed.length ? { packed } : null;
}

/* ---------------- 对外入口 ---------------- */

/**
 * @param {object} opts
 * @param {string} opts.appDir       本程序目录（缓存文件放这里）
 * @param {string} [opts.explicit]   配置/命令行里手写的路径
 * @param {boolean} [opts.force]     忽略缓存，强制重新找
 * @param {Function} [opts.log]
 * @returns {{ok:boolean, cliJs?:string, installDir?:string, source?:string, error?:string, packed?:string[]}}
 */
function locate({ appDir, explicit = '', force = false, log = () => {} } = {}) {
  // 1. 手写路径最高优先
  if (explicit) {
    if (isFile(explicit)) return { ok: true, cliJs: explicit, installDir: path.dirname(path.dirname(path.dirname(explicit))), source: '配置里手写的路径' };
    log(`[locate] 配置里的路径不存在，忽略并继续自动查找：${explicit}`);
  }

  // 2. 缓存
  if (!force) {
    const cached = readCache(appDir);
    if (cached && cached.cliJs) {
      if (isFile(cached.cliJs)) {
        return { ok: true, cliJs: cached.cliJs, installDir: cached.installDir || '', source: '上次记住的路径' };
      }
      log(`[locate] 上次记住的路径已失效（${cached.cliJs}），重新查找`);
      clearCache(appDir);
    }
  }

  // 3~5. 问系统
  for (const strategy of [fromRunningProcess, fromPath, fromRegistry]) {
    let r = null;
    try { r = strategy(); } catch {}
    if (r) {
      writeCache(appDir, { cliJs: r.cliJs, installDir: r.installDir || '', source: r.source, foundAt: new Date().toISOString() });
      return { ok: true, ...r };
    }
  }

  // 6. 遍历
  log('[locate] 系统信息里没找到，开始按盘符遍历（只读目录名，最多十几秒）');
  const scanned = scanRoots({ log });
  if (scanned && scanned.cliJs) {
    writeCache(appDir, { cliJs: scanned.cliJs, installDir: scanned.installDir || '', source: scanned.source, foundAt: new Date().toISOString() });
    return { ok: true, cliJs: scanned.cliJs, installDir: scanned.installDir, source: scanned.source };
  }

  const packed = (scanned && scanned.packed) || [];
  return {
    ok: false,
    packed,
    error: packed.length
      ? '找到了 WorkBuddy 安装目录，但里面的 CLI 还打包在 app.asar 里，没法直接调用。请把 AppData 里的 WorkBuddy 完整跑过一次，或手动在 config.json 的 cli.cliJs 里填 CLI 路径。'
      : '没有找到 WorkBuddy。请在 config.json 的 cli.cliJs 里手写 CLI 路径（形如 <安装目录>\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy）。',
  };
}

module.exports = { locate, scanRoots, fromRunningProcess, fromPath, fromRegistry, readCache, writeCache, clearCache, cachePath, probeDir, CACHE_NAME };
