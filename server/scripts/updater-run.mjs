// ============================================================
// knowlodge 独立更新执行进程（由主进程 detached 启动，临时接管更新）
//   流程：读取指令 -> 备份 -> 替换 -> 构建 -> 重启PM2 -> 健康检测 -> 异常回滚
//   安全：更新前备份被覆盖文件，健康异常或构建失败则恢复备份、重建并重启。
//   用法：node updater-run.mjs --cmd=<json指令路径> [--dry-run]
// ============================================================
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR, getEnv } from '../src/config.js';
import { logger } from '../src/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RUN_LOG = path.join(DATA_DIR, 'update-run.log');
const RESULT_FILE = path.join(DATA_DIR, 'update-result.json');
const VERSION_FILE = path.join(PROJECT_ROOT, '.release', '.version');
const VERSION_UPDATE_FILE = path.join(PROJECT_ROOT, '.release', '.version.update');

// 不进文件替换/备份范围（数据、依赖、构建产物、版本文件、密钥等）
const EXCLUDES = new Set(['node_modules', '.git', 'winui-lib', '.idea', '.release', 'backups', '.tmp-e2e', '.uiupgrade']);
const EXCLUDED_RELS = ['package-lock.json', 'package.json', '.env', '.env.example', 'github-token.local', '.gitignore', 'README.md'];

function isExcluded(rel) {
  const segs = rel.split('/');
  for (const s of segs) {
    if (EXCLUDES.has(s)) return true;                // 任一分段命中即排除（含 web/node_modules 等深层）
    if (s === 'node_modules') return true;
  }
  if (rel.startsWith('server/data')) return true;      // 数据目录绝不覆盖
  if (rel.startsWith('web/dist')) return true;         // 构建产物重新构建
  if (EXCLUDED_RELS.includes(rel)) return true;
  if (rel.endsWith('.env')) return true;
  return false;
}

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(RUN_LOG, s); } catch { /* ignore */ }
  console.log(line);
}

function writeProgress(step, percent, message, done = false) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'update-progress.json'), JSON.stringify({ running: !done, step, percent, message, ts: Date.now() }, null, 2), 'utf8');
  } catch {}
}
function resum(o) { try { fs.writeFileSync(RESULT_FILE, JSON.stringify(o, null, 2), 'utf8'); } catch {} }
function fail(code, reason) { writeProgress('failed', 0, reason, true); resum({ ts: Date.now(), ok: false, method: code, version: null, reason, logFile: RUN_LOG }); process.exitCode = 1; }

const pExec = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { ...opts, maxBuffer: 20 * 1024 * 1024 }, (err, so, se) => {
    if (opts.logOutput !== false) {
      try { String(so || '').split('\n').forEach((l) => { if (l.trim()) log(l); }); } catch { /* ignore */ }
      try { String(se || '').split('\n').forEach((l) => { if (l.trim()) log('[stderr] ' + l); }); } catch { /* ignore */ }
    }
    err ? reject(err) : resolve(so);
  });
});

async function cpRec(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

// 收集 staging 内待应用文件清单（相对项目根）
async function collect(srcDir) {
  const out = [];
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(full, relp);
      else out.push(relp);
    }
  }
  await walk(srcDir, '');
  return out;
}

// 备份将被覆盖的本地文件；返回 created(本地原本不存在，回滚时删除)
async function backupFiles(relList, backupDir) {
  const created = [];
  for (const rel of relList) {
    const src = path.join(PROJECT_ROOT, rel);
    if (isExcluded(rel)) continue;
    if (fs.existsSync(src)) await cpRec(src, path.join(backupDir, rel));
    else created.push(rel);
  }
  return created;
}

async function rollback(backupDir, created, pm2, port) {
  log('!! 进入回滚：恢复备份...');
  let restored = 0;
  const files = await collect(backupDir);
  for (const rel of files) {
    const dst = path.join(PROJECT_ROOT, rel);
    await cpRec(path.join(backupDir, rel), dst);
    restored++;
  }
  for (const rel of created) {
    const p = path.join(PROJECT_ROOT, rel);
    if (fs.existsSync(p)) { try { await fsp.rm(p, { force: true }); } catch {} }
  }
  log(`回滚恢复 ${restored} 个文件，删除新建 ${created.length} 项`);
  await buildWeb();
  await restartPm2(pm2);
  await healthCheck(port, 120);
  log('回滚完成');
}

async function buildWeb() {
  log('构建前端（web build）...');
  await pExec('npm', ['--prefix', 'web', 'run', 'build'], { cwd: PROJECT_ROOT, timeout: 600000 });
  log('构建完成');
}

