import path from 'node:path';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT_DIR, getEnv } from '../config.js';
import { logger } from '../logger.js';
import { db } from '../db.js';

// ============================================================
// knowlodge 版本与更新服务
//   版本文件统一存放相对路径 .release/.version 与 .release/.version.update
//   （本地与仓库同一路径，见 README/仓库约定）
//   基于 GitHub 仓库做检测对比与增量/全量更新；更新在主进程外由独立进程执行，
//   具备 备份 -> 替换 -> 构建 -> 重启 -> 健康检测 -> 失败回滚 流程。
// ============================================================

export const PROJECT_ROOT = path.resolve(ROOT_DIR, '..'); // 仓库/项目根（.release、web 在项目根）
const RELEASE_DIR = path.join(PROJECT_ROOT, '.release');
const VERSION_FILE = path.join(RELEASE_DIR, '.version');
const VERSION_UPDATE_FILE = path.join(RELEASE_DIR, '.version.update');
const DATA_DIR_LOCAL = path.join(ROOT_DIR, 'data');
export const DATA_DIR = DATA_DIR_LOCAL; // server/data
const STATE_FILE = path.join(DATA_DIR, 'update-state.json');
const RESULT_FILE = path.join(DATA_DIR, 'update-result.json');
const RUN_LOG = path.join(DATA_DIR, 'update-run.log');

const DEFAULT_REPO = 'https://github.com/Wrxsidox-88/knowlodge';

// ---------- 配置 ----------
export function updateConfig() {
  return {
    repo: getEnv('UPDATE_REPO', DEFAULT_REPO),
    proxy: getEnv('UPDATE_PROXY', ''),
    intervalHours: Number(getEnv('UPDATE_INTERVAL_HOURS', '6')) || 6,
    // off=不自动检测;notify=仅检测提醒;download=检测并下载;auto=直接完成更新
    autoMode: getEnv('UPDATE_AUTO_MODE', 'notify'),
    // incremental=增量对比更新;full=完整包替换
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
    const v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    return parseVersion(v) ? v : v;
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
function curl(args, { timeout = 30000, proxy = '' } = {}) {
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

async function fetchRaw(owner, repo, branch, pubPath, proxy, timeout = 30000) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pubPath}`;
  return curl([url], { timeout, proxy });
}

let _branchCache = null;
async function ensureBranch(owner, repo, proxy) {
  if (_branchCache) return _branchCache;
  const cfg = updateConfig();
  if (cfg.branch) { _branchCache = cfg.branch; return _branchCache; }
  for (const b of ['HEAD', 'main', 'master']) {
    try {
      await fetchRaw(owner, repo, b, '.release/.version', proxy, 20000);
      _branchCache = b;
      return b;
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

// ---------- 文件清单对比（增量）----------
function isExcluded(p) {
  const segs = p.split('/');
  for (const s of segs) {
    if (['node_modules', '.git', 'winui-lib', '.idea', '.release', 'backups', '.tmp-e2e', '.uiupgrade', 'dist'].includes(s)) return true;
  }
  if (segs[0] === 'server' && segs[1] === 'data') return true;
  if (p.endsWith('.env') || p === 'github-token.local' || p.endsWith('package-lock.json')) return true;
  return false;
}

function gitBlobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
}

async function listRemoteFiles(owner, repo, branch, proxy) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const json = await curl([url, '-H', 'Accept: application/vnd.github+json'], { proxy, timeout: 60000 });
  const d = JSON.parse(json);
  return (d.tree || []).filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha }));
}

export async function diffPlan() {
  const cfg = updateConfig();
  const { owner, repo } = parseRepo(cfg.repo);
  const branch = await ensureBranch(owner, repo, cfg.proxy);
  const files = await listRemoteFiles(owner, repo, branch, cfg.proxy);
  const plan = [];
  for (const f of files) {
    if (isExcluded(f.path)) continue;
    const lp = path.join(PROJECT_ROOT, f.path);
    let need = false;
    try {
      if (gitBlobSha(fs.readFileSync(lp)) !== f.sha) need = true;
    } catch { need = true; }
    if (need) plan.push({ path: f.path, sha: f.sha, action: !fs.existsSync(lp) ? 'create' : 'modify' });
  }
  const local = localVersion();
  const state = lastCheck();
  return {
    branch,
    changedFiles: plan,
    count: plan.length,
    remoteVersion: state?.remoteVersion || null,
    localVersion: local,
    changelog: state?.changelog || ''
  };
}

// ---------- 下载差异文件到暂存区 ----------
export async function prepareIncremental(plan, branch) {
  const cfg = updateConfig();
  const { owner, repo } = parseRepo(cfg.repo);
  const br = branch || (await ensureBranch(owner, repo, cfg.proxy));
  const ts = Date.now();
  const staging = path.join(DATA_DIR, 'update-staging', String(ts));
  let done = 0;
  for (const f of plan) {
    const target = path.join(staging, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${br}/${f.path}`;
    await curl([url, '-o', target], { proxy: cfg.proxy, timeout: 60000 });
    done++;
  }
  // 版本文件
  for (const vf of ['.release/.version', '.release/.version.update']) {
    try {
      const txt = await fetchRaw(owner, repo, br, vf, cfg.proxy);
      const target = path.join(staging, vf);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, txt, 'utf8');
    } catch { /* optional */ }
  }
  return { stagingDir: staging, downloaded: done };
}

