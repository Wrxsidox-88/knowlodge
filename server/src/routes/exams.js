import { Router } from 'express';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { aiEnabled, chat } from '../ai/client.js';

export const examsRouter = Router();

function listRows(subject) {
  const sql = `SELECT e.*, ev.title AS event_title FROM exams e
     LEFT JOIN exam_events ev ON ev.id = e.exam_event_id
     ${subject ? 'WHERE e.subject = ?' : ''}
     ORDER BY e.exam_date DESC, e.id DESC`;
  return subject ? db.prepare(sql).all(subject) : db.prepare(sql).all();
}

examsRouter.get('/', (req, res) => {
  const { subject } = req.query;
  res.json({ items: listRows(subject) });
});

examsRouter.get('/trend', (req, res) => {
  const { subject, dateFrom, dateTo } = req.query;
  const where = [];
  const args = [];
  if (subject) {
    where.push('subject = ?');
    args.push(subject);
  }
  if (dateFrom) {
    where.push('exam_date >= ?');
    args.push(dateFrom);
  }
  if (dateTo) {
    where.push('exam_date <= ?');
    args.push(dateTo);
  }
  const sql = `SELECT * FROM exams ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY exam_date ASC, id ASC`;
  const rows = db.prepare(sql).all(...args);
  res.json({
    items: rows.map((r) => ({
      ...r,
      pct: r.total_score ? Math.round((r.score / r.total_score) * 1000) / 10 : 0
    }))
  });
});

examsRouter.get('/events', (req, res) => {
  const rows = db.prepare(
    `SELECT ev.*,
            COUNT(e.id) AS subject_count,
            ifnull(SUM(e.total_score), 0) AS total_score,
            ifnull(SUM(e.score), 0) AS score
     FROM exam_events ev LEFT JOIN exams e ON e.exam_event_id = ev.id
     GROUP BY ev.id ORDER BY ev.exam_date DESC, ev.id DESC`
  ).all();
  res.json({
    items: rows.map((r) => ({ ...r, pct: r.total_score ? Math.round((r.score / r.total_score) * 1000) / 10 : 0 }))
  });
});

examsRouter.get('/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ev = db.prepare('SELECT * FROM exam_events WHERE id = ?').get(id);
    if (!ev) return res.status(404).json({ error: '考试事件不存在' });
    const subjects = db.prepare(
      'SELECT * FROM exams WHERE exam_event_id = ? ORDER BY score / CAST(total_score AS REAL) DESC'
    ).all(id).map((r) => ({ ...r, pct: r.total_score ? Math.round((r.score / r.total_score) * 1000) / 10 : 0 }));
    const totalScore = subjects.reduce((a, b) => a + b.total_score, 0);
    const totalGot = subjects.reduce((a, b) => a + b.score, 0);
    const examIds = subjects.map((s) => s.id);
    let wrongStats = [];
    let weakSubjects = [];
    if (examIds.length) {
      const ph = examIds.map(() => '?').join(',');
      wrongStats = db.prepare(
        `SELECT ifnull(e.subject, '未分类') AS subject, ifnull(w.error_cause, '未标注') AS cause, COUNT(*) AS count
         FROM wrong_questions w JOIN exams e ON e.id = w.exam_id
         WHERE w.exam_id IN (${ph}) GROUP BY e.subject, w.error_cause ORDER BY count DESC`
      ).all(...examIds);
      weakSubjects = db.prepare(
        `SELECT n.subject, n.name, m.correct, m.wrong FROM mastery m
         JOIN knowledge_nodes n ON n.id = m.node_id
         JOIN wrong_question_nodes wn ON wn.node_id = n.id
         JOIN wrong_questions w ON w.id = wn.question_id
         WHERE w.exam_id IN (${ph}) AND m.wrong > 0
         GROUP BY n.id ORDER BY m.wrong DESC LIMIT 8`
      ).all(...examIds);
    }
    const summary = await eventSummary(ev, subjects, { totalScore, totalGot, wrongStats });
    res.json({
      event: ev,
      subjects,
      totalScore,
      totalGot,
      pct: totalScore ? Math.round((totalGot / totalScore) * 1000) / 10 : 0,
      wrongStats,
      weakPoints: weakSubjects,
      summary
    });
  } catch (e) {
    next(e);
  }
});

