import { Router } from 'express';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { answerQuestion, answerQuestionStream } from '../services/qa.js';
import { generateDocument } from './documents.js';
import { createJob, runAnalysis } from '../services/analyzer.js';
import { aiEnabled } from '../ai/client.js';
import { createMindMap } from './mindmaps.js';

export const chatRouter = Router();

chatRouter.get('/conversations', (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c ORDER BY c.updated_at DESC, c.id DESC LIMIT 100`
  ).all();
  res.json({ items: rows });
});

chatRouter.post('/conversations', (req, res) => {
  const title = req.body?.title?.trim() || '新的对话';
  const info = db.prepare('INSERT INTO conversations (title) VALUES (?)').run(title.slice(0, 60));
  const id = Number(info.lastInsertRowid);
  res.status(201).json({ id, title });
});

chatRouter.put('/conversations/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '对话不存在' });
  const title = req.body?.title?.trim();
  if (!title) return res.status(400).json({ error: '标题不能为空' });
  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title.slice(0, 60), id);
  res.json({ ok: true });
});

chatRouter.delete('/conversations/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  logger.info(`对话删除: #${id}`, { user: req.user.username });
  res.json({ ok: true });
});

chatRouter.get('/conversations/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conv) return res.status(404).json({ error: '对话不存在' });
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(id);
  res.json({
    conversation: conv,
    items: rows.map((m) => ({ id: m.id, role: m.role, content: m.content, meta: tryJSON(m.meta), created_at: m.created_at }))
  });
});

function buildHistory(convId) {
  const histRows = db.prepare(
    "SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 8"
  ).all(convId).reverse();
  return histRows
    .map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.content };
      const parsed = tryJSON(m.content);
      return { role: 'assistant', content: parsed?.answer || m.content };
    })
    .map((m) => ({ ...m, content: String(m.content).slice(0, 2500) }));
}

function persistMessages(convId, conv, question, result) {
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(convId, 'user', question.trim());
  const info = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(convId, 'assistant', JSON.stringify(result));
  const assistantId = Number(info.lastInsertRowid);
  const count = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND role = ?').get(convId, 'user').c;
  if (count === 1 && (conv.title === '新的对话' || !conv.title.trim())) {
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(question.trim().slice(0, 24), convId);
  }
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(convId);
  return assistantId;
}

chatRouter.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conv) return res.status(404).json({ error: '对话不存在' });
    const question = req.body?.question;
    if (!question?.trim()) return res.status(400).json({ error: '问题不能为空' });

    const history = buildHistory(id);
    const model = req.body?.model || null;
    const references = Array.isArray(req.body?.references) ? req.body.references : null;

    // ---------- 流式（SSE）----------
    if (req.body?.stream === true) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const send = (obj) => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };

      const controller = new AbortController();
      let closed = false;
      // 注意：必须监听 res 的 close（req 的 close 在请求体读完后即触发，会误中止流）
      res.on('close', () => {
        closed = true;
        controller.abort(new Error('客户端断开'));
      });

      try {
        const result = await answerQuestionStream(question, req.user?.id ?? null, {
          history,
          conversationId: id,
          model,
          references,
          signal: controller.signal,
          onMeta: (meta) => send({ type: 'meta', ...meta }),
          onToken: (delta, full) => {
            if (!closed) send({ type: 'token', delta, full });
          }
        });
        if (closed) return;
        const messageId = persistMessages(id, conv, question, result);
        send({ type: 'done', messageId, result });
      } catch (e) {
        if (!closed) send({ type: 'error', message: e.message || '回答失败' });
      } finally {
        res.end();
      }
      return;
    }

    // ---------- 非流式（兼容旧调用）----------
    const result = await answerQuestion(question, req.user?.id ?? null, {
      history,
      conversationId: id,
      model,
      references
    });
    const messageId = persistMessages(id, conv, question, result);
    res.json({ conversationId: id, messageId, result });
  } catch (e) {
    next(e);
  }
});

// 记录一条系统说明消息（如工具执行回执）
chatRouter.post('/conversations/:id/note', (req, res) => {
  const id = Number(req.params.id);
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
  if (!conv) return res.status(404).json({ error: '对话不存在' });
  const content = String(req.body?.content || '').slice(0, 2000);
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(id, 'note', content);
  res.json({ ok: true });
});

// 持久化 AI 工具调用的授权/执行状态（切换页面后不丢失）
chatRouter.post('/messages/:id/tool-state', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id, meta FROM messages WHERE id = ? AND role = ?').get(id, 'assistant');
  if (!row) return res.status(404).json({ error: '消息不存在' });
  const { index, status, result = null } = req.body || {};
  if (!Number.isInteger(index) || !['pending', 'done', 'rejected', 'error'].includes(status)) {
    return res.status(400).json({ error: '参数不正确' });
  }
  const meta = tryJSON(row.meta) || {};
  if (!meta.toolCalls || typeof meta.toolCalls !== 'object') meta.toolCalls = {};
  meta.toolCalls[index] = {
    status,
    result: result ? { message: result.message || '', downloadUrl: result.downloadUrl || null, id: result.id ?? null } : null,
    at: new Date().toISOString()
  };
  db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  res.json({ ok: true });
});

