// ============================================================
// knowlodge 专用更新模块（独立进程，由主进程 detached 启动后完全接管更新）
//
//   流程：下载代码 → 备份 → 替换/删除 → 版本文件 → 依赖安装(按需) →
//         前端构建 → 重启 PM2 → 自检(健康检测) →（失败时）紧急回滚
//
//   模式：
//     incremental  增量更新：仅替换「变更/新增」文件，并删除仓库中已移除的文件
//     full         全量更新：完整包覆盖全部本地代码（数据/配置/依赖目录不受影响）
//
//   安全：所有被覆盖/删除的文件先备份；构建失败或重启后自检未通过即恢复备份、
//         重新构建并重启，确保服务回到更新前状态。
//
//   用法：node updater-run.mjs --cmd=<json指令路径> [--dry-run]
// ============================================================
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { getEnv } from '../src/config.js';
import {
  PROJECT_ROOT, DATA_DIR, appendRunLog, writeResult, writeProgress,
  isFullPreserved, walkLocalFiles, diffPlan, prepareFullStaging, prepareIncrementalStaging,
  readStagingVersion
} from '../src/services/updaterCore.js';

const RUN_LOG = path.join(DATA_DIR, 'update-run.log');
const RELEASE_DIR = path.join(PROJECT_ROOT, '.release');
const VERSION_FILE = path.join(RELEASE_DIR, '.version');
const VERSION_UPDATE_FILE = path.join(RELEASE_DIR, '.version.update');
const BACKUP_ROOT = path.join(DATA_DIR, 'update-backup');

function log(line) {
  appendRunLog(line);
  console.log(line);
}

function fail(method, reason, extra = {}) {
  log('!! 更新失败: ' + reason);
  writeProgress('failed', 0, reason, true);
  writeResult({ ts: Date.now(), ok: false, method, version: null, reason, logFile: RUN_LOG, ...extra });
  process.exitCode = 1;
}

const pExec = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { ...opts, maxBuffer: 20 * 1024 * 1024 }, (err, so, se) => {
    if (opts.logOutput !== false) {
      try { String(so || '').split('\n').forEach((l) => { if (l.trim()) log(l); }); } catch { /* ignore */ }
      try { String(se || '').split('\n').forEach((l) => { if (l.trim()) log('[stderr] ' + l); }); } catch { /* ignore */ }
    }
    err ? reject(err) : resolve(so);
  });
});

async function copyFileTo(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
  // 保留文件权限位（如可执行位），使替换后的文件与源一致
  try { const st = await fsp.stat(src); await fsp.chmod(dst, st.mode & 0o777); } catch {}
}

// 收集目录内全部文件（相对 dir 的路径）
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

// 删除文件后向上清理空目录（不越过项目根）
async function pruneEmptyDirs(rel) {
  let dir = path.dirname(path.join(PROJECT_ROOT, rel));
  while (dir.length > PROJECT_ROOT.length) {
    try {
      const entries = await fsp.readdir(dir);
      if (entries.length) break;
      await fsp.rmdir(dir);
      dir = path.dirname(dir);
    } catch { break; }
  }
}

async function buildWeb() {
  log('构建前端（web build）...');
  await pExec('npm', ['--prefix', 'web', 'run', 'build'], { cwd: PROJECT_ROOT, timeout: 600000 });
  log('构建完成');
}

async function installDeps(dir) {
  log(`安装依赖（${dir}）...`);
  await pExec('npm', ['--prefix', dir, 'install', '--no-audit', '--no-fund'], { cwd: PROJECT_ROOT, timeout: 300000 });
  log(`依赖安装完成（${dir}）`);
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
      await pExec(a.cmd, a.args, { timeout: 15000 });
      log('PM2 重启命令成功（' + a.label + '）');
      return true;
    } catch (e) {
      log('PM2 重启命令未及时完成（' + a.label + '）: ' + e.message);
    }
  }
  // pm2 命令未返回不代表服务没重启：交由自检判定，避免误回滚/卡死
  log('PM2 重启命令均未返回；服务可能已重启，交由自检判定（避免误回滚）');
  return false;
}

