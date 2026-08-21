import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { setEnv } from '../config.js';
import { logger } from '../logger.js';
import { db, verifyPassword } from '../db.js';
import {
  updateConfig, localVersion, localChangelog, checkUpstream, lastCheck, lastResult, readRunLog,
  diffPlan, runningTasks, readProgress, clearProgress, resetRunLog, runUpdater, PROJECT_ROOT
} from '../services/updater.js';

export const updateRouter = Router();

const KEY_TO_ENV = {
  repo: 'UPDATE_REPO',
  proxy: 'UPDATE_PROXY',
  intervalHours: 'UPDATE_INTERVAL_HOURS',
  autoMode: 'UPDATE_AUTO_MODE',
  method: 'UPDATE_METHOD',
  branch: 'UPDATE_BRANCH'
};

function requirePassword(user, password) {
  if (!password) return false;
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  return Boolean(row && verifyPassword(password, row.password_hash));
}

// 兜底：进度 running 但长时间无更新的（如更新进程意外终止）视为失效，避免前端永远停在某个步骤
function guardStaleProgress(p) {
  if (!p) return p;
  if (p.running !== false && p.ts && Date.now() - p.ts > 15 * 60 * 1000) return null;
  return p;
}

updateRouter.get('/status', (req, res) => {
  const cfg = updateConfig();
  const state = lastCheck();
  const result = lastResult();
  res.json({
    config: {
      repo: cfg.repo,
      proxy: cfg.proxy,
      intervalHours: cfg.intervalHours,
      autoMode: cfg.autoMode,
      method: cfg.method,
      branch: cfg.branch
    },
    local: {
      version: localVersion(),
      changelog: localChangelog()
    },
    lastCheck: state,
    lastResult: result,
    busy: runningTasks(),
    progress: guardStaleProgress(readProgress()),
    runLog: result?.ok || result?.reason ? readRunLog().slice(-4000) : ''
  });
});

updateRouter.post('/settings', (req, res) => {
  // 修改更新相关设置需密码验证
  if (!requirePassword(req.user, req.body?.password || '')) {
    return res.status(403).json({ error: '密码验证失败，无法修改更新设置' });
  }
  const v = req.body?.values || req.body || {}; // 兼容 {values} 与扁平两种结构
  const updates = {};
  for (const [k, env] of Object.entries(KEY_TO_ENV)) {
    if (k in v && k !== 'password') updates[env] = String(v[k] ?? '').trim();
  }
  if (updates.UPDATE_METHOD && !['incremental', 'full'].includes(updates.UPDATE_METHOD)) {
    return res.status(400).json({ error: '更新模式无效（可选 incremental / full）' });
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: '没有可保存的设置' });
  try {
    setEnv(updates);
    logger.info('更新设置已保存', { user: req.user.username });
    res.json({ ok: true, saved: Object.keys(updates) });
  } catch (e) {
    res.status(500).json({ error: '写入 .env 失败: ' + e.message });
  }
});

updateRouter.post('/check', async (req, res, next) => {
  try {
    const state = await checkUpstream();
    res.json(state);
  } catch (e) { next(e); }
});

// 差异对比预览（增量更新将执行的 新增/修改/删除 文件清单）
updateRouter.get('/diff', async (req, res, next) => {
  try {
    const plan = await diffPlan();
    res.json(plan);
  } catch (e) { next(e); }
});

// 系统介绍（仓库 README）
updateRouter.get('/readme', (req, res) => {
  try {
    const p = path.join(PROJECT_ROOT, 'README.md');
    res.json({ ok: true, content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 详细更新日志（更新模块的完整运行输出）
updateRouter.get('/log', (req, res) => {
  res.json({ ok: true, content: readRunLog() });
});

// 执行更新：验证后立即交由独立更新模块接管（下载→备份→替换→依赖→构建→重启→自检→回滚），
// 本接口即时返回，不阻塞等待下载；前端通过 /status 的 progress 轮询实时进度。
updateRouter.post('/apply', async (req, res, next) => {
  try {
    const { password, method, force, targetVersion, changelog } = req.body || {};
    const tasks = runningTasks();
    if (tasks > 0) {
      return res.status(409).json({ error: '当前有运行中的任务，请等待其结束或失败后再更新', busy: tasks });
    }
    if (!requirePassword(req.user, password)) {
      return res.status(403).json({ error: '密码验证失败，无法执行更新' });
    }
    const m = method === 'full' ? 'full' : 'incremental';
    const lc = lastCheck();
    const tgt = targetVersion || lc?.remoteVersion || null;
    const chg = changelog || lc?.changelog || '';

    resetRunLog();
    clearProgress(); // 下载/备份/替换/构建/重启/自检全程由更新模块写进度
    const started = runUpdater({ method: m, force: !!force, targetVersion: tgt, changelog: chg, requestedBy: req.user?.username || '' });
    if (!started.started) return res.status(409).json({ error: '更新启动失败', busy: started.tasks });
    logger.info(`更新已触发 method=${m} force=${!!force} version=${tgt || '(以仓库为准)'} user=${req.user?.username}`);
    res.json({ ok: true, started: true, method: m, version: tgt, pid: started.pid });
  } catch (e) {
    next(e);
  }
});
