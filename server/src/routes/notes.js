import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db } from '../db.js';
import { UPLOAD_DIR, IMAGE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { aiEnabled, autoAnalyzeEnabled } from '../ai/client.js';
import { analyzeNote, saveNoteAsMindmap, NOTE_METHODS, noteMethodLabel } from '../services/notes.js';

export const notesRouter = Router();

const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, file, cb) => cb(null, `note-${Date.now()}.png`) }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp)$/.test(name)) cb(null, true);
    else cb(new Error('笔记图片仅支持 png/jpg/gif/webp/bmp'));
  }
});

function tryJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeMethod(v, fallback = 'mindmap') {
  return NOTE_METHODS.includes(v) ? v : fallback;
}

notesRouter.get('/', (req, res) => {
  const { subject, status, method, keyword } = req.query;
  const where = [];
  const params = [];
  if (subject) {
    where.push('subject = ?');
    params.push(subject);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (method) {
    where.push('note_method = ?');
    params.push(method);
  }
  if (keyword) {
    where.push("(ifnull(title,'') LIKE ? OR ifnull(raw_text,'') LIKE ?)");
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const rows = db.prepare(
    `SELECT id, title, subject, source, note_method, status, graph_merged, guide, created_at, updated_at FROM notes
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT 200`
  ).all(...params);
  res.json({
    items: rows.map((r) => ({ ...r, methodLabel: noteMethodLabel(r.note_method) }))
  });
});

notesRouter.get('/methods', (req, res) => {
  res.json({ items: NOTE_METHODS.map((m) => ({ value: m, label: noteMethodLabel(m) })) });
});

notesRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '笔记不存在' });
  let imageDataUrl = null;
  if (row.image_path) {
    try {
      const buf = fs.readFileSync(path.join(IMAGE_DIR, path.basename(path.dirname(row.image_path)), path.basename(row.image_path)));
      imageDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      /* 图片缺失 */
    }
  }
  res.json({ ...row, structure: tryJSON(row.structure), imageDataUrl, methodLabel: noteMethodLabel(row.note_method) });
});

function createNoteRow({ subject, content, source }) {
  const info = db.prepare(
    `INSERT INTO notes (title, subject, source, raw_text, status) VALUES (?, ?, ?, ?, 'pending')`
  ).run(null, subject || null, source, content || '');
  return Number(info.lastInsertRowid);
}

function triggerAnalyze(id, body) {
  const method = normalizeMethod(body?.noteMethod);
  const guide = body?.guide || '';
  const mergeGraph = Boolean(body?.mergeGraph);
  analyzeNote(id, { method, guide, mergeGraph }).catch(() => { /* 失败已落库 status=failed */ });
}

// 自由录入（文本）
notesRouter.post('/', (req, res) => {
  const { title, subject, content, noteMethod, guide, mergeGraph, analyze } = req.body || {};
  if (!content?.trim()) return res.status(400).json({ error: '笔记内容不能为空' });
  const id = createNoteRow({ subject, content: content.trim(), source: 'text' });
  if (title?.trim()) db.prepare('UPDATE notes SET title = ? WHERE id = ?').run(title.trim(), id);
  logger.info(`笔记录入: #${id}（文本）`);
  const wantAnalyze = analyze !== false && aiEnabled();
  if (wantAnalyze) {
    db.prepare('UPDATE notes SET note_method = ?, guide = ? WHERE id = ?').run(normalizeMethod(noteMethod), guide || null, id);
    triggerAnalyze(id, req.body);
    return res.status(202).json({ id, analyzing: true });
  }
  res.status(201).json({ id });
});

// 拍照上传（图片 → 视觉转写 → 结构化）
notesRouter.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未接收到图片' });
  const { subject, noteMethod, guide, mergeGraph } = req.body || {};
  const id = createNoteRow({ subject, content: '', source: 'photo' });
  const dir = path.join(IMAGE_DIR, `n${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'photo.png');
  fs.renameSync(req.file.path, dest);
  db.prepare("UPDATE notes SET image_path = ?, note_method = ?, guide = ? WHERE id = ?")
    .run(`n${id}/photo.png`, normalizeMethod(noteMethod), req.body?.guide || null, id);
  logger.info(`笔记拍照上传: #${id}`);
  if (autoAnalyzeEnabled() && aiEnabled()) {
    triggerAnalyze(id, req.body);
    return res.status(202).json({ id, analyzing: true });
  }
  res.status(201).json({ id });
});

// 重新分析 / 首次分析（可指定笔记方法、引导词、是否并入图谱）
notesRouter.post('/:id/analyze', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const method = normalizeMethod(req.body?.noteMethod);
    const guide = req.body?.guide || '';
    const mergeGraph = Boolean(req.body?.mergeGraph);
    const result = await analyzeNote(id, { method, guide, mergeGraph });
    const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    res.json({ ...row, structure: tryJSON(row.structure), merged: result.merged });
  } catch (e) {
    next(e);
  }
});

notesRouter.post('/:id/mindmap', (req, res, next) => {
  try {
    res.status(201).json(saveNoteAsMindmap(Number(req.params.id)));
  } catch (e) {
    next(e);
  }
});

notesRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '笔记不存在' });
  const { title, subject, rawText } = req.body || {};
  db.prepare(
    `UPDATE notes SET
       title = ifnull(NULLIF(?, ''), title),
       subject = ifnull(NULLIF(?, ''), subject),
       raw_text = ifnull(NULLIF(?, ''), raw_text),
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(title ?? '', subject ?? '', rawText ?? '', id);
  res.json({ ok: true });
});

notesRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT image_path FROM notes WHERE id = ?').get(id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  if (row?.image_path) fs.rmSync(path.join(IMAGE_DIR, `n${id}`), { recursive: true, force: true });
  logger.info(`笔记删除: #${id}`);
  res.json({ ok: true });
});
