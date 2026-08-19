import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { db, verifyPassword } from '../db.js';
import { logger } from '../logger.js';

// 开发者模式：状态持久化在 server/data/dev_mode.json，需登录且开启后生效。
export const devRouter = Router();

const STATE_FILE = path.join(DATA_DIR, 'dev_mode.json');
let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {
  state = { enabled: false };
}
if (typeof state.enabled !== 'boolean') state.enabled = false;

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* 持久化失败仅影响重启后状态 */
  }
}

// 校验当前用户密码（enable / clear-data 均要求）
function requirePassword(req, res) {
  const { password } = req.body || {};
  if (!password) {
    res.status(400).json({ error: '请输入密码' });
    return false;
  }
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!row || !verifyPassword(password, row.password_hash)) {
    res.status(400).json({ error: '密码不正确' });
    return false;
  }
  return true;
}

devRouter.get('/status', (req, res) => {
  res.json({ enabled: !!state.enabled });
});

devRouter.post('/enable', (req, res) => {
  if (!requirePassword(req, res)) return;
  state.enabled = true;
  persist();
  logger.warn('开发者模式已开启', { user: req.user.username });
  res.json({ enabled: true });
});

devRouter.post('/disable', (req, res) => {
  state.enabled = false;
  persist();
  logger.warn('开发者模式已关闭', { user: req.user.username });
  res.json({ enabled: false });
});

devRouter.get('/logs', (req, res) => {
  if (!state.enabled) return res.status(403).json({ error: '开发者模式未开启' });
  res.json({ logs: logger.recent(300) });
});

// 清空系统数据（保留账户与系统配置）
const CLEAR_TABLES = [
  'messages', 'conversations',
  'analysis_jobs', 'analysis_batches',
  'material_images', 'chunks', 'sub_graph_nodes', 'knowledge_edges', 'sub_graphs', 'knowledge_nodes', 'materials',
  'wrong_question_nodes', 'wrong_questions', 'error_cause_tags',
  'mastery', 'practices', 'exam_events', 'exams',
  'countdowns', 'knowledge_lists', 'documents', 'mindmaps', 'study_encourage'
];

devRouter.post('/clear-data', (req, res) => {
  if (!requirePassword(req, res)) return;
  const removed = {};
  for (const table of CLEAR_TABLES) {
    try {
      const r = db.prepare(`DELETE FROM ${table}`).run();
      removed[table] = r.changes;
    } catch (e) {
      removed[table] = `清空失败: ${e.message}`;
    }
  }
  logger.warn('系统数据已清空', { user: req.user.username, removed });
  res.json({ ok: true, removed });
});
