import { Router } from 'express';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { aiEnabled, chat } from '../ai/client.js';
import { buildReferencesContext } from '../services/qa.js';

export const mindmapsRouter = Router();

function tryJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseTree(raw) {
  const t = typeof raw === 'string' ? tryJSON(raw) : raw;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  if (typeof t.text !== 'string' || !t.text.trim()) return null;
  t.text = t.text.trim().slice(0, 120);
  t.children = normalizeChildren(t.children, 0);
  return t;
}

function normalizeChildren(children, depth) {
  if (!Array.isArray(children) || depth >= 8) return [];
  const out = [];
  for (const c of children.slice(0, 60)) {
    if (!c || typeof c !== 'object') continue;
    const text = String(c.text || '').trim().slice(0, 120);
    if (!text) continue;
    const node = { text };
    if (c.note) node.note = String(c.note).slice(0, 500);
    if (c.ref && typeof c.ref === 'object' && c.ref.type) {
      node.ref = { type: String(c.ref.type), id: c.ref.id ?? null, title: c.ref.title || '' };
    }
    const kids = normalizeChildren(c.children, depth + 1);
    if (kids.length) node.children = kids;
    out.push(node);
  }
  return out;
}

function countNodes(tree) {
  if (!tree || typeof tree !== 'object') return 0;
  return 1 + (tree.children || []).reduce((s, c) => s + countNodes(c), 0);
}

function getRow(id) {
  return db.prepare('SELECT * FROM mindmaps WHERE id = ?').get(Number(id));
}

function toPublic(row) {
  return { ...row, content: tryJSON(row.content) || { text: row.name, children: [] } };
}

export function createMindMap({ name, subject = null, description = '', content = null }) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const tree = content ? parseTree(content) : { text: clean, children: [] };
  if (!tree) return null;
  const info = db.prepare(
    'INSERT INTO mindmaps (name, subject, description, content) VALUES (?, ?, ?, ?)'
  ).run(clean.slice(0, 80), subject || null, String(description || '').slice(0, 300), JSON.stringify(tree));
  return getRow(Number(info.lastInsertRowid));
}

mindmapsRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT id, name, subject, description, created_at, updated_at, content FROM mindmaps ORDER BY updated_at DESC, id DESC LIMIT 200').all();
  res.json({
    items: rows.map((r) => {
      const tree = tryJSON(r.content);
      return { id: r.id, name: r.name, subject: r.subject, description: r.description, created_at: r.created_at, updated_at: r.updated_at, nodeCount: countNodes(tree) };
    })
  });
});

mindmapsRouter.get('/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '脑图不存在' });
  res.json(toPublic(row));
});

mindmapsRouter.post('/', (req, res) => {
  const { name, subject = null, description = '', content = null } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: '脑图名称不能为空' });
  const mm = createMindMap({ name, subject, description, content });
  if (!mm) return res.status(400).json({ error: 'content 格式不正确（需要 {text, children}）' });
  logger.info(`脑图创建: #${mm.id}《${mm.name}》`, { user: req.user.username });
  res.status(201).json(toPublic(mm));
});

mindmapsRouter.put('/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '脑图不存在' });
  const { name, subject, description, content } = req.body || {};
  let contentStr = row.content;
  if (content !== undefined) {
    const tree = parseTree(content);
    if (!tree) return res.status(400).json({ error: 'content 格式不正确（需要 {text, children}）' });
    contentStr = JSON.stringify(tree);
  }
  db.prepare(
    `UPDATE mindmaps SET name = ?, subject = ?, description = ?, content = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    name !== undefined ? (String(name).trim().slice(0, 80) || row.name) : row.name,
    subject !== undefined ? (subject || null) : row.subject,
    description !== undefined ? String(description).slice(0, 300) : row.description,
    contentStr,
    row.id
  );
  res.json(toPublic(getRow(row.id)));
});

mindmapsRouter.delete('/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '脑图不存在' });
  db.prepare('DELETE FROM mindmaps WHERE id = ?').run(row.id);
  logger.info(`脑图删除: 《${row.name}》`, { user: req.user.username });
  res.json({ ok: true });
});

// AI 引导生成脑图结构（不直接落库，返回结构由用户确认后保存/合并）
mindmapsRouter.post('/ai-generate', async (req, res, next) => {
  try {
    const { prompt = '', refs = [] } = req.body || {};
    if (!aiEnabled()) return res.status(400).json({ error: '未配置 AI 模型，无法生成脑图' });
    const refsContext = buildReferencesContext(Array.isArray(refs) ? refs : []);
    const reply = await chat([
      {
        role: 'system',
        content: `你是思维导图设计专家。请根据用户的主题与提供的资料，设计一份结构清晰的脑图（思维导图），只输出 JSON：
{"text":"中心主题(简短)","children":[{"text":"一级分支","children":[{"text":"二级节点","children":[]}]}]}
要求：
1. 一级分支 3~7 个，整体节点不超过 40 个，层级不超过 4 层；
2. 节点文字简洁（2~12 字），知识点准确，不编造；
3. 若引用了材料/知识点，可在相关节点加 "ref":{"type":"material|node|list","id":数字,"title":"名称"}；
4. 公式用 LaTeX（$...$）。不要输出 JSON 以外的内容。`
      },
      {
        role: 'user',
        content: `主题/要求：${String(prompt).slice(0, 500) || '（未提供，请基于引用资料设计）'}${refsContext}`
      }
    ], { temperature: 0.4 });
    let s = String(reply || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    const tree = parseTree(s);
    if (!tree) return res.status(502).json({ error: 'AI 返回的脑图结构无法解析，请重试' });
    res.json({ content: tree });
  } catch (e) {
    next(e);
  }
});
