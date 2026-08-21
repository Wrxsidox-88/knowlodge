import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT_DIR, getEnv } from '../config.js';

// ============================================================
// knowlodge 更新核心（纯逻辑，无 db 依赖）
//   供主进程（检测/对比/进度查询）与独立更新进程（updater-run.mjs）共用。
//   版本文件：.release/.version 与 .release/.version.update（本地与仓库同路径）。
//   更新模式：
//     incremental —— 增量更新：仅替换「变更/新增」文件，并删除仓库中已移除的文件
//     full        —— 全量更新：下载完整包，覆盖全部本地代码（数据/配置/依赖不受影响）
// ============================================================

export const PROJECT_ROOT = path.resolve(ROOT_DIR, '..'); // 项目根（.release、web 在项目根）
const RELEASE_DIR = path.join(PROJECT_ROOT, '.release');
const VERSION_FILE = path.join(RELEASE_DIR, '.version');
const VERSION_UPDATE_FILE = path.join(RELEASE_DIR, '.version.update');
export const DATA_DIR = path.join(ROOT_DIR, 'data'); // server/data

const STATE_FILE = path.join(DATA_DIR, 'update-state.json');
const RESULT_FILE = path.join(DATA_DIR, 'update-result.json');
const RUN_LOG = path.join(DATA_DIR, 'update-run.log');
export const PROGRESS_FILE = path.join(DATA_DIR, 'update-progress.json');

const DEFAULT_REPO = 'https://github.com/Wrxsidox-88/knowlodge';

// ---------- 配置 ----------
export function updateConfig() {
  return {
    repo: getEnv('UPDATE_REPO', DEFAULT_REPO),
    proxy: getEnv('UPDATE_PROXY', ''),
    intervalHours: Number(getEnv('UPDATE_INTERVAL_HOURS', '6')) || 6,
    // off=不自动检测;notify=仅检测提醒;download=检测并下载;auto=直接完成更新
    autoMode: getEnv('UPDATE_AUTO_MODE', 'notify'),
    // incremental=增量对比更新;full=全量完整包覆盖
    method: getEnv('UPDATE_METHOD', 'incremental'),
    branch: getEnv('UPDATE_BRANCH', '')
  };
}

export function parseRepo(repo) {
  const m = String(repo || '').trim().match(/(?:github\.com\/|^)([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i);
  if (!m) throw new Error('仓库地址无法解析（需为 GitHub 仓库，如 https://github.com/owner/repo）');
  return { owner: m[1], repo: m[2] };
}

// ---------- 版本比较 ----------
export function parseVersion(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: str.trim() };
}

export function isNewer(remote, local) {
  const r = parseVersion(remote), l = parseVersion(local);
  if (!r || !l) return false;
  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  return r.patch > l.patch;
}

// ---------- 本地版本 ----------
export function localVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

export function localChangelog() {
  try {
    return fs.readFileSync(VERSION_UPDATE_FILE, 'utf8');
  } catch {
    return '';
  }
}

// ---------- curl 子进程（支持代理，无新增依赖）----------
export function curl(args, { timeout = 30000, proxy = '' } = {}) {
  return new Promise((resolve, reject) => {
    const a = ['-fsSL', '--max-time', String(Math.floor(timeout / 1000))];
    if (proxy) a.push('--proxy', proxy);
    a.push('-L', ...args);
    execFile('curl', a, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: timeout + 2000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').slice(0, 300)));
      else resolve(stdout);
    });
  });
}

