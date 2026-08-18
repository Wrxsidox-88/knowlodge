import { Router } from 'express';
import { semanticSearch } from '../services/search.js';

export const searchRouter = Router();

searchRouter.post('/', async (req, res, next) => {
  try {
    const { query, topK, materialId } = req.body || {};
    if (!query?.trim()) return res.status(400).json({ error: '检索内容不能为空' });
    const hits = await semanticSearch(query, {
      topN: Math.min(Number(topK) || 8, 20),
      materialId: materialId ? Number(materialId) : null
    });
    const result = {
      query,
      items: hits.map((h) => ({
        chunkId: h.id,
        title: h.title,
        text: h.text,
        score: h.score,
        materialId: h.material_id,
        materialTitle: h.material_title,
        subject: h.subject,
        kind: h.kind,
        nodeName: h.node_name
      }))
    };
    res.json(result);
  } catch (e) {
    next(e);
  }
});
