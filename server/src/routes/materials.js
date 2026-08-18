import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db } from '../db.js';
import { UPLOAD_DIR, IMAGE_DIR, ROOT_DIR, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { removeVectors } from '../services/vectorStore.js';
import { parseFile, detectKind } from '../services/fileparsers.js';
import { storeMaterialImages } from '../services/imageStore.js';

export const materialsRouter = Router();

const ACCEPT_RE = /\.(txt|md|markdown|csv|json|docx|pdf|png|jpe?g|gif|webp|bmp)$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')}`)
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').toLowerCase();
    if (ACCEPT_RE.test(name)) cb(null, true);
    else cb(new Error('不支持的文件类型，仅支持 .txt / .md / .csv / .json / .docx / .pdf / .png / .jpg / .gif / .webp / .bmp'));
  }
});

function listMaterials({ keyword, status, subject } = {}) {
  const where = [];
  const params = [];
  if (keyword) {
    where.push('(title LIKE ? OR ifnull(summary, \'\') LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (subject) {
    where.push('subject = ?');
    params.push(subject);
  }
  const rows = db.prepare(
    `SELECT m.id, m.title, m.subject, m.volume, m.kind, m.file_name, m.status, m.summary, m.created_at, m.updated_at,
            length(m.content) AS content_length,
            (SELECT COUNT(*) FROM material_images mi WHERE mi.material_id = m.id) AS image_count
     FROM materials m
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY m.id DESC`
  ).all(...params);
  return rows;
}

materialsRouter.get('/', (req, res) => {
  const { keyword, status, subject } = req.query;
  res.json({ items: listMaterials({ keyword, status, subject }) });
});

materialsRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '材料不存在' });
  const chunkCount = db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE material_id = ?').get(id).c;
  const imageCount = db.prepare('SELECT COUNT(*) AS c FROM material_images WHERE material_id = ?').get(id).c;
  res.json({ ...row, meta: tryJSON(row.meta), chunkCount, imageCount });
});

materialsRouter.get('/:id/images', (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare('SELECT * FROM material_images WHERE material_id = ? ORDER BY id').all(id);
  // ?meta=1：仅返回轻量元信息（全部图片，不含 dataUrl），供分页浏览与重分析选择
  if (req.query.meta === '1') {
    const items = rows.map((r) => ({
      id: r.id,
      placeholder: r.placeholder,
      note: r.note,
      description: r.description,
      hasDescription: !!r.description
    }));
    return res.json({ items, total: rows.length });
  }
  const items = rows.slice(0, 30).map((r) => {
    let dataUrl = null;
    try {
      const filePath = r.file_path.startsWith('data/')
        ? path.join(ROOT_DIR, r.file_path)
        : path.join(DATA_DIR, r.file_path);
      const buf = fs.readFileSync(filePath);
      dataUrl = `data:${r.content_type};base64,${buf.toString('base64')}`;
    } catch {
      /* 文件缺失时仅返回元信息 */
    }
    return {
      id: r.id,
      placeholder: r.placeholder,
      contentType: r.content_type,
      note: r.note,
      description: r.description,
      dataUrl
    };
  });
  res.json({ items, total: rows.length });
});

// 按需加载单张图片（含 dataUrl），配合前端"看哪张点哪张"的分页浏览
materialsRouter.get('/:id/images/:imgId', (req, res) => {
  const id = Number(req.params.id);
  const imgId = Number(req.params.imgId);
  const r = db.prepare('SELECT * FROM material_images WHERE id = ? AND material_id = ?').get(imgId, id);
  if (!r) return res.status(404).json({ error: '图片不存在' });
  let dataUrl = null;
  try {
    const filePath = r.file_path.startsWith('data/')
      ? path.join(ROOT_DIR, r.file_path)
      : path.join(DATA_DIR, r.file_path);
    const buf = fs.readFileSync(filePath);
    dataUrl = `data:${r.content_type};base64,${buf.toString('base64')}`;
  } catch {
    /* 文件缺失时仅返回元信息 */
  }
  res.json({
    id: r.id,
    placeholder: r.placeholder,
    contentType: r.content_type,
    note: r.note,
    description: r.description,
    dataUrl
  });
});

materialsRouter.post('/', (req, res) => {
  const { title, content, subject, volume, kind } = req.body || {};
  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: '标题和内容不能为空' });
  }
  const info = db.prepare(
    'INSERT INTO materials (title, content, subject, volume, kind, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title.trim(), String(content), subject || null, volume || null, kind || null, 'pending');
  const id = Number(info.lastInsertRowid);
  logger.info(`材料入库: #${id} ${title.trim()} (${String(content).length} 字)`, { user: req.user.username });
  // 入库后不自动分析：由前端弹窗询问用户是否立即分析（可附引导词）
  res.status(201).json({ id });
});

// 支持一次性上传多份材料（字段名 file 或 files 均可，最多 20 份）；
// 每份文件独立解析入库为一份材料，返回逐份结果；是否分析由前端弹窗确认（可批量分析）
materialsRouter.post('/upload', upload.any(), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: '未接收到文件' });
    const multi = files.length > 1;
    const items = [];
    const errors = [];
    for (const f of files) {
      const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        if (!detectKind(originalName)) throw new Error('不支持的文件类型');
        const parsed = await parseFile(f.path, originalName);
        // 多文件时标题一律取文件名，避免把单份标题张冠李戴
        const title = !multi && req.body?.title?.trim()
          ? req.body.title.trim()
          : path.basename(originalName, path.extname(originalName));
        const info = db.prepare(
          'INSERT INTO materials (title, content, subject, volume, kind, file_name, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(title, parsed.content, req.body?.subject || null, req.body?.volume || null, req.body?.kind || null, originalName, 'pending');
        const id = Number(info.lastInsertRowid);
        const imageCount = storeMaterialImages(id, parsed.images);
        logger.info(`文件上传: #${id} ${originalName} (${parsed.content.length} 字, ${imageCount} 图)`, { user: req.user.username });
        items.push({ id, title, imageCount });
      } catch (e) {
        errors.push({ file: originalName, error: e.message });
        fs.rm(f.path, { force: true }, () => {});
      }
    }
    if (!items.length) {
      return res.status(400).json({ error: errors[0]?.error || '上传失败' });
    }
    // 上传后不自动分析：由前端弹窗询问用户是否立即分析（可附引导词、可勾选参与识别的图片），避免未经确认消耗 token
    res.status(201).json({
      items,
      count: items.length,
      errors,
      // 兼容单文件旧调用
      id: items[0].id,
      imageCount: items[0].imageCount
    });
  } catch (e) {
    next(e);
  }
});

materialsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM materials WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '材料不存在' });
  const chunkIds = db.prepare('SELECT id FROM chunks WHERE material_id = ?').all(id).map((c) => c.id);
  removeVectors(chunkIds);
  db.prepare('DELETE FROM chunks WHERE material_id = ?').run(id);
  db.prepare('DELETE FROM materials WHERE id = ?').run(id);
  fs.rmSync(path.join(IMAGE_DIR, `m${id}`), { recursive: true, force: true });
  logger.info(`材料删除: #${id}`, { user: req.user.username });
  res.json({ ok: true });
});

function tryJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