export async function fetchRaw(owner, repo, branch, pubPath, proxy, timeout = 30000) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pubPath}`;
  return curl([url], { timeout, proxy });
}

let _branchCache = null;
export async function ensureBranch(owner, repo, proxy) {
  if (_branchCache) return _branchCache;
  const cfg = updateConfig();
  if (cfg.branch) { _branchCache = cfg.branch; return _branchCache; }
  for (const b of ['HEAD', 'main', 'master']) {
    try {
      await fetchRaw(owner, repo, b, '.release/.version', proxy, 20000);
      _branchCache = b;
      return _branchCache;
    } catch { /* try next */ }
  }
  _branchCache = 'HEAD';
  return _branchCache;
}

// ---------- 检测上游 ----------
export async function checkUpstream() {
  const cfg = updateConfig();
  const state = { checkedAt: new Date().toISOString(), ok: false, error: '', localVersion: localVersion(), remoteVersion: null, changelog: '', hasUpdate: false, branch: '' };
  try {
    const { owner, repo } = parseRepo(cfg.repo);
    const branch = await ensureBranch(owner, repo, cfg.proxy);
    state.branch = branch;
    const remoteVersion = (await fetchRaw(owner, repo, branch, '.release/.version', cfg.proxy)).trim();
    let changelog = '';
    try { changelog = await fetchRaw(owner, repo, branch, '.release/.version.update', cfg.proxy); } catch { /* optional */ }
    if (!parseVersion(remoteVersion)) { state.error = '仓库版本号无法解析'; }
    else {
      state.remoteVersion = remoteVersion;
      state.localVersion = localVersion();
      state.changelog = changelog;
      state.hasUpdate = Boolean(localVersion()) && isNewer(remoteVersion, localVersion());
      state.ok = true;
    }
  } catch (e) {
    state.error = e.message;
    state.ok = false;
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export function lastCheck() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}

// ---------- 更新范围规则 ----------
// 目录分段命中即排除（不参与对比/替换/删除）
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'winui-lib', '.idea', 'backups', '.tmp-e2e', '.uiupgrade', 'dist']);
// 保留文件：任何模式下都绝不覆盖/删除（运行时配置、密钥、日志、锁文件等）
function isPreservedFile(rel) {
  const base = path.posix.basename(rel);
  if (base === '.env' || base.endsWith('.env')) return true;
  if (base.endsWith('.local')) return true;
  if (base.endsWith('.log')) return true;
  return false;
}

// 差异对比的范围排除：.release 版本文件由更新流程单独写入，不参与逐文件对比
export function isDiffExcluded(rel) {
  const segs = rel.split('/');
  for (const s of segs) {
    if (EXCLUDE_DIRS.has(s) || s === '.release') return true;
  }
  if (segs[0] === 'server' && segs[1] === 'data') return true;
  return isPreservedFile(rel);
}

// 全量覆盖时的「保留区」：这些目录/文件不删除、不覆盖（其余全部以仓库为准）
export function isFullPreserved(rel) {
  const segs = rel.split('/');
  for (const s of segs) {
    if (EXCLUDE_DIRS.has(s)) return true;
  }
  if (segs[0] === 'server' && segs[1] === 'data') return true;
  return isPreservedFile(rel);
}

function gitBlobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
}

// ---------- 远端文件树（GitHub API）----------
export async function listRemoteTree(owner, repo, branch, proxy) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const json = await curl([url, '-H', 'Accept: application/vnd.github+json'], { proxy, timeout: 60000 });
  const d = JSON.parse(json);
  const map = new Map();
  for (const e of d.tree || []) {
    if (e.type === 'blob') map.set(e.path, e.sha);
  }
  return map;
}

// ---------- 本地文件遍历（用于增量模式的「删除」检测与全量模式的备份/清理）----------
export async function walkLocalFiles() {
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const relp = rel ? rel + '/' + e.name : e.name;
      if (EXCLUDE_DIRS.has(e.name)) continue;
      if (relp === 'server/data' || relp.startsWith('server/data/')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, relp);
      else if (e.isFile()) out.push(relp);
    }
  }
  await walk(PROJECT_ROOT, '');
  return out;
}

// ---------- 差异对比（增量更新计划）----------
// 返回 files:[{path, action: create|modify|delete}] 及统计
export async function diffPlan() {
  const cfg = updateConfig();
  const { owner, repo } = parseRepo(cfg.repo);
  const branch = await ensureBranch(owner, repo, cfg.proxy);
  const tree = await listRemoteTree(owner, repo, branch, cfg.proxy);

  const files = [];
  let create = 0, modify = 0;
  for (const [rel, sha] of tree) {
    if (isDiffExcluded(rel)) continue;
    const lp = path.join(PROJECT_ROOT, rel);
    let exists = true, same = false;
    try {
      same = gitBlobSha(await fsp.readFile(lp)) === sha;
    } catch { exists = false; }
    if (same) continue;
    if (exists) { files.push({ path: rel, action: 'modify' }); modify++; }
    else { files.push({ path: rel, action: 'create' }); create++; }
  }

  // 删除：本地存在（且属更新管理范围）但仓库中已移除的文件
  let del = 0;
  const localFiles = await walkLocalFiles();
  for (const rel of localFiles) {
    if (isDiffExcluded(rel)) continue;
    if (rel === '.release/.version' || rel === '.release/.version.update') continue;
    if (!tree.has(rel)) { files.push({ path: rel, action: 'delete' }); del++; }
  }

  const state = lastCheck();
  return {
    branch,
    method: 'incremental',
    files,
    counts: { create, modify, delete: del, total: files.length },
    remoteVersion: state?.remoteVersion || null,
    localVersion: localVersion(),
    changelog: state?.changelog || ''
  };
}

// ---------- 暂存准备（下载）----------
function curlExit(cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('curl', cmdArgs, { timeout: opts.timeout || 180000 }, (e, so, se) => {
      if (e) reject(new Error(`${cmdArgs[0]} 失败(exit=${e.code ?? '?'})${se ? ': ' + String(se).slice(0, 200) : ''}`));
      else resolve(so);
    });
  });
}

// 全量：下载 codeload tarball 并解压到暂存，返回解压根目录（下载过程实时写进度）
export async function prepareFullStaging() {
  const cfg = updateConfig();
  const { owner, repo } = parseRepo(cfg.repo);
  const branch = cfg.branch || 'HEAD';
  const staging = path.join(DATA_DIR, 'update-staging', 'full-' + Date.now());
  fs.mkdirSync(staging, { recursive: true });
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${branch}`;
  const tgz = path.join(staging, 'repo.tgz');
  const proxyArgs = cfg.proxy ? ['--proxy', cfg.proxy] : [];

  let total = 0;
  try {
    const hd = await curl(['-I', url], { timeout: 15000, proxy: cfg.proxy });
    const m = /content-length:\s*(\d+)/i.exec(hd);
    if (m) total = Number(m[1]);
  } catch { /* 大小未知 → 前端显示不确定进度 */ }

  writeProgress('download', 5, '正在获取完整包…');
  await new Promise((resolve, reject) => {
    const child = execFile('curl', ['-fsSL', '-L', url, '-o', tgz, ...proxyArgs], { timeout: 300000 });
    let last = 0;
    const iv = setInterval(() => {
      let done = 0;
      try { done = fs.statSync(tgz).size; } catch {}
      const speed = (done - last) / 0.5; // bytes/s
      last = done;
      const pct = total > 0 ? Math.min(38, Math.round(5 + 33 * (done / total))) : null;
      const mb = (done / 1048576).toFixed(1);
      const tot = total > 0 ? (total / 1048576).toFixed(1) : '?';
      const sp = speed > 0 ? (speed / 1048576).toFixed(2) : '0';
      writeProgress('download', pct, `正在下载完整包 ${mb} MB / ${tot} MB（${sp} MB/s）`);
    }, 500);
    child.on('close', (code) => {
      clearInterval(iv);
      if (code === 0) resolve();
      else reject(new Error('下载失败（curl exit=' + code + '）'));
    });
  });

  writeProgress('unpack', 39, '正在解压完整包…');
  await new Promise((res, rej) => execFile('tar', ['-xzf', tgz, '-C', staging], (e) => (e ? rej(e) : res())));
  try { fs.rmSync(tgz, { force: true }); } catch {}
  const entries = fs.readdirSync(staging);
  if (!entries.length) throw new Error('完整包解压结果为空');
  writeProgress('unpack', 40, '完整包已就绪');
  return { root: path.join(staging, entries[0]), base: staging };
}

