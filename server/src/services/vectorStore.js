import { db } from '../db.js';
import { logger } from '../logger.js';

const index = new Map();

function toF64(arr) {
  return Float64Array.from(arr);
}

export function loadIndex() {
  index.clear();
  const rows = db.prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL').all();
  for (const row of rows) {
    try {
      index.set(row.id, toF64(JSON.parse(row.embedding)));
    } catch {
      /* 跳过损坏的向量 */
    }
  }
  logger.info(`向量索引加载完成，共 ${index.size} 条`);
}

export function upsertVector(chunkId, vector) {
  if (Array.isArray(vector) && vector.length > 0) {
    index.set(chunkId, toF64(vector));
  }
}

export function removeVectors(chunkIds) {
  for (const id of chunkIds) index.delete(id);
}

export function indexSize() {
  return index.size;
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function topK(queryVec, k = 8, materialFilter = null) {
  const q = toF64(queryVec);
  const scores = [];
  for (const [chunkId, vec] of index) {
    if (vec.length !== q.length) continue;
    scores.push({ chunkId, score: cosine(q, vec) });
  }
  scores.sort((a, b) => b.score - a.score);
  const top = scores.slice(0, k * 3);
  if (!materialFilter) return top.slice(0, k);
  const stmt = db.prepare('SELECT material_id FROM chunks WHERE id = ?');
  return top.filter((s) => stmt.get(s.chunkId)?.material_id === materialFilter).slice(0, k);
}