async function eventSummary(ev, subjects, agg) {
  const stat = {
    event: ev.title,
    date: ev.exam_date,
    totalScore: agg.totalScore,
    totalGot: agg.totalGot,
    pct: agg.totalScore ? Math.round((agg.totalGot / agg.totalScore) * 1000) / 10 : 0,
    subjects: subjects.map((s) => `${s.subject} ${s.score}/${s.total_score}(${s.pct}%)`),
    wrongStats: agg.wrongStats.slice(0, 8).map((w) => `${w.subject}/${w.cause}×${w.count}`)
  };
  if (aiEnabled() && subjects.length) {
    try {
      const reply = await chat([
        {
          role: 'system',
          content: '你是学情分析师。针对一次包含多科目的大型考试写总体分析（Markdown，250 字内）：总体水平评价、优势科目、薄弱科目、下一步备考建议。基于数据，不编造。'
        },
        { role: 'user', content: `考试数据：${JSON.stringify(stat)}` }
      ]);
      return { text: reply.trim(), source: 'ai' };
    } catch (e) {
      logger.warn(`考试总分析 AI 生成失败: ${e.message}`);
    }
  }
  if (!subjects.length) return { text: '该考试事件下尚无科目成绩。', source: 'offline' };
  const sorted = [...subjects].sort((a, b) => b.pct - a.pct);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  return {
    text: `本次「${ev.title}」共 ${subjects.length} 科，总分 ${agg.totalGot}/${agg.totalScore}（${stat.pct}%）。优势科目：**${best.subject}**（${best.pct}%）；相对薄弱：**${worst.subject}**（${worst.pct}%）。建议优先复盘薄弱科目的错题，并在练习中心针对相关考点做变式训练。`,
    source: 'offline'
  };
}

function findOrCreateEvent(title, date) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  const existing = db.prepare('SELECT * FROM exam_events WHERE title = ?').get(clean);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO exam_events (title, exam_date) VALUES (?, ?)').run(clean, date || null);
  return db.prepare('SELECT * FROM exam_events WHERE id = ?').get(Number(info.lastInsertRowid));
}

examsRouter.post('/', (req, res) => {
  const { subject, title, examDate, totalScore, score, note, gradeRank, classRank, examEventId, examEventTitle } = req.body || {};
  if (!subject?.trim() || !examDate || totalScore == null || score == null) {
    return res.status(400).json({ error: '科目、日期、满分、得分不能为空' });
  }
  if (Number(score) > Number(totalScore)) {
    return res.status(400).json({ error: '得分不能大于满分' });
  }
  const gr = gradeRank != null && gradeRank !== '' ? Number(gradeRank) : null;
  const cr = classRank != null && classRank !== '' ? Number(classRank) : null;
  if ((gr != null && (!Number.isFinite(gr) || gr <= 0)) || (cr != null && (!Number.isFinite(cr) || cr <= 0))) {
    return res.status(400).json({ error: '排名须为正整数' });
  }
  const dup = db.prepare(
    'SELECT id FROM exams WHERE subject = ? AND exam_date = ? AND total_score = ? AND score = ? AND ifnull(title, \'\') = ?'
  ).get(subject.trim(), examDate, Number(totalScore), Number(score), title?.trim() || '');
  if (dup) {
    return res.status(409).json({ error: `已存在相同的考试记录（#${dup.id}），拒绝重复录入` });
  }
  let eventId = examEventId ? Number(examEventId) : null;
  if (!eventId && examEventTitle?.trim()) {
    eventId = findOrCreateEvent(examEventTitle, examDate)?.id ?? null;
  }
  const info = db.prepare(
    'INSERT INTO exams (subject, title, exam_date, total_score, score, grade_rank, class_rank, note, exam_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(subject.trim(), title?.trim() || null, examDate, Number(totalScore), Number(score), gr, cr, note || null, eventId);
  const id = Number(info.lastInsertRowid);
  logger.info(`考试记录入库: #${id} ${subject} ${score}/${totalScore}${eventId ? `（事件#${eventId}）` : ''}`, { user: req.user.username });
  res.status(201).json({ id, eventId });
});

examsRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '考试记录不存在' });
  const { subject, title, examDate, totalScore, score, note, gradeRank, classRank, examEventId, examEventTitle } = req.body || {};
  let eventId = row.exam_event_id;
  if (examEventId !== undefined) eventId = examEventId ? Number(examEventId) : null;
  if (!eventId && examEventTitle?.trim()) {
    eventId = findOrCreateEvent(examEventTitle, examDate || row.exam_date)?.id ?? null;
  }
  let gr = row.grade_rank;
  if (gradeRank !== undefined) gr = gradeRank !== '' && gradeRank != null ? Number(gradeRank) : null;
  let cr = row.class_rank;
  if (classRank !== undefined) cr = classRank !== '' && classRank != null ? Number(classRank) : null;
  if ((gr != null && (!Number.isFinite(gr) || gr <= 0)) || (cr != null && (!Number.isFinite(cr) || cr <= 0))) {
    return res.status(400).json({ error: '排名须为正整数' });
  }
  db.prepare(
    `UPDATE exams SET subject = ?, title = ?, exam_date = ?, total_score = ?, score = ?, grade_rank = ?, class_rank = ?, note = ?, exam_event_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    subject?.trim() || row.subject,
    title !== undefined ? title?.trim() || null : row.title,
    examDate || row.exam_date,
    totalScore != null ? Number(totalScore) : row.total_score,
    score != null ? Number(score) : row.score,
    gr,
    cr,
    note !== undefined ? note || null : row.note,
    eventId,
    id
  );
  res.json({ ok: true });
});

examsRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE wrong_questions SET exam_id = NULL WHERE exam_id = ?').run(id);
  db.prepare('DELETE FROM exams WHERE id = ?').run(id);
  logger.info(`考试记录删除: #${id}`, { user: req.user.username });
  res.json({ ok: true });
});
