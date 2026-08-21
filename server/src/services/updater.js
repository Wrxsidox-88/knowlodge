import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { logger } from '../logger.js';
import { db } from '../db.js';
import { getEnv } from '../config.js';
import {
  PROJECT_ROOT, DATA_DIR, updateConfig, prepareFullStaging,
  writeProgress, appendRunLog
} from './updaterCore.js';

// ============================================================
// knowlodge 版本与更新服务（主进程侧）
//   检测/对比/进度查询等纯逻辑见 updaterCore.js（与独立更新进程共用）。
//   更新一经启动即由独立进程（server/scripts/updater-run.mjs）接管：
//     下载 → 备份 → 替换/删除 → 依赖 → 构建 → 重启 → 自检 →（失败）紧急回滚
// ============================================================

export * from './updaterCore.js';

// ---------- 运行中任务检测（更新前需等待为空）----------
const BUSY_TABLES = [
  () => { try { return db.prepare("SELECT COUNT(*) c FROM analysis_jobs WHERE status IN ('running','pending')").get().c || 0; } catch { return 0; } }
];
export function runningTasks() {
  let total = 0;
  for (const q of BUSY_TABLES) total += q();
  return total;
}

// ---------- 触发独立更新进程 ----------
// 本函数只负责写指令并 detached 启动更新模块，立即下载；
// 下载/备份/替换/构建/重启/自检/回滚全部在更新模块内完成。
export function runUpdater({ method, force = false, targetVersion = null, changelog = '', requestedBy = '' }) {
  if (runningTasks() > 0) return { started: false, busy: true, tasks: runningTasks() };
  const m = method === 'full' ? 'full' : 'incremental';
  const pm2 = process.env.UPDATE_PM2_NAME || 'knowlodge';
  const tmp = path.join(DATA_DIR, 'update-cmd.json');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({
    method: m,
    force: !!force,
    targetVersion,
    changelog,
    requestedBy,
    requestedAt: new Date().toISOString()
  }, null, 2), 'utf8');
  const script = path.join(PROJECT_ROOT, 'server', 'scripts', 'updater-run.mjs');
  const child = spawn(process.execPath, [script, '--cmd=' + tmp], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, UPDATE_PM2_NAME: pm2, PORT: getEnv('PORT', '8787') }
  });
  child.unref();
  logger.info(`已触发独立更新进程 pid=${child.pid} method=${m} force=${!!force}`);
  appendRunLog(`[主进程] 触发独立更新进程 pid=${child.pid} method=${m} force=${!!force}`);
  return { started: true, pid: child.pid || 0, busy: false, method: m };
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
      const { checkUpstream } = await import('./updaterCore.js');
      const state = await checkUpstream();
      if (!state.ok || !state.hasUpdate) return;
      if (cfg.autoMode === 'notify') return; // 仅更新 state，前端提醒
      if (cfg.autoMode === 'download') {
        // 预下载完整包到暂存（不应用，待手动确认）；实际执行更新时会按需重新下载
        await prepareFullStaging();
        writeProgress('idle', 100, '自动预下载完成（待手动确认应用）', true);
        logger.info('[update] 自动下载完成（完整包），待确认应用');
        return;
      }
      // auto = 直接完成更新（按配置的更新模式执行）
      await waitIdle();
      const res = runUpdater({ method: cfg.method, force: true, requestedBy: 'scheduler' });
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
