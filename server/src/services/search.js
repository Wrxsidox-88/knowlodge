import { db } from '../db.js';
import { aiEnabled, embedText } from '../ai/client.js';
import { topK, indexSize } from './vectorStore.js';
import { tokenizeQuery } from './textutil.js';

export async function semanticSearch(query, { topN = 8, materialId = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  let rows = [];
  if (aiEnabled() && indexSize() > 0) {
    try {
      const vec = await embedText(q);
      if (vec) {
        const hits = topK(vec, topN, materialId);
        const ph = hits.map(() => '?').join(',');
        const chunks = hits.length
          ? db.prepare(
            `SELECT c.*, m.title AS material_title, m.subject, m.kind, n.name AS node_name
             FROM chunks c
             JOIN materials m ON m.id = c.material_id
             LEFT JOIN knowledge_nodes n ON n.id = c.node_id
             WHERE c.id IN (${ph})`
          ).all(...hits.map((h) => h.chunkId))
          : [];
        const byId = new Map(chunks.map((c) => [c.id, c]));
        rows = hits
          .filter((h) => byId.has(h.chunkId))
          .map((h) => ({ ...byId.get(h.chunkId), score: h.score }))
          .filter((r) => !materialId || r.material_id === materialId);
      }
    } catch {
      rows = [];
    }
  }

  if (!rows.length) {
    rows = keywordSearch(q, topN, materialId);
  }
  return rows;
}

function keywordSearch(q, topN, materialId) {
  const terms = tokenizeQuery(q);
  if (!terms.length) return [];
  const where = terms.map(() => '(c.text LIKE ? OR c.title LIKE ?)').join(' OR ');
  const params = [];
  for (const t of terms) params.push(`%${t}%`, `%${t}%`);
  let sql = `SELECT c.*, m.title AS material_title, m.subject, m.kind, n.name AS node_name
             FROM chunks c
             JOIN materials m ON m.id = c.material_id
             LEFT JOIN knowledge_nodes n ON n.id = c.node_id
             WHERE ${where}`;
  if (materialId) {
    sql += ' AND c.material_id = ?';
    params.push(materialId);
  }
  sql += ' LIMIT ?';
  params.push(topN * 2);
  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => {
    const text = r.text + ' ' + (r.title || '');
    const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 / terms.length : 0), 0);
    return { ...r, score: Math.min(score, 1) };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
