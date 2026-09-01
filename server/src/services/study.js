import { db } from '../db.js';
import { logger } from '../logger.js';
import { aiEnabled, chat } from '../ai/client.js';
import { getTargets } from './targets.js';

export const ERROR_CAUSES = ['知识盲区', '逻辑错误', '概念混淆', '粗心', '方法错误', '其他'];
export const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30];

export function masteryScore(m) {
  if (!m) return 60;
  const total = m.correct + m.wrong;
  const base = total === 0 ? 60 : (100 * m.correct) / total;
  let factor = 1;
  const ref = m.last_review_at || null;
  if (ref) {
    const days = (Date.now() - Date.parse(ref.replace(' ', 'T') + 'Z')) / 86400000;
    factor = 0.5 + 0.5 * Math.exp(-Math.max(0, days) / 14);
  }
  return Math.min(100, Math.round(base * factor));
}

export function registerWrongOnNodes(nodeIds) {
  const stmt = db.prepare(
    `INSERT INTO mastery (node_id, wrong, next_review_at) VALUES (?, 1, date('now', '+1 day'))
     ON CONFLICT(node_id) DO UPDATE SET
       wrong = wrong + 1,
       next_review_at = ifnull(next_review_at, date('now', '+1 day'))`
  );
  for (const id of nodeIds) stmt.run(id);
}

export function recordPracticeResult(nodeId, isCorrect) {
  if (!nodeId) return;
  const field = isCorrect ? 'correct' : 'wrong';
  db.prepare(
    `INSERT INTO mastery (node_id, ${field}) VALUES (?, 1)
     ON CONFLICT(node_id) DO UPDATE SET ${field} = ${field} + 1`
  ).run(nodeId);
}

export function completeReview(nodeId) {
  const m = db.prepare('SELECT * FROM mastery WHERE node_id = ?').get(nodeId);
  if (!m) return null;
  const stage = Math.min(m.stage + 1, EBBINGHAUS_INTERVALS.length - 1);
  const interval = EBBINGHAUS_INTERVALS[stage];
  db.prepare(
    `UPDATE mastery SET stage = ?, last_review_at = datetime('now'), next_review_at = date('now', '+' || ? || ' day') WHERE node_id = ?`
  ).run(stage, interval, nodeId);
  return db.prepare('SELECT * FROM mastery WHERE node_id = ?').get(nodeId);
}

function dueReviews(limit = 30) {
  return db.prepare(
    `SELECT m.*, n.name, n.subject, n.category FROM mastery m
     JOIN knowledge_nodes n ON n.id = m.node_id
     WHERE m.wrong > 0 AND m.next_review_at IS NOT NULL AND date(m.next_review_at) <= date('now')
     ORDER BY date(m.next_review_at) ASC, m.wrong DESC
     LIMIT ?`
  ).all(limit);
}

function weakNodes({ subject = null, limit = 15 } = {}) {
  const where = subject ? 'AND n.subject = ?' : '';
  const rows = db.prepare(
    `SELECT n.id, n.name, n.subject, n.category, m.correct, m.wrong, m.stage, m.next_review_at
     FROM mastery m JOIN knowledge_nodes n ON n.id = m.node_id
     WHERE m.wrong > 0 ${where}
     ORDER BY m.wrong DESC
     LIMIT ?`
  ).all(...(subject ? [subject] : []), limit * 3);
  const list = rows.map((r) => ({ ...r, mastery: masteryScore(r) }));
  list.sort((a, b) => a.mastery - b.mastery);
  return list.slice(0, limit);
}