// 用户授权后执行 AI 提出的工具调用
chatRouter.post('/tools/execute', async (req, res, next) => {
  try {
    const { tool, args = {} } = req.body || {};
    if (!tool) return res.status(400).json({ error: '缺少 tool' });
    logger.info(`工具执行: ${tool}`, { user: req.user.username, args: JSON.stringify(args).slice(0, 300) });
    switch (tool) {
      case 'generate_document': {
        const doc = await generateDocument({ name: args.name, blocks: args.blocks, source: 'AI 生成（用户授权）' });
        return res.json({ ok: true, tool, result: doc, message: `已生成 Word 文档《${doc.fileName}》` });
      }
      case 'reanalyze_material': {
        const materialId = Number(args.materialId);
        const m = db.prepare('SELECT id, status FROM materials WHERE id = ?').get(materialId);
        if (!m) return res.status(404).json({ error: `材料 #${materialId} 不存在` });
        if (m.status === 'analyzing') return res.status(409).json({ error: '该材料正在分析中' });
        const jobId = createJob(materialId);
        runAnalysis(materialId, jobId, String(args.guide || ''), {
          reanalyzeImages: !!args.reanalyzeImages,
          reanalyzeImageIds: Array.isArray(args.reanalyzeImageIds) ? args.reanalyzeImageIds : null,
          imageIds: Array.isArray(args.imageIds) ? args.imageIds : null
        });
        return res.json({ ok: true, tool, result: { jobId, materialId }, message: `已开始重新分析材料 #${materialId}` });
      }
      case 'countdown_add': {
        if (!args.title?.trim() || !args.targetTime) return res.status(400).json({ error: '倒计时需要 title 与 targetTime' });
        if (Number.isNaN(new Date(args.targetTime).getTime())) return res.status(400).json({ error: 'targetTime 格式不正确' });
        const info = db.prepare('INSERT INTO countdowns (title, target_time) VALUES (?, ?)').run(String(args.title).trim(), new Date(args.targetTime).toISOString());
        return res.json({ ok: true, tool, result: { id: Number(info.lastInsertRowid) }, message: `已创建倒计时「${args.title}」` });
      }
      case 'countdown_delete': {
        const cd = db.prepare('SELECT id, title FROM countdowns WHERE id = ?').get(Number(args.id));
        if (!cd) return res.status(404).json({ error: `倒计时 #${args.id} 不存在` });
        db.prepare('DELETE FROM countdowns WHERE id = ?').run(cd.id);
        return res.json({ ok: true, tool, message: `已删除倒计时「${cd.title}」` });
      }
      case 'list_create': {
        if (!args.name?.trim()) return res.status(400).json({ error: '清单需要 name' });
        const parentId = args.parentId ? Number(args.parentId) : null;
        if (parentId && !db.prepare('SELECT id FROM knowledge_lists WHERE id = ?').get(parentId)) {
          return res.status(400).json({ error: '上级目录不存在' });
        }
        // 工具调用必经用户明确授权，因此直接创建；AI 创建的清单默认允许 AI 继续编辑
        try {
          const info = db.prepare(
            'INSERT INTO knowledge_lists (parent_id, kind, name, description, content, ai_editable) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(parentId, args.kind === 'folder' ? 'folder' : 'note', String(args.name).trim().slice(0, 80), args.description || '', args.content || '', args.aiEditable === false ? 0 : 1);
          const id = Number(info.lastInsertRowid);
          return res.json({ ok: true, tool, result: { id }, message: `已创建知识清单《${args.name}》` });
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '同级下已存在同名清单' });
          throw e;
        }
      }
      case 'list_edit': {
        const row = db.prepare('SELECT * FROM knowledge_lists WHERE id = ?').get(Number(args.id));
        if (!row) return res.status(404).json({ error: `知识清单 #${args.id} 不存在` });
        if (!row.ai_editable) return res.status(403).json({ error: '该清单未开启"允许 AI 编辑"，已被拒绝' });
        if (typeof args.content !== 'string') return res.status(400).json({ error: '缺少 content' });
        const next = args.mode === 'replace' ? args.content : `${row.content || ''}\n\n${args.content}`;
        db.prepare("UPDATE knowledge_lists SET content = ?, updated_at = datetime('now') WHERE id = ?").run(next, row.id);
        return res.json({ ok: true, tool, result: { id: row.id }, message: `已更新知识清单《${row.name}》` });
      }
      case 'mindmap_create': {
        if (!args.name?.trim()) return res.status(400).json({ error: '脑图需要 name' });
        if (!aiEnabled() && !args.content) return res.status(400).json({ error: '未配置 AI 且缺少 content' });
        const mm = createMindMap({
          name: args.name,
          subject: args.subject || null,
          description: args.description || 'AI 创建（用户授权）',
          content: args.content || null
        });
        if (!mm) return res.status(400).json({ error: '脑图 content 格式不正确' });
        return res.json({ ok: true, tool, result: { id: mm.id }, message: `已创建脑图《${mm.name}》` });
      }
      default:
        return res.status(400).json({ error: `不支持的工具: ${tool}` });
    }
  } catch (e) {
    next(e);
  }
});

function tryJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