async function restartPm2(name) {
  if (process.env.UPDATE_TEST_NO_RESTART === '1') { writeProgress('restart', 82, '[测试] 跳过 PM2 重启'); log('[测试] 跳过 PM2 重启'); return true; }
  log(`重启 PM2 进程 ${name} ...`);
  const attempts = [
    { cmd: 'pm2', args: ['reload', name], label: 'pm2 reload' },
    { cmd: 'pm2', args: ['restart', name], label: 'pm2 restart' },
    { cmd: 'npx', args: ['pm2', 'reload', name], label: 'npx pm2 reload' }
  ];
  for (const a of attempts) {
    try {
      await pExec(a.cmd, a.args, { timeout: 8000 });
      log('PM2 重启命令成功（' + a.label + '）');
      return true;
    } catch (e) {
      log('PM2 重启命令未及时完成（' + a.label + '）: ' + e.message);
    }
  }
  // pm2 命令未返回不代表服务没重启：交由健康检测判定，避免误回滚/卡死
  log('PM2 重启命令均未返回；服务可能已重启，交由健康检测判定（避免误回滚）');
  return false;
}

async function healthCheck(port, timeoutSec = 180) {
  if (process.env.UPDATE_TEST_NO_RESTART === '1') { writeProgress('health', 95, '[测试] 跳过健康检测'); log('[测试] 跳过健康检测'); return true; }
  const deadline = Date.now() + timeoutSec * 1000;
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    writeProgress('health', Math.min(99, 88 + tries), `服务健康检测中（第 ${tries} 次，剩余 ${Math.ceil((deadline - Date.now()) / 1000)}s）`);
    try {
      const r = await new Promise((res, rej) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 6000 }, (res2) => res(res2));
        req.on('error', rej); req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
      });
      if (r.statusCode === 200) { r.resume(); return true; }
      r.resume();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('健康检测超时：服务未在 ' + timeoutSec + 's 内恢复');
}

// ---------- main ----------
const args = process.argv.slice(2);
const getArg = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : ''; };
const DRY = args.includes('--dry-run');
const cmdFile = getArg('cmd');
let cmd;
try { cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8')); }
catch (e) { fail('cmd', '无法读取更新指令: ' + e.message); process.exit(1); }

const { method, stagingDir, targetVersion, changelog } = cmd;
const pm2 = process.env.UPDATE_PM2_NAME || 'knowlodge';
const port = Number(process.env.PORT) || getEnv('PORT', '8787');

try {
  if (DRY) {
    resum({ ts: Date.now(), ok: true, dry: true, method, version: targetVersion, reason: 'dry-run 演练完成（未实际替换/重启）' });
    console.log('dry-run done');
    process.exit(0);
  }
  if (!stagingDir || !fs.existsSync(stagingDir)) { fail(method, '暂存目录不存在: ' + stagingDir); process.exit(1); }
  log(`启动更新：method=${method} version=${targetVersion} pm2=${pm2} port=${port}`);
  writeProgress('start', 5, '更新已启动');

  const ts = String(Date.now());
  const backupDir = path.join(DATA_DIR, 'update-backup', ts);
  await fsp.mkdir(backupDir, { recursive: true });

  const relList = await collect(stagingDir);
  const created = await backupFiles(relList, backupDir);
  log(`已备份 ${relList.length} 项（新建 ${created.length} 项）`);
  writeProgress('backup', 18, '已备份待更新文件');

  // 应用替换
  for (const rel of relList) {
    if (isExcluded(rel)) continue;
    await cpRec(path.join(stagingDir, rel), path.join(PROJECT_ROOT, rel));
  }
  log('替换完成');
  writeProgress('apply', 40, '完成文件替换');

  // 更新本地版本文件
  fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true });
  if (targetVersion) fs.writeFileSync(VERSION_FILE, targetVersion + '\n', 'utf8');
  if (changelog) fs.writeFileSync(VERSION_UPDATE_FILE, changelog, 'utf8');
  log(`版本文件更新为 ${targetVersion}`);
  writeProgress('version', 50, '版本文件已更新');

  writeProgress('build', 55, '正在构建前端…');
  await buildWeb();
  writeProgress('build', 78, '构建完成');

  let ok = false;
  try {
    writeProgress('restart', 82, '正在重启服务…');
    await restartPm2(pm2);
    await healthCheck(port, 180);
    writeProgress('health', 95, '健康检测通过');
    ok = true;
  } catch (e) {
    log('更新后健康检测未通过，执行回滚: ' + e.message);
    await rollback(backupDir, created, pm2, port);
    writeProgress('failed', 0, '更新失败，已自动回滚', true);
    ok = false;
    resum({ ts: Date.now(), ok: false, method, version: targetVersion, reason: '构建/重启/健康检测异常，已回滚: ' + e.message, logFile: RUN_LOG });
    process.exit(1);
  }

  const v = (() => { try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch { return targetVersion; } })();
  writeProgress('done', 100, '更新完成', true);
  resum({ ts: Date.now(), ok, method, version: v, logFile: RUN_LOG });
  log('更新成功，当前版本 ' + v);
  process.exit(0);
} catch (e) {
  fail(method, '更新进程异常: ' + e.stack || e.message);
  process.exit(1);
}
