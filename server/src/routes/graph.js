import { Router } from 'express';
import {
  getGraph, nodeDetail, getNodeRow, updateNode, deleteNode, addEdge, deleteEdge,
  listSubGraphs, createSubGraph, updateSubGraph, deleteSubGraph, updateSubGraphNodes
} from '../services/graph.js';
import { db } from '../db.js';
import { aiEnabled, chat } from '../ai/client.js';
import { logger } from '../logger.js';

export const graphRouter = Router();

graphRouter.get('/', (req, res) => {
  const { subject, keyword, nodeId, depth, limit, full } = req.query;
  const data = getGraph({ subject, keyword, nodeId, depth, limit, full: full === '1' });
  const subjects = db.prepare(
    'SELECT DISTINCT subject FROM knowledge_nodes WHERE subject IS NOT NULL ORDER BY subject'
  ).all().map((r) => r.subject);
  res.json({ ...data, subjects });
});

graphRouter.get('/node/:id', (req, res) => {
  const detail = nodeDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: '知识点不存在' });
  res.json(detail);
});

graphRouter.get('/node/:id/explain', async (req, res, next) => {
  try {
    const nodeId = Number(req.params.id);
    const node = db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: '知识点不存在' });
    const force = req.query.force === '1';

    if (node.description && !force) {
      return res.json({ description: node.description, source: 'stored' });
    }
    if (!aiEnabled()) {
      return res.json({
        description: node.description || '',
        source: node.description ? 'stored' : 'none',
        note: '未配置 AI 模型，无法生成新讲解'
      });
    }

    const detail = nodeDetail(nodeId);
    const relations = detail.edges
      .slice(0, 10)
      .map((e) => `${e.direction === 'out' ? '→' : '←'}[${e.relation}]${e.other?.name || '?'}`)
      .join('；');
    const material = detail.materials?.[0];

    const reply = await chat([
      {
        role: 'system',
        content: `你是耐心的学科辅导助手，为学生讲解知识点。要求：
1. 讲解准确、通俗，100~250 字中文；
2. 涉及公式时使用 LaTeX 语法：数学如 $F=ma$，独立公式用 $$...$$，化学方程式如 $\\ce{2H2 + O2 -> 2H2O}$；
3. 只输出讲解正文，不要输出标题或"讲解："等前缀。`
      },
      {
        role: 'user',
        content: `知识点：${node.name}（科目：${node.subject || '未知'}，分类：${node.category || '概念'}）
${relations ? `关联关系：${relations}` : ''}
${node.description ? `已有简注：${node.description}` : ''}
${material ? `来源材料：《${material.title}》` : ''}`
      }
    ]);
    const explanation = reply.trim();
    if (explanation) {
      db.prepare('UPDATE knowledge_nodes SET description = ? WHERE id = ?').run(explanation, nodeId);
      logger.info(`知识点 ${nodeId}《${node.name}》AI 讲解已生成并存档`);
    }
    res.json({ description: explanation, source: 'ai' });
  } catch (e) {
    next(e);
  }
});

graphRouter.get('/subgraphs', (req, res) => {
  res.json({ items: listSubGraphs() });
});

// ---------- 自由编辑：节点 ----------

graphRouter.post('/nodes', (req, res, next) => {
  try {
    const { name, subject = null, volume = null, category = null, description = null } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: '知识点名称不能为空' });
    const dup = db
      .prepare('SELECT id FROM knowledge_nodes WHERE name = ? AND ifnull(subject, \'\') = ifnull(?, \'\')')
      .get(String(name).trim(), subject || null);
    if (dup) return res.status(409).json({ error: '同科目下已存在同名知识点', id: dup.id });
    const info = db.prepare(
      'INSERT INTO knowledge_nodes (name, subject, volume, category, description, source_material_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(String(name).trim(), subject || null, volume || null, category || null, description || null, null);
    const id = Number(info.lastInsertRowid);
    logger.info(`知识点手动创建: #${id}《${name}》`, { user: req.user.username });
    res.status(201).json(getNodeRow(id));
  } catch (e) {
    next(e);
  }
});

graphRouter.put('/nodes/:id', (req, res, next) => {
  try {
    const node = updateNode(req.params.id, req.body || {});
    logger.info(`知识点编辑: #${node.id}《${node.name}》`, { user: req.user.username });
    res.json(node);
  } catch (e) {
    next(e);
  }
});

graphRouter.delete('/nodes/:id', (req, res, next) => {
  try {
    const r = deleteNode(req.params.id);
    logger.info(`知识点删除: 《${r.name}》`, { user: req.user.username });
    res.json(r);
  } catch (e) {
    next(e);
  }
});

// ---------- 自由编辑：关系（边） ----------

graphRouter.post('/edges', (req, res, next) => {
  try {
    const { sourceId, targetId, relation } = req.body || {};
    const s = getNodeRow(sourceId);
    const t = getNodeRow(targetId);
    if (!s || !t) return res.status(404).json({ error: '起点或终点知识点不存在' });
    if (Number(sourceId) === Number(targetId)) return res.status(400).json({ error: '起点与终点不能相同' });
    const id = addEdge(Number(sourceId), Number(targetId), relation || '相关', null);
    logger.info(`关系手动创建: ${s.name} -[${relation || '相关'}]-> ${t.name}`, { user: req.user.username });
    res.status(201).json({ id });
  } catch (e) {
    next(e);
  }
});

graphRouter.delete('/edges/:id', (req, res, next) => {
  try {
    res.json(deleteEdge(req.params.id));
  } catch (e) {
    next(e);
  }
});

// ---------- 自由编辑：子知识网 ----------

graphRouter.post('/subgraphs', (req, res, next) => {
  try {
    const sg = createSubGraph(req.body || {});
    logger.info(`子知识网创建: 《${sg.name}》`, { user: req.user.username });
    res.status(201).json(sg);
  } catch (e) {
    next(e);
  }
});

graphRouter.put('/subgraphs/:id', (req, res, next) => {
  try {
    res.json(updateSubGraph(req.params.id, req.body || {}));
  } catch (e) {
    next(e);
  }
});

graphRouter.put('/subgraphs/:id/nodes', (req, res, next) => {
  try {
    const nodeIds = updateSubGraphNodes(req.params.id, req.body || {});
    res.json({ ok: true, nodeIds });
  } catch (e) {
    next(e);
  }
});

graphRouter.delete('/subgraphs/:id', (req, res, next) => {
  try {
    res.json(deleteSubGraph(req.params.id));
  } catch (e) {
    next(e);
  }
});
