import { db } from '../db.js';
import { logger } from '../logger.js';
import { aiEnabled, chat } from '../ai/client.js';

const KEY = 'exam_targets';

// 目标成绩数据结构：
// {
//   enabled: true,
//   total: { score: 560, total: 750, gradeRank: 100, classRank: 10 },   // 总分目标（score=目标总分，total=总分满分）
//   subjects: { '数学': { score: 120, total: 150, gradeRank: 80, classRank: 8 }, ... }
// }
function emptyTargets() {
  return { enabled: false, total: null, subjects: {} };
}

export function getTargets() {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
    if (!row || !row.value) return emptyTargets();
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return emptyTargets();
    return {
      enabled: !!parsed.enabled,
      total: parsed.total || null,
      subjects: parsed.subjects && typeof parsed.subjects === 'object' ? parsed.subjects : {}
    };
  } catch (e) {
    logger.warn(`读取目标成绩失败: ${e.message}`);
    return emptyTargets();
  }
}

function normalizeNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function saveTargets(body = {}) {
  const targets = emptyTargets();
  targets.enabled = !!body.enabled;

  const total = body.total && typeof body.total === 'object' ? body.total : {};
  const tScore = normalizeNumber(total.score);
  const tTotal = normalizeNumber(total.total);
  const tGrade = normalizeNumber(total.gradeRank);
  const tClass = normalizeNumber(total.classRank);
  if (tScore != null || tTotal != null || tGrade != null || tClass != null) {
    targets.total = {
      score: tScore,
      total: tTotal,
      gradeRank: tGrade,
      classRank: tClass
    };
  }

  const subs = body.subjects && typeof body.subjects === 'object' ? body.subjects : {};
  for (const [subject, s] of Object.entries(subs)) {
    if (!s || typeof s !== 'object' || !String(subject).trim()) continue;
    const score = normalizeNumber(s.score);
    const total = normalizeNumber(s.total);
    const gradeRank = normalizeNumber(s.gradeRank);
    const classRank = normalizeNumber(s.classRank);
    if (score == null && total == null && gradeRank == null && classRank == null) continue;
    targets.subjects[String(subject).trim()] = {
      score,
      total,
      gradeRank,
      classRank
    };
  }

  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(KEY, JSON.stringify(targets));
  logger.info('目标成绩已保存', { user: 'system', enabled: targets.enabled });
  return targets;
}

// 汇总用于 AI 建议的数据：各科最近成绩 + 排名 + 趋势
function buildSuggestionContext(targets) {
  const exams = db.prepare(
    `SELECT id, subject, title, exam_date, total_score, score, grade_rank, class_rank
     FROM exams ORDER BY exam_date ASC, id ASC LIMIT 500`
  ).all();

  const bySubject = new Map();
  for (const e of exams) {
    if (!bySubject.has(e.subject)) bySubject.set(e.subject, []);
    bySubject.get(e.subject).push(e);
  }

  const summary = { subjects: {}, recent: [] };
  for (const [subject, list] of bySubject.entries()) {
    const last = list[list.length - 1];
    const last5 = list.slice(-5);
    const avg = (arr, pick) => {
      const vals = arr.map(pick).filter((v) => v != null && v > 0);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    const avgPct = (arr) => {
      const vals = arr.map((e) => (e.total_score ? (e.score / e.total_score) * 100 : null)).filter((v) => v != null);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    summary.subjects[subject] = {
      count: list.length,
      last: {
        date: last.exam_date,
        score: last.score,
        total: last.total_score,
        pct: last.total_score ? Math.round((last.score / last.total_score) * 1000) / 10 : null,
        gradeRank: last.grade_rank ?? null,
        classRank: last.class_rank ?? null
      },
      avgScore: avg(list, (e) => e.score),
      avgPct: avgPct(list),
      recent5Pct: avgPct(last5),
      trend: list.slice(-5).map((e) => ({ date: e.exam_date, score: e.score, pct: e.total_score ? Math.round((e.score / e.total_score) * 1000) / 10 : null }))
    };
    summary.recent.push({ subject, ...summary.subjects[subject] });
  }

  // 总分目标参考：最近一次大型考试事件的总分
  const event = db.prepare(
    `SELECT ev.id, ev.title, ev.exam_date, ifnull(SUM(e.total_score), 0) AS total, ifnull(SUM(e.score), 0) AS score
     FROM exam_events ev JOIN exams e ON e.exam_event_id = ev.id
     GROUP BY ev.id ORDER BY ev.exam_date DESC, ev.id DESC LIMIT 1`
  ).get();
  summary.lastEvent = event
    ? { title: event.title, date: event.exam_date, score: event.score, total: event.total, pct: event.total ? Math.round((event.score / event.total) * 1000) / 10 : null }
    : null;

  return { targets, summary };
}

export async function suggestTargets() {
  const targets = getTargets();
  const ctx = buildSuggestionContext(targets);
  const { summary } = ctx;

  const hasData = (summary.recent.length > 0) || !!summary.lastEvent;
  if (!aiEnabled()) {
    return { note: '未配置 AI 模型，无法生成个性化建议。可先参考最近一次成绩手动设定目标。', source: 'offline', suggestion: null, hasData };
  }
  if (!hasData) {
    return { note: '暂无考试数据，AI 无法给出建议。请先录入考试记录。', source: 'offline', suggestion: null, hasData };
  }

  try {
    const reply = await chat([
      {
        role: 'system',
        content:
          '你是学习目标规划师。根据学生最近考试的成绩与排名数据，给出下一阶段合理且有挑战性的目标建议。只输出 JSON（不要输出任何其他内容）：\n' +
          '{"suggestion":"一段 Markdown 文字（200字内）：总体建议 + 每科目标思路 + 排名提升方向","total":{"score":数字,"total":数字,"gradeRank":数字,"classRank":数字},"subjects":{"科目名":{"score":数字,"total":数字,"gradeRank":数字,"classRank":数字}}}。\n' +
          '要求：目标分数基于学生近期平均分与趋势适当上浮（不超过满分）；排名目标基于最近排名小幅提升（名次数值变小）；未录入排名的科目可不给排名目标（设为 null）；满分(total)沿用最近一次考试或目标中已有的满分，不要臆造满分。'
      },
      { role: 'user', content: `学生当前目标：${JSON.stringify(targets)}\n最近成绩数据：${JSON.stringify(summary)}` }
    ], { temperature: 0.4 });

    let s = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    const data = JSON.parse(s);
    const suggestion = {
      text: data.suggestion || '',
      total: data.total || null,
      subjects: data.subjects || {}
    };
    return { note: 'AI 已根据最近成绩生成目标建议，可点击「套用建议」填入并保存。', source: 'ai', suggestion, hasData };
  } catch (e) {
    logger.warn(`目标成绩 AI 建议生成失败: ${e.message}`);
    return { note: `AI 建议生成失败：${e.message}`, source: 'offline', suggestion: null, hasData };
  }
}