// ---------- 运行中任务检测 ----------
const BUSY_TABLES = [
  () => { try { return db.prepare("SELECT COUNT(*) c FROM analysis_jobs WHERE status IN ('running','pending')").get().c || 0; } catch { return 0; } }
];
export function runningTasks() {
  let total = 0;
  for (const q of BUSY_TABLES) total += q();
  return total;
}

// ---------- 结果读取 ----------
export function lastResult() {
  try { return JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); }
  catch { return null; }
}

export function readRunLog() {
  try { return fs.readFileSync(RUN_LOG, 'utf8'); }
  catch { return ''; }
}

// ---------- 更新进度（供前端轮询进度条）----------
const PROGRESS_FILE = path.join(DATA_DIR, 'update-progress.json');
export function readProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return null; }
}
export function clearProgress() {
  try { fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ running: false, step: 'idle', percent: 0, message: '', ts: Date.now() }), 'utf8'); } catch {}
}

// ---------- 触发独立更新进程 ----------
export function runUpdater({ method, stagingDir, targetVersion, changelog }) {
  if (runningTasks() > 0) return { started: false, busy: true, tasks: runningTasks() };
  const pm2 = process.env.UPDATE_PM2_NAME || 'knowlodge';
  const port = getEnv('PORT', '8787');
  const tmp = path.join(DATA_DIR, 'update-cmd.json');
  fs.writeFileSync(tmp, JSON.stringify({ method, stagingDir, targetVersion, changelog }, null, 2), 'utf8');
  const script = path.join(PROJECT_ROOT, 'server', 'scripts', 'updater-run.mjs');
  const child = spawn(process.execPath, [script, '--cmd=' + tmp], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, UPDATE_PM2_NAME: pm2 }
  });
  child.unref();
  logger.info(`已触发独立更新进程 pid=${child.pid} method=${method} version=${targetVersion}`);
  return { started: true, pid: child.pid || 0, busy: false };
}

// ---------- 定时调度器 ----------
let _schedulerStarted = false;
export function startUpdateScheduler() {
  if (_schedulerStarted) return;
  _schedulerStarted = true;
  const loop = async () => {
    const cfg = updateConfig();
    if (cfg.autoMode === 'off') return;
    try {
      const state = await checkUpstream();
      if (!state.ok || !state.hasUpdate) return;
      if (cfg.autoMode === 'notify') return; // 仅更新 state，前端提醒
      const plan = await diffPlan();
      if (cfg.autoMode === 'download') {
        await prepareIncremental(plan.changedFiles, plan.branch);
        logger.info(`[update] 自动下载完成，待确认应用 (${plan.count} 个文件)`);
        return;
      }
      // auto = 直接完成更新；等待运行任务结束
      await waitIdle();
      const staging = (await prepareIncremental(plan.changedFiles, plan.branch)).stagingDir;
      const res = runUpdater({ method: cfg.method, stagingDir: staging, targetVersion: plan.remoteVersion, changelog: plan.changelog });
      logger.info('[update] 自动更新已触发', res);
    } catch (e) {
      logger.error(`[update] 自动检测失败: ${e.message}`);
    }
  };
  const mk = () => setTimeout(() => { loop().finally(mk); }, updateConfig().intervalHours * 3600 * 1000);
  // 首轮延时启动，避免与启动抢资源
  setTimeout(() => loop().finally(mk), 60 * 1000);
}

async function waitIdle() {
  for (let i = 0; i < 1200; i++) {
    if (runningTasks() === 0) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}
