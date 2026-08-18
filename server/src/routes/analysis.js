import { Router } from 'express';
import { db } from '../db.js';
import { createJob, runAnalysis, runBatchAnalysis } from '../services/analyzer.js';

export const analysisRouter = Router();

function parseIdArray(arr) {
  return Array.isArray(arr)
    ? arr.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : null;
}

analysisRouter.post('/run', (req, res) => {
  const materialId = Number(req.body?.materialId);
  const guide = req.body?.guide || '';
  // 图片识别控制（默认全部复用已有识别结果以节省 token）：
  // - imageIds: [图片id...] 用户选定"参与识别"的照片（未提供 = 全部参与；未选中且无已有结果的图片将跳过）
  // - reanalyzeImageIds: [图片id...] 仅重新识别指定图片（推荐，避免影响其他正常图片）
  // - reanalyzeImages: true 全部重新识别（兼容旧参数）
  const imageIds = parseIdArray(req.body?.imageIds);
  const reanalyzeImageIds = parseIdArray(req.body?.reanalyzeImageIds);
  const reanalyzeImages = !!req.body?.reanalyzeImages;
  const material = db.prepare('SELECT id, status FROM materials WHERE id = ?').get(materialId);
  if (!material) return res.status(404).json({ error: '材料不存在' });
  if (material.status === 'analyzing') {
    return res.status(409).json({ error: '该材料正在分析中，请稍候' });
  }
  const jobId = createJob(materialId);
  runAnalysis(materialId, jobId, guide, { reanalyzeImages, reanalyzeImageIds, imageIds });
  res.status(202).json({ jobId });
});

// 批量分析：多份材料一次提交，AI 逐份串行处理（分批），全部完成后生成统一汇总
// imageIds 为 { 材料id: [图片id...] }，逐材料选定参与识别的照片
analysisRouter.post('/batch', (req, res) => {
  const materialIds = [...new Set(parseIdArray(req.body?.materialIds) || [])];
  if (!materialIds.length) return res.status(400).json({ error: '未选择要分析的材料' });
  const guide = String(req.body?.guide || '');
  const imageIdsMap = req.body?.imageIds && typeof req.body.imageIds === 'object' ? req.body.imageIds : {};

  for (const id of materialIds) {
    const m = db.prepare('SELECT id, status, title FROM materials WHERE id = ?').get(id);
    if (!m) return res.status(404).json({ error: `材料 #${id} 不存在` });
    if (m.status === 'analyzing') return res.status(409).json({ error: `材料《${m.title}》正在分析中，请稍候` });
  }

  const info = db.prepare('INSERT INTO analysis_batches (status, total, guide) VALUES (?, ?, ?)')
    .run('running', materialIds.length, guide || null);
  const batchId = Number(info.lastInsertRowid);
  const items = [];
  const jobIds = [];
  for (const id of materialIds) {
    const jobId = createJob(id, batchId);
    const raw = imageIdsMap[id] ?? imageIdsMap[String(id)];
    items.push({ materialId: id, jobId, opts: { imageIds: parseIdArray(raw) } });
    jobIds.push(jobId);
  }
  runBatchAnalysis(batchId, items, guide);
  res.status(202).json({ batchId, jobIds });
});

analysisRouter.get('/batches', (req, res) => {
  const items = db.prepare('SELECT * FROM analysis_batches ORDER BY id DESC LIMIT 30').all();
  res.json({ items });
});

analysisRouter.get('/batches/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM analysis_batches WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '批次不存在' });
  const jobs = db.prepare(
    `SELECT j.id, j.material_id, j.status, j.progress, j.step, j.message, m.title AS material_title
     FROM analysis_jobs j JOIN materials m ON m.id = j.material_id
     WHERE j.batch_id = ? ORDER BY j.id`
  ).all(row.id);
  res.json({ ...row, jobs });
});

analysisRouter.get('/jobs', (req, res) => {
  const materialId = req.query.materialId ? Number(req.query.materialId) : null;
  const sql = `SELECT j.*, m.title AS material_title FROM analysis_jobs j
               JOIN materials m ON m.id = j.material_id
               ${materialId ? 'WHERE j.material_id = ?' : ''}
               ORDER BY j.id DESC LIMIT 100`;
  const rows = materialId ? db.prepare(sql).all(materialId) : db.prepare(sql).all();
  res.json({ items: rows });
});

analysisRouter.get('/jobs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '任务不存在' });
  res.json(row);
});
