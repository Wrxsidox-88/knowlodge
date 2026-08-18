import { Router } from 'express';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { listsAiAutocreateEnabled } from '../ai/client.js';

export const listsRouter = Router();

function getRow(id) {
  return db.prepare('SELECT * FROM knowledge_lists WHERE id = ?').get(Number(id));
}

function tree() {
  const rows = db.prepare('SELECT * FROM knowledge_lists ORDER BY kind DESC, updated_at DESC').all();
  const byParent = new Map();
  for (const r of rows) {
    const key = r.parent_id ?? 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  }
  const build = (parentId) =>
    (byParent.get(parentId) || []).map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      kind: r.kind,
      name: r.name,
      description: r.description,
      content: r.kind === 'note' ? r.content : null,
      aiEditable: Boolean(r.ai_editable),
      updatedAt: r.updated_at,
      children: r.kind === 'folder' ? build(r.id) : []
    }));
  return build(0);
}

listsRouter.get('/tree', (req, res) => {
  res.json({ items: tree(), aiAutocreate: listsAiAutocreateEnabled() });
});

listsRouter.get('/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '清单项不存在' });
  res.json(row);
});

listsRouter.post('/', (req, res) => {
  const { parentId = null, kind = 'note', name, description = '', content = '', aiEditable = false } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: '名称不能为空' });
  if (parentId && !getRow(parentId)) return res.status(400).json({ error: '上级目录不存在' });
  try {
    const info = db.prepare(
      'INSERT INTO knowledge_lists (parent_id, kind, name, description, content, ai_editable) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(parentId ? Number(parentId) : null, kind === 'folder' ? 'folder' : 'note', name.trim(), description, content, aiEditable ? 1 : 0);
    logger.info(`知识清单创建: ${kind}《${name.trim()}》`, { user: req.user.username });
    res.status(201).json(getRow(Number(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '同级下已存在同名条目' });
    throw e;
  }
});

listsRouter.put('/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '清单项不存在' });
  const { name, description, content, aiEditable } = req.body || {};
  db.prepare(
    `UPDATE knowledge_lists SET
       name = ?, description = ?, content = ?, ai_editable = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    name !== undefined ? String(name).trim() || row.name : row.name,
    description !== undefined ? description : row.description,
    content !== undefined ? content : row.content,
    aiEditable !== undefined ? (aiEditable ? 1 : 0) : row.ai_editable,
    row.id
  );
  res.json(getRow(row.id));
});

listsRouter.delete('/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '清单项不存在' });
  db.prepare('DELETE FROM knowledge_lists WHERE id = ?').run(row.id);
  logger.info(`知识清单删除: 《${row.name}》`, { user: req.user.username });
  res.json({ ok: true });
});

// AI 写入（工具调用）：仅允许写入用户已开启 AI 编辑权限的清单
listsRouter.post('/:id/ai-write', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '清单项不存在' });
  if (!row.ai_editable) return res.status(403).json({ error: '该清单未开启"允许 AI 编辑"' });
  const { content, mode = 'replace', note = '' } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content 必填' });
  const next = mode === 'append' ? `${row.content || ''}\n\n${content}` : content;
  db.prepare("UPDATE knowledge_lists SET content = ?, description = ifnull(?, description), updated_at = datetime('now') WHERE id = ?")
    .run(next, note || null, row.id);
  res.json(getRow(row.id));
});

// AI 自动创建清单（分析流程按需调用，受 LISTS_AI_AUTOCREATE 开关控制）
export function aiCreateList({ name, description = '', content = '', parentId = null }) {
  if (!listsAiAutocreateEnabled()) return null;
  try {
    const info = db.prepare(
      'INSERT INTO knowledge_lists (parent_id, kind, name, description, content, ai_editable) VALUES (?, ?, ?, ?, ?, 1)'
    ).run(parentId, 'note', String(name).trim().slice(0, 80), description, content);
    logger.info(`AI 自动创建知识清单《${name}》`);
    return getRow(Number(info.lastInsertRowid));
  } catch {
    return null;
  }
}