// 自检：轮询 /api/health，2xx 即认为启动成功
async function healthCheck(port, timeoutSec = 180, label = '服务自检') {
  if (process.env.UPDATE_TEST_NO_RESTART === '1') { writeProgress('health', 95, '[测试] 跳过自检'); log('[测试] 跳过自检'); return true; }
  const deadline = Date.now() + timeoutSec * 1000;
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    writeProgress('health', Math.min(99, 86 + Math.min(13, tries)), `${label}中（第 ${tries} 次，剩余 ${Math.ceil((deadline - Date.now()) / 1000)}s）`);
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
  throw new Error(`自检超时：服务未在 ${timeoutSec}s 内恢复`);
}

// ---------- 备份与回滚 ----------
async function backupFiles(relList, backupDir) {
  let backed = 0;
  const created = []; // 本地原本不存在（回滚时需删除）
  for (const rel of relList) {
    const src = path.join(PROJECT_ROOT, rel);
    try {
      await fsp.access(src);
      await copyFileTo(src, path.join(backupDir, rel));
      backed++;
    } catch {
      created.push(rel);
    }
  }
  return { backed, created };
}

async function rollback(manifest, pm2, port) {
  log('!! 进入紧急回滚：恢复备份...');
  writeProgress('rollback', 30, '更新失败，正在紧急回滚…');
  const backupDir = manifest.backupDir;
  let restored = 0;
  const files = await collect(backupDir).then((l) => l.filter((r) => r !== 'manifest.json'));
  for (const rel of files) {
    await copyFileTo(path.join(backupDir, rel), path.join(PROJECT_ROOT, rel));
    restored++;
  }
  let removed = 0;
  for (const rel of manifest.created || []) {
    const p = path.join(PROJECT_ROOT, rel);
    try { await fsp.rm(p, { force: true }); removed++; } catch {}
  }
  log(`回滚：恢复 ${restored} 个文件，删除新建 ${removed} 项`);
  writeProgress('rollback', 45, '已恢复备份，正在重新构建…');
  try {
    await buildWeb();
    writeProgress('rollback', 70, '回滚构建完成，正在重启服务…');
    await restartPm2(pm2);
    await healthCheck(port, 120, '回滚后自检');
    writeProgress('rollback', 95, '回滚完成，服务已恢复', true);
    log('回滚完成，服务已恢复到更新前状态');
    return true;
  } catch (e) {
    log('!! 回滚后自检仍未通过: ' + e.message);
    writeProgress('failed', 0, '回滚后服务仍未恢复，请人工介入', true);
    return false;
  }
}

// 仅保留最近 N 份备份
function pruneBackups(keep = 5) {
  try {
    const dirs = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    while (dirs.length > keep) {
      const oldest = dirs.shift();
      fs.rmSync(path.join(BACKUP_ROOT, oldest), { recursive: true, force: true });
      log('清理旧备份: ' + oldest);
    }
  } catch { /* ignore */ }
}

