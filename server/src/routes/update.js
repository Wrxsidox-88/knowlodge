import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { setEnv } from '../config.js';
import { logger } from '../logger.js';
import { db, verifyPassword } from '../db.js';
import {
  updateConfig, localVersion, localChangelog, checkUpstream, lastCheck, lastResult, readRunLog,
  diffPlan, prepareIncremental, runUpdater, runningTasks, parseRepo, DATA_DIR, PROJECT_ROOT,
  readProgress, clearProgress
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
    progress: readProgress(),
    runLog: result?.ok || result?.reason ? readRunLog().slice(-4000) : ''
  });
});

updateRouter.post('/settings', (req, res) => {
  // 修改更新相关设置需密码验证
  if (!requirePassword(req.user, req.body?.password || '')) {
    return res.status(403).json({ error: '密码验证失败，无法修改更新设置' });
  }
  const v = req.body?.values || {};
  const updates = {};
  for (const [k, env] of Object.entries(KEY_TO_ENV)) {
    if (k in v) updates[env] = String(v[k] ?? '').trim();
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

// 下载仓库 tarball 并解压，返回 full 暂存根目录
async function prepareFull(staging) {
  const cfg = updateConfig();
  const { owner, repo } = parseRepo(cfg.repo);
  const branch = cfg.branch || 'HEAD';
  const tgz = path.join(staging, 'repo.tgz');
  await execFileAsync('curl', ['-fsSL', '-L', `https://codeload.github.com/${owner}/${repo}/tar.gz/${branch}`, '-o', tgz], { timeout: 120000 });
  await execFileAsync('tar', ['-xzf', tgz, '-C', staging]);
  const entries = fs.readdirSync(staging).filter((n) => n !== 'repo.tgz');
  return path.join(staging, entries[0]);
}

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: 50 * 1024 * 1024 }, (err, so) => (err ? reject(err) : resolve(so)));
  });
}

updateRouter.post('/apply', async (req, res, next) => {
  try {
    const { password, method, targetVersion, changelog, force } = req.body || {};
    const tasks = runningTasks();
    if (tasks > 0) {
      return res.status(409).json({ error: '当前有运行中的任务，请等待其结束或失败后再更新', busy: tasks });
    }
    // 增量/全量均需密码验证（auto 直更由主进程调度并且无需人工交互，本端点仅用于手动确认）
    if (!requirePassword(req.user, password)) {
      return res.status(403).json({ error: '密码验证失败，无法执行更新' });
    }
    const m = method === 'full' ? 'full' : 'incremental';
    const plan = await diffPlan();
    let stagingDir;
    if (m === 'full') {
      const staging = path.join(DATA_DIR, 'update-staging', 'full-' + Date.now());
      fs.mkdirSync(staging, { recursive: true });
      stagingDir = await prepareFull(staging);
    } else {
      if (!plan.count) {
        if (force) return res.json({ ok: true, skipped: true, force: true, message: '本地已与仓库一致，无需强制更新' });
        return res.json({ ok: true, skipped: true, message: '没有需要更新的差异文件（已是最新）' });
      }
      const st = await prepareIncremental(plan.changedFiles, plan.branch);
      stagingDir = st.stagingDir;
    }
    const tgt = targetVersion || plan.remoteVersion;
    const chg = changelog || plan.changelog || '';
    clearProgress();
    const started = runUpdater({ method: m, stagingDir, targetVersion: tgt, changelog: chg });
    if (!started.started) return res.status(409).json({ error: '更新启动失败', busy: started.tasks });
    res.json({ ok: true, started: true, method: m, version: tgt, pid: started.pid, stagingDir });
  } catch (e) {
    next(e);
  }
});



