import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db } from '../db.js';
import { UPLOAD_DIR, IMAGE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { aiEnabled, autoAnalyzeEnabled } from '../ai/client.js';
import { analyzeWrongQuestion } from '../services/wrongAnalyzer.js';
import { listCauseTags, createCauseTag, updateCauseTag, deleteCauseTag, resolveCauseTag } from '../services/causeTags.js';

export const wrongRouter = Router();

const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, file, cb) => cb(null, `wrong-${Date.now()}.png`) }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp)$/.test(name)) cb(null, true);
    else cb(new Error('错题图片仅支持 png/jpg/gif/webp/bmp'));
  }
});

wrongRouter.get('/causes', (req, res) => {
  res.json({ items: listCauseTags() });
});

wrongRouter.post('/causes', (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    res.status(201).json(createCauseTag(name, description, 'user'));
  } catch (e) {
    next(e);
  }
});

wrongRouter.put('/causes/:id', (req, res, next) => {
  try {
    res.json(updateCauseTag(req.params.id, req.body || {}));
  } catch (e) {
    next(e);
  }
});

wrongRouter.delete('/causes/:id', (req, res, next) => {
  try {
    res.json(deleteCauseTag(req.params.id));
  } catch (e) {
    next(e);
  }
});

function listRows({ subject, cause, status, keyword } = {}) {
  const where = [];
  const params = [];
  if (subject) {
    where.push('w.subject = ?');
    params.push(subject);
  }
  if (cause) {
    where.push('w.error_cause = ?');
    params.push(cause);
  }
  if (status) {
    where.push('w.status = ?');
    params.push(status);
  }
  if (keyword) {
    where.push('(w.question LIKE ? OR ifnull(w.analysis, \'\') LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  return db.prepare(
    `SELECT w.*, e.title AS exam_title,
            (SELECT COUNT(*) FROM wrong_question_nodes wn WHERE wn.question_id = w.id) AS node_count
     FROM wrong_questions w LEFT JOIN exams e ON e.id = w.exam_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY w.id DESC LIMIT 300`
  ).all(...params);
}

wrongRouter.get('/', (req, res) => {
  const { subject, cause, status, keyword } = req.query;
  res.json({ items: listRows({ subject, cause, status, keyword }) });
});

wrongRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '错题不存在' });
  const nodes = db.prepare(
    `SELECT n.id, n.name, n.subject, n.category, m.correct, m.wrong
     FROM wrong_question_nodes wn
     JOIN knowledge_nodes n ON n.id = wn.node_id
     LEFT JOIN mastery m ON m.node_id = n.id
     WHERE wn.question_id = ?`
  ).all(id);
  let imageDataUrl = null;
  if (row.image_path) {
    try {
      const buf = fs.readFileSync(path.join(IMAGE_DIR, path.basename(row.image_path)));
      imageDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      /* 图片缺失 */
    }
  }
  res.json({ ...row, nodes, imageDataUrl, knowledgePoints: tryJSON(row.knowledge_points) });
});

wrongRouter.post('/', async (req, res, next) => {
  try {
    const { question, subject, options, correctAnswer, userAnswer, errorCause, causeNote, examId, guide } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: '题干不能为空' });
    if (errorCause?.trim()) resolveCauseTag(errorCause.trim(), causeNote || '');
    const info = db.prepare(
      `INSERT INTO wrong_questions (exam_id, subject, question, options, correct_answer, user_answer, error_cause, cause_note, status, guide)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      examId ? Number(examId) : null,
      subject || null, question.trim(), options || null,
      correctAnswer || null, userAnswer || null, errorCause || null, causeNote || null, guide || null
    );
    const id = Number(info.lastInsertRowid);
    logger.info(`错题入库: #${id}`, { user: req.user.username });
    if (autoAnalyzeEnabled() && aiEnabled()) {
      analyzeWrongQuestion(id, guide || '').catch(() => { /* 已记录日志 */ });
      return res.status(202).json({ id, analyzing: true });
    }
    res.status(201).json({ id });
  } catch (e) {
    next(e);
  }
});

wrongRouter.post('/upload', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未接收到图片' });
    const { subject, question, examId, guide } = req.body || {};
    const info = db.prepare(
      `INSERT INTO wrong_questions (exam_id, subject, question, status) VALUES (?, ?, ?, 'pending')`
    ).run(examId ? Number(examId) : null, subject || null, question?.trim() || '', null);
    const id = Number(info.lastInsertRowid);
    const dir = path.join(IMAGE_DIR, `w${id}`);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'photo.png');
    fs.renameSync(req.file.path, dest);
    db.prepare("UPDATE wrong_questions SET image_path = ? WHERE id = ?").run(`w${id}/photo.png`, id);
    logger.info(`错题拍照录入: #${id}`, { user: req.user.username });
    if (autoAnalyzeEnabled() && aiEnabled()) {
      analyzeWrongQuestion(id, guide || '').catch(() => {});
      return res.status(202).json({ id, analyzing: true });
    }
    res.status(201).json({ id });
  } catch (e) {
    next(e);
  }
});

wrongRouter.post('/:id/analyze', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const guide = req.body?.guide || '';
    await analyzeWrongQuestion(id, guide);
    res.json(await wrongDetail(id));
  } catch (e) {
    next(e);
  }
});

async function wrongDetail(id) {
  return db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(id);
}

wrongRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '错题不存在' });
  const fields = ['question', 'options', 'correct_answer', 'user_answer', 'error_cause', 'cause_note', 'subject', 'analysis'];
  const keyMap = { question: 'question', options: 'options', correctAnswer: 'correct_answer', userAnswer: 'user_answer', errorCause: 'error_cause', causeNote: 'cause_note', subject: 'subject', analysis: 'analysis' };
  const sets = [];
  const params = [];
  for (const [body, col] of Object.entries(keyMap)) {
    if (req.body && body in req.body && fields.includes(col)) {
      sets.push(`${col} = ?`);
      params.push(req.body[body]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: '没有可更新的字段' });
  if (req.body?.errorCause?.trim()) resolveCauseTag(req.body.errorCause.trim(), req.body.causeNote || '');
  db.prepare(`UPDATE wrong_questions SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params, id);
  res.json({ ok: true });
});

wrongRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT image_path FROM wrong_questions WHERE id = ?').get(id);
  db.prepare('DELETE FROM wrong_questions WHERE id = ?').run(id);
  if (row?.image_path) {
    fs.rmSync(path.join(IMAGE_DIR, `w${id}`), { recursive: true, force: true });
  }
  logger.info(`错题删除: #${id}`, { user: req.user.username });
  res.json({ ok: true });
});

function tryJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