export function overview({ subject = null, dateFrom = null, dateTo = null } = {}) {
  const subjects = db.prepare(
    "SELECT DISTINCT subject FROM knowledge_nodes WHERE subject IS NOT NULL AND subject != '' ORDER BY subject"
  ).all().map((r) => r.subject);

  const weak = weakNodes({ subject, limit: 10 });
  const radar = {
    indicators: weak.map((n) => n.name),
    values: weak.map((n) => n.mastery)
  };

  const subjectMastery = db.prepare(
    `SELECT n.subject, m.correct, m.wrong, m.stage, m.last_review_at FROM mastery m
     JOIN knowledge_nodes n ON n.id = m.node_id WHERE n.subject IS NOT NULL`
  ).all();
  const bySubject = new Map();
  for (const r of subjectMastery) {
    if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
    bySubject.get(r.subject).push(masteryScore(r));
  }
  const subjectAverages = [...bySubject.entries()].map(([s, scores]) => ({
    subject: s,
    mastery: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    nodes: scores.length
  }));

  const causeRows = db.prepare(
    `SELECT ifnull(error_cause, '未标注') AS cause, COUNT(*) AS count FROM wrong_questions GROUP BY cause ORDER BY count DESC`
  ).all();

  // 成绩趋势：支持时间窗口筛选（dateFrom/dateTo，含两端）
  const trendWhere = [];
  const trendArgs = [];
  if (dateFrom) {
    trendWhere.push('exam_date >= ?');
    trendArgs.push(dateFrom);
  }
  if (dateTo) {
    trendWhere.push('exam_date <= ?');
    trendArgs.push(dateTo);
  }
  const trend = db.prepare(
    `SELECT id, subject, title, exam_date, total_score, score, grade_rank, class_rank FROM exams
     ${trendWhere.length ? 'WHERE ' + trendWhere.join(' AND ') : ''}
     ORDER BY exam_date ASC, id ASC LIMIT 500`
  ).all(...trendArgs);

  const wrongTotal = db.prepare('SELECT COUNT(*) AS c FROM wrong_questions').get().c;
  const practiceRows = db.prepare('SELECT COUNT(*) AS total, ifnull(SUM(is_correct = 1), 0) AS correct FROM practices WHERE status != \'open\'').get();

  return {
    subjects,
    radar,
    weakNodes: weak,
    subjectAverages,
    causeDistribution: causeRows,
    trend: trend.map((t) => ({ ...t, pct: t.total_score ? Math.round((t.score / t.total_score) * 1000) / 10 : 0 })),
    targets: getTargets(),
    reviewDue: dueReviews(20).map((r) => ({ ...r, mastery: masteryScore(r) })),
    reviewDueCount: db.prepare(
      "SELECT COUNT(*) AS c FROM mastery WHERE wrong > 0 AND next_review_at IS NOT NULL AND date(next_review_at) <= date('now')"
    ).get().c,
    wrongTotal,
    practiceStats: {
      total: practiceRows.total,
      correct: practiceRows.correct,
      rate: practiceRows.total ? Math.round((practiceRows.correct / practiceRows.total) * 100) : null
    }
  };
}

export function report() {
  const base = overview({});
  const wrongBySubject = db.prepare(
    `SELECT ifnull(subject, '未分类') AS subject, ifnull(error_cause, '未标注') AS cause, COUNT(*) AS count
     FROM wrong_questions GROUP BY subject, cause ORDER BY count DESC`
  ).all();
  const reviewDone = db.prepare('SELECT COUNT(*) AS c FROM mastery WHERE last_review_at IS NOT NULL').get().c;
  const stats = {
    wrongTotal: base.wrongTotal,
    practiceStats: base.practiceStats,
    reviewDueCount: base.reviewDueCount,
    reviewDone,
    subjectAverages: base.subjectAverages,
    causeDistribution: base.causeDistribution,
    weakNodes: base.weakNodes.slice(0, 8).map((n) => `${n.name}(掌握度${n.mastery}%)`)
  };
  return { ...base, wrongBySubject, reviewDone, stats };
}

export async function reportSummary(guide = '') {
  const data = report();
  if (!aiEnabled()) {
    return { summary: null, note: '未配置 AI 模型，仅展示统计数据' };
  }
  const reply = await chat([
    {
      role: 'system',
      content: '你是学情分析师。根据统计数据输出简洁明的学情报告（Markdown，300 字内）：整体评价、最薄弱的知识点与成因、下一步提升建议。不要编造数据中没有的内容。'
    },
    {
      role: 'user',
      content: `学情统计数据：\n${JSON.stringify(data.stats, null, 2)}${guide ? `\n\n用户关注点：${guide}` : ''}`
    }
  ]);
  return { summary: reply.trim() };
}