// ---------- main ----------
const args = process.argv.slice(2);
const getArg = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : ''; };
const DRY = args.includes('--dry-run');
const cmdFile = getArg('cmd');
let cmd;
try { cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8')); }
catch (e) { fail('unknown', '无法读取更新指令: ' + e.message); process.exit(1); }

const method = cmd.method === 'full' ? 'full' : 'incremental';
let targetVersion = cmd.targetVersion || null;
let changelog = cmd.changelog || '';
const pm2 = process.env.UPDATE_PM2_NAME || 'knowlodge';
const port = Number(process.env.PORT) || Number(getEnv('PORT', '8787')) || 8787;

try {
  if (DRY) {
    writeResult({ ts: Date.now(), ok: true, dry: true, method, version: targetVersion, reason: 'dry-run 演练完成（未实际替换/重启）' });
    console.log('dry-run done');
    process.exit(0);
  }

  log(`===== 更新模块接管：method=${method} force=${!!cmd.force} pm2=${pm2} port=${port} =====`);
  writeProgress('start', 2, '更新已启动，更新模块接管');

  // ---------- 阶段 1：获取代码 ----------
  writeProgress('check', 4, method === 'full' ? '正在准备下载完整包…' : '正在对比仓库差异…');
  let staging, deletions = [];
  if (process.env.UPDATE_TEST_STAGING) {
    // 测试钩子：跳过下载，直接使用指定暂存目录（配合 UPDATE_TEST_NO_RESTART 做端到端演练）
    staging = { root: process.env.UPDATE_TEST_STAGING, base: process.env.UPDATE_TEST_STAGING };
    deletions = (process.env.UPDATE_TEST_DELETIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
    log('[测试] 使用本地暂存目录: ' + staging.root + (deletions.length ? `，模拟删除 ${deletions.length} 项` : ''));
  } else if (method === 'full') {
    staging = await prepareFullStaging(); // 下载/解压进度 5..40
  } else {
    const plan = await diffPlan();
    log(`差异对比完成：新增 ${plan.counts.create}，修改 ${plan.counts.modify}，删除 ${plan.counts.delete}`);
    if (plan.counts.total === 0) {
      writeProgress('done', 100, '本地代码已与仓库一致，无需更新', true);
      writeResult({ ts: Date.now(), ok: true, skipped: true, method, version: targetVersion, reason: '无差异，本地已与仓库一致', logFile: RUN_LOG });
      log('无差异，跳过更新');
      process.exit(0);
    }
    staging = await prepareIncrementalStaging(plan); // 下载进度 5..40
    deletions = staging.deletions;
  }
  const stagingRoot = staging.root;
  const stagingBase = staging.base;
  if (!stagingRoot || !fs.existsSync(stagingRoot)) throw new Error('暂存目录不存在: ' + stagingRoot);

  // 版本信息：优先指令携带，其次读暂存内 .release
  const sv = readStagingVersion(stagingRoot);
  if (!targetVersion && sv.version) targetVersion = sv.version;
  if (!changelog && sv.changelog) changelog = sv.changelog;
  log(`代码已就绪，目标版本 ${targetVersion || '(未知)'}`);

  // ---------- 阶段 2：备份 ----------
  writeProgress('backup', 42, '正在备份本地文件…');
  const ts = String(Date.now());
  const backupDir = path.join(BACKUP_ROOT, ts);
  await fsp.mkdir(backupDir, { recursive: true });

  let applyList, manifest;
  if (method === 'full') {
    // 全量：备份所有受管理的本地文件（保留区除外），随后整体以仓库为准
    applyList = (await walkLocalFiles()).filter((r) => !isFullPreserved(r));
    const { backed, created } = await backupFiles(applyList, backupDir);
    const createdSet = new Set(created);
    const stagedFiles = (await collect(stagingRoot)).filter((r) => !r.startsWith('.release/') && !isFullPreserved(r));
    // 本地原本不存在、更新后新增的文件
    const existedSet = new Set(applyList);
    const newFiles = stagedFiles.filter((r) => !existedSet.has(r));
    manifest = { mode: 'full', backupDir, created: [...createdSet, ...newFiles], ts };
    log(`全量模式：备份 ${backed} 个本地文件，暂存包含 ${stagedFiles.length} 个文件，新增 ${newFiles.length} 个`);
  } else {
    // 增量：仅备份将被替换/删除的文件（含版本文件，回滚时一并恢复）
    const stagedFiles = (await collect(stagingRoot)).filter((r) => !r.startsWith('.release/'));
    applyList = [...stagedFiles, ...deletions, '.release/.version', '.release/.version.update'];
    const { backed, created } = await backupFiles(applyList, backupDir);
    manifest = { mode: 'incremental', backupDir, created, deletions, ts };
    log(`增量模式：备份 ${backed} 个文件（其中新建 ${created.length} 个），待删除 ${deletions.length} 个`);
  }
  await fsp.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeProgress('backup', 47, '备份完成');

  // ---------- 阶段 3~8：应用 → 版本 → 依赖 → 构建 → 重启 → 自检 ----------
  // 备份完成后的任何一步失败都触发紧急回滚，确保服务回到更新前状态
  try {
    // 阶段 3：应用（替换/删除）
    writeProgress('apply', 48, method === 'full' ? '正在以仓库为准覆盖本地代码…' : '正在应用差异文件…');
    if (method === 'full') {
      // 先移除受管理的本地文件，再整体拷入暂存内容（保留区不受影响）
      for (const rel of applyList) {
        try { await fsp.rm(path.join(PROJECT_ROOT, rel), { force: true }); } catch {}
      }
      const stagedFiles = await collect(stagingRoot);
      let copied = 0;
      for (const rel of stagedFiles) {
        if (rel.startsWith('.release/')) continue; // 版本文件在阶段 4 单独写入
        if (isFullPreserved(rel)) continue;
        await copyFileTo(path.join(stagingRoot, rel), path.join(PROJECT_ROOT, rel));
        copied++;
      }
      log(`全量覆盖完成：移除旧文件 ${applyList.length} 个，写入 ${copied} 个文件`);
    } else {
      const stagedFiles = await collect(stagingRoot);
      let copied = 0;
      for (const rel of stagedFiles) {
        if (rel.startsWith('.release/')) continue;
        await copyFileTo(path.join(stagingRoot, rel), path.join(PROJECT_ROOT, rel));
        copied++;
      }
      let removed = 0;
      for (const rel of deletions) {
        try {
          await fsp.rm(path.join(PROJECT_ROOT, rel), { force: true });
          await pruneEmptyDirs(rel);
          removed++;
        } catch {}
      }
      log(`增量应用完成：替换/新增 ${copied} 个文件，删除 ${removed} 个文件`);
    }
    writeProgress('apply', 55, '文件替换完成');

    // 阶段 4：版本文件
    fs.mkdirSync(RELEASE_DIR, { recursive: true });
    if (targetVersion) fs.writeFileSync(VERSION_FILE, targetVersion + '\n', 'utf8');
    if (changelog) fs.writeFileSync(VERSION_UPDATE_FILE, changelog, 'utf8');
    log(`版本文件更新为 ${targetVersion || '(未提供)'}`);
    writeProgress('version', 58, '版本文件已更新');

    // 阶段 5：依赖安装（package.json 变化时按需执行）
    for (const dir of ['server', 'web']) {
      const pj = path.join(PROJECT_ROOT, dir, 'package.json');
      const pjBak = path.join(backupDir, dir, 'package.json');
      let changed = false;
      try {
        changed = fs.readFileSync(pj, 'utf8') !== fs.readFileSync(pjBak, 'utf8');
      } catch { changed = fs.existsSync(pj); }
      if (changed) {
        writeProgress('deps', 60, `依赖有变化，正在安装（${dir}）…`);
        await installDeps(dir);
      }
    }

    // 阶段 6：构建
    writeProgress('build', 65, '正在构建前端…');
    await buildWeb();
    writeProgress('build', 78, '构建完成');

    // 阶段 7：重启 + 阶段 8：自检
    writeProgress('restart', 82, '正在重启服务…');
    await restartPm2(pm2);
    await healthCheck(port, 180);
    writeProgress('health', 99, '自检通过');
  } catch (e) {
    log('更新失败，执行紧急回滚: ' + e.message);
    const restored = await rollback(manifest, pm2, port);
    writeResult({
      ts: Date.now(), ok: false, method, version: targetVersion, rolledBack: restored,
      reason: '替换/依赖/构建/重启/自检异常，已紧急回滚: ' + e.message, logFile: RUN_LOG
    });
    try { fs.rmSync(stagingBase, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }

  // ---------- 完成 ----------
  const v = (() => { try { return fs.readFileSync(VERSION_FILE, 'utf8').trim(); } catch { return targetVersion; } })();
  writeProgress('done', 100, '更新成功', true);
  writeResult({ ts: Date.now(), ok: true, method, version: v, logFile: RUN_LOG });
  pruneBackups(5);
  try { fs.rmSync(stagingBase, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(cmdFile, { force: true }); } catch {}
  log(`更新成功，当前版本 ${v}`);
  process.exit(0);
} catch (e) {
  fail(method, '更新进程异常: ' + (e.stack || e.message));
  process.exit(1);
}
