import { Router } from 'express';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { indexSize } from '../services/vectorStore.js';
import { aiEnabled } from '../ai/client.js';

export const monitorRouter = Router();

const startedAt = Date.now();

// 服务器/应用版本（server/package.json）
const serverVersion = (() => {
  try {
    const p = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return p.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
})();

monitorRouter.get('/', (req, res) => {
  const count = (sql) => db.prepare(sql).get().c;
  res.json({
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    hostname: os.hostname(),
    aiEnabled: aiEnabled(),
    // 版本信息（设置 - 账户 - 系统信息）
    osVersion: `${os.type()} ${os.release()}${os.arch ? ` ${os.arch()}` : ''}`,
    serverVersion,
    nodeVersion: process.version,
    counts: {
      materials: count('SELECT COUNT(*) AS c FROM materials'),
      pendingMaterials: count("SELECT COUNT(*) AS c FROM materials WHERE status = 'pending'"),
      nodes: count('SELECT COUNT(*) AS c FROM knowledge_nodes'),
      edges: count('SELECT COUNT(*) AS c FROM knowledge_edges'),
      subGraphs: count('SELECT COUNT(*) AS c FROM sub_graphs'),
      chunks: count('SELECT COUNT(*) AS c FROM chunks'),
      vectors: indexSize(),
      images: count('SELECT COUNT(*) AS c FROM material_images')
    },
    recentJobs: db.prepare(
      `SELECT j.id, j.material_id, j.status, j.progress, j.step, j.message, j.updated_at, m.title
       FROM analysis_jobs j JOIN materials m ON m.id = j.material_id
       ORDER BY j.id DESC LIMIT 5`
    ).all(),
    recentLogs: logger.recent(50)
  });
});
