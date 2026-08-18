import { Router } from 'express';
import { db } from '../db.js';

export const countdownsRouter = Router();

countdownsRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM countdowns ORDER BY target_time ASC').all();
  res.json({
    items: rows.map((r) => ({
      ...r,
      remainingMs: new Date(r.target_time).getTime() - Date.now()
    }))
  });
});

countdownsRouter.post('/', (req, res) => {
  const { title, targetTime } = req.body || {};
  if (!title?.trim() || !targetTime) {
    return res.status(400).json({ error: '标题和目标时间不能为空' });
  }
  if (Number.isNaN(new Date(targetTime).getTime())) {
    return res.status(400).json({ error: '目标时间格式不正确' });
  }
  const info = db.prepare('INSERT INTO countdowns (title, target_time) VALUES (?, ?)')
    .run(title.trim(), new Date(targetTime).toISOString());
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

countdownsRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM countdowns WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