export function weakCandidates(limit = 10) {
  return weakNodes({ limit });
}

const ENCOURAGE_TTL_MS = 3600 * 1000;

async function generateEncourage() {
  const data = overview({});
  if (aiEnabled()) {
    try {
      const stats = {
        wrongTotal: data.wrongTotal,
        practiceRate: data.practiceStats.rate,
        reviewDueCount: data.reviewDueCount,
        weakTop: data.weakNodes.slice(0, 3).map((n) => `${n.name}(掌握度${n.mastery}%)`),
        subjectAverages: data.subjectAverages.map((s) => `${s.subject}${s.mastery}%`),
        recentExams: data.trend.slice(-2).map((t) => `${t.subject}${t.score}/${t.total_score}`)
      };
      const reply = await chat([
        {
          role: 'system',
          content: '你是温暖耐心的学习教练。根据学生学情数据写一句鼓励（60~100 字，中文）：要具体（可提到知识点名或进步），语气真诚有力量，不要空喊口号，不要使用表情符号。只输出鼓励语。'
        },
        { role: 'user', content: `学情数据：${JSON.stringify(stats)}` }
      ], { temperature: 0.8 });
      const text = reply.trim();
      if (text) return { text, source: 'ai' };
    } catch (e) {
      logger.warn(`AI 鼓励生成失败，降级模板: ${e.message}`);
    }
  }
  return { text: templateEncourage(data), source: 'offline' };
}

export async function getEncourage() {
  const latest = db.prepare('SELECT * FROM study_encourage ORDER BY id DESC LIMIT 1').get();
  if (latest) {
    const age = Date.now() - Date.parse(latest.created_at.replace(' ', 'T') + 'Z');
    if (age >= 0 && age < ENCOURAGE_TTL_MS) {
      return { text: latest.text, source: latest.source, createdAt: latest.created_at, cached: true };
    }
  }
  return refreshEncourage();
}

export async function refreshEncourage() {
  const g = await generateEncourage();
  db.prepare('INSERT INTO study_encourage (text, source) VALUES (?, ?)').run(g.text, g.source);
  db.prepare('DELETE FROM study_encourage WHERE id NOT IN (SELECT id FROM study_encourage ORDER BY id DESC LIMIT 20)').run();
  return { ...g, cached: false };
}

export function encourageTick() {
  const latest = db.prepare('SELECT id FROM study_encourage ORDER BY id DESC LIMIT 1').get();
  if (!latest) return;
  getEncourage().catch(() => { /* 静默 */ });
}

export const encourage = generateEncourage;

function templateEncourage(data) {
  const tips = [];
  if (data.practiceStats?.rate != null && data.practiceStats.rate >= 60) {
    tips.push(`变式练习正确率已达 ${data.practiceStats.rate}%，你的努力正在变成实力。`);
  }
  const improving = data.trend.slice(-2);
  if (improving.length === 2 && improving[1].pct > improving[0].pct) {
    tips.push(`最近一次考试得分率从 ${improving[0].pct}% 提升到 ${improving[1].pct}%，进步看得见！`);
  }
  if (data.reviewDueCount > 0) {
    tips.push(`今天有 ${data.reviewDueCount} 个知识点等你复习，趁记忆还热乎，去学情分析页完成它们吧。`);
  }
  if (data.weakNodes?.length) {
    const target = data.weakNodes[0];
    tips.push(`攻克「${target.name}」这个薄弱点（当前掌握度 ${target.mastery}%），你就又前进了一大步。`);
  }
  if (!tips.length) {
    tips.push('错题不可怕，可怕的是放过它。每弄懂一道错题，知识网络就亮一格。现在开始记录你的第一道错题吧！');
  }
  return tips.slice(0, 2).join(' ');
}