// 增量：按计划仅下载 create/modify 文件到暂存，返回 {stagingDir, deletions}
export async function prepareIncrementalStaging(plan) {
  const cfg = updateConfig();
  const { owner, repo } = parseRepo(cfg.repo);
  const branch = plan.branch || (await ensureBranch(owner, repo, cfg.proxy));
  const staging = path.join(DATA_DIR, 'update-staging', 'incr-' + Date.now());
  const downloads = (plan.files || []).filter((f) => f.action !== 'delete');
  const deletions = (plan.files || []).filter((f) => f.action === 'delete').map((f) => f.path);

  let i = 0;
  for (const f of downloads) {
    i++;
    writeProgress('download', Math.min(39, Math.round(5 + 34 * (i / Math.max(1, downloads.length)))),
      `正在下载差异文件 ${i}/${downloads.length}：${f.path}`);
    const target = path.join(staging, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodeURI(f.path)}`;
    await curlExit([url, '-o', target, ...(cfg.proxy ? ['--proxy', cfg.proxy] : [])], { timeout: 60000 });
  }

  // 版本文件一并暂存（应用阶段单独写入）
  for (const vf of ['.release/.version', '.release/.version.update']) {
    try {
      const txt = await fetchRaw(owner, repo, branch, vf, cfg.proxy);
      const target = path.join(staging, vf);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, txt, 'utf8');
    } catch { /* optional */ }
  }
  writeProgress('unpack', 40, '差异文件已就绪');
  return { root: staging, base: staging, deletions };
}

// 读取暂存目录内的 .release 版本信息
export function readStagingVersion(stagingDir) {
  let version = null, changelog = '';
  try { version = fs.readFileSync(path.join(stagingDir, '.release', '.version'), 'utf8').trim(); } catch {}
  try { changelog = fs.readFileSync(path.join(stagingDir, '.release', '.version.update'), 'utf8'); } catch {}
  return { version, changelog };
}

// ---------- 结果 / 日志 ----------
export function lastResult() {
  try { return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); }
  catch { return null; }
}
export function writeResult(o) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(o, null, 2), 'utf8');
  } catch {}
}

export function readRunLog() {
  try { return fs.readFileSync(RUN_LOG, 'utf8'); }
  catch { return ''; }
}
export function appendRunLog(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(RUN_LOG, s); } catch { /* ignore */ }
}
export function resetRunLog() {
  try { fs.writeFileSync(RUN_LOG, '', 'utf8'); } catch {}
}

// ---------- 更新进度（供前端轮询进度条；独立更新进程与主进程共用）----------
export function readProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return null; }
}
export function clearProgress() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ running: false, step: 'idle', percent: 0, message: '', ts: Date.now() }), 'utf8');
  } catch {}
}
export function writeProgress(step, percent, message, done = false) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ running: !done, step, percent, message, ts: Date.now() }, null, 2), 'utf8');
  } catch {}
}
