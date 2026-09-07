import { db } from '../db.js';
import { logger } from '../logger.js';
import { getEnv } from '../config.js';
import { aiEnabled, chat } from '../ai/client.js';
import { getTargets } from './targets.js';
import {
  BKT, MEMORY,
  posteriorOnCorrect, posteriorOnWrong,
  recallProbability, stabilityAfterRecall, stabilityAfterLapse,
  reviewIntervalDays, migrateLegacy, masteryFromState, daysSince
} from './bayes.js';
import { subjectProfile } from './subjects.js';

export const ERROR_CAUSES = ['知识盲区', '逻辑错误', '概念混淆', '粗心', '方法错误', '其他'];
// 兼容保留：调度已改为基于记忆稳定性的自适应间隔（bayes.reviewIntervalDays）
export const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30];

// ---------- 学习状态读写 ----------

/** 读取某知识点的概率学习状态（旧行自动迁移，不落库） */
export function learningStateOf(row) {
  if (row && row.p_known != null && row.stability != null) {
    return { pKnown: row.p_known, stability: row.stability, migrated: false };
  }
  const legacy = migrateLegacy({
    correct: row?.correct || 0,
    wrong: row?.wrong || 0,
    stage: row?.stage || 0,
    last_review_at: row?.last_review_at || null
  });
  return { ...legacy, migrated: true };
}

function getMasteryRow(nodeId) {
  return db.prepare('SELECT * FROM mastery WHERE node_id = ?').get(Number(nodeId));
}

/** 展示用掌握度：P(掌握|证据流) × 当前记忆可提取概率 */
export function masteryScore(m) {
  if (!m) return 60;
  const total = (m.correct || 0) + (m.wrong || 0);
  if (total === 0 && m.p_known == null) return 60;
  const { pKnown, stability } = learningStateOf(m);
  const days = daysSince(m.last_review_at);
  return masteryFromState(pKnown, stability, days ?? 0, Boolean(m.last_review_at));
}

/** 记忆保持率（0~1）：距上次成功回忆的瞬时可提取概率 */
export function retentionOf(row) {
  if (!row?.last_review_at) return 1;
  const { stability } = learningStateOf(row);
  return recallProbability(stability, daysSince(row.last_review_at) ?? 0);
}

function withLearningFields(row) {
  if (!row) return row;
  const { pKnown, stability } = learningStateOf(row);
  const retention = retentionOf(row);
  return {
    ...row,
    pKnown,
    stability,
    retention,
    mastery: masteryFromState(pKnown, stability, daysSince(row.last_review_at) ?? 0, Boolean(row.last_review_at)),
    advice: subjectProfile(row.subject).reviewStyle
  };
}

// ---------- 知识图谱传播（关联骨架） ----------

const RELATION_WEIGHTS = [
  [/前置|先修|依赖|基础|前提/, 0.35],
  [/包含|组成|隶属|属于|分为/, 0.28],
  [/相关|应用|类比|同义|推导|延伸/, 0.15]
];

function relationWeight(relation) {
  const r = String(relation || '');
  for (const [re, w] of RELATION_WEIGHTS) if (re.test(r)) return w;
  return 0.12;
}

/**
 * 证据在图谱上传播：某节点掌握概率变化后，相邻节点按关系类型
 * 获得小比例的同向调整（共享盲区/共享基础），单次传播幅度受限。
 */
export function propagateMastery(nodeId, delta) {
  const d = Number(delta) || 0;
  if (!nodeId || Math.abs(d) < 0.02) return;
  const neighbors = db.prepare(
    `SELECT m.node_id AS id, m.p_known, e.relation FROM knowledge_edges e
     JOIN mastery m ON m.node_id = (CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END)
     WHERE (e.source_id = ? OR e.target_id = ?) AND m.node_id != ?`
  ).all(nodeId, nodeId, nodeId, nodeId);
  const update = db.prepare('UPDATE mastery SET p_known = ? WHERE node_id = ?');
  for (const nb of neighbors) {
    const cur = nb.p_known != null ? nb.p_known : BKT.L0;
    const shift = Math.max(-0.08, Math.min(0.08, d * relationWeight(nb.relation) * 0.5));
    update.run(Math.min(0.99, Math.max(0.01, cur + shift)), nb.id);
  }
}

// ---------- 证据更新核心 ----------

/**
 * 对单个知识点吸收一次证据（贝叶斯更新 + 记忆更新 + 调度 + 传播）。
 * evidence: { correct: true/false/null, strength: 0~1, memory: 'recall'|'lapse'|null }
 */
export function applyEvidence(nodeId, { correct = null, strength = 1, memory = null } = {}) {
  const id = Number(nodeId);
  if (!id) return null;
  const row = getMasteryRow(id);
  const node = db.prepare('SELECT subject FROM knowledge_nodes WHERE id = ?').get(id);
  const state = learningStateOf(row);
  let L = state.pKnown;
  let theta = state.stability;
  const LBefore = L;

  if (correct === true) L = posteriorOnCorrect(L, { strength });
  else if (correct === false) L = posteriorOnWrong(L, { strength });

  const days = row?.last_review_at ? daysSince(row.last_review_at) : null;
  if (memory === 'recall') theta = stabilityAfterRecall(theta, days ?? 0.5);
  else if (memory === 'lapse') theta = stabilityAfterLapse(theta);
  else if (correct === true) theta = stabilityAfterRecall(theta, days ?? 0.5);
  else if (correct === false) theta = stabilityAfterLapse(theta);

  const interval = reviewIntervalDays(theta);
  const nowSql = "datetime('now')";
  const nextSql = `datetime('now', '+${Math.round(interval * 86400)} seconds')`;

  if (!row) {
    db.prepare(
      `INSERT INTO mastery (node_id, correct, wrong, stage, last_review_at, next_review_at, p_known, stability)
       VALUES (?, ?, ?, 0, ${correct === true || memory === 'recall' ? nowSql : 'NULL'}, ${nextSql}, ?, ?)`
    ).run(id, correct === true ? 1 : 0, correct === false ? 1 : 0, L, theta);
  } else {
    db.prepare(
      `UPDATE mastery SET
         correct = correct + ?, wrong = wrong + ?,
         stage = CASE WHEN ? = 'recall' THEN stage + 1 WHEN ? = 'lapse' THEN 0 ELSE stage END,
         last_review_at = ${correct === true || memory === 'recall' ? nowSql : 'last_review_at'},
         next_review_at = ${nextSql},
         p_known = ?, stability = ?
       WHERE node_id = ?`
    ).run(
      correct === true ? 1 : 0,
      correct === false ? 1 : 0,
      memory || '',
      memory || '',
      L, theta, id
    );
  }

  propagateMastery(id, L - LBefore);
  return getMasteryRow(id);
}

/** 错题证据：真实情境下做错，是最强的"未掌握"信号（供错题分析管线调用） */
export function registerWrongOnNodes(nodeIds) {
  for (const id of nodeIds || []) {
    try {
      applyEvidence(id, { correct: false, strength: 1 });
    } catch (e) {
      logger.warn(`错题证据写入失败 node=${id}: ${e.message}`);
    }
  }
}

/** 练习作答证据：AI 判题/自评结果回写 */
export function recordPracticeResult(nodeId, isCorrect) {
  if (!nodeId) return;
  applyEvidence(nodeId, { correct: Boolean(isCorrect), strength: 1 });
}

/**
 * 完成一次复习（自适应记忆调度）。
 * result='recalled'：成功回忆 → 稳定性上调、间隔拉长；
 * result='forgot'：遗忘 → 稳定性收缩、间隔缩短，轮次归零。
 */
export function completeReview(nodeId, result = 'recalled') {
  const row = getMasteryRow(nodeId);
  if (!row) return null;
  const forgot = String(result) === 'forgot';
  const next = applyEvidence(nodeId, {
    correct: forgot ? false : true,
    // 复习中成功回忆带有"刚看过提示"的效应，作为掌握证据打折扣
    strength: forgot ? 0.8 : 0.6,
    memory: forgot ? 'lapse' : 'recall'
  });
  return next;
}

/** 考试成绩作为科目级校准证据：实际得分率低于模型预期时，该科各知识点掌握后验小幅下调 */
export function registerExamEvidence(subject, score, totalScore) {
  const pct = totalScore > 0 ? score / totalScore : null;
  if (!subject || pct == null) return;
  const rows = db.prepare(
    `SELECT m.* FROM mastery m JOIN knowledge_nodes n ON n.id = m.node_id
     WHERE n.subject = ?`
  ).all(subject);
  if (!rows.length) return;
  let expected = 0;
  for (const r of rows) expected += learningStateOf(r).pKnown;
  expected /= rows.length;
  const delta = Math.max(-0.25, Math.min(0.25, expected - pct));
  if (Math.abs(delta) < 0.03) return;
  const update = db.prepare('UPDATE mastery SET p_known = ? WHERE node_id = ?');
  for (const r of rows) {
    const cur = learningStateOf(r).pKnown;
    update.run(Math.min(0.99, Math.max(0.01, cur - delta * 0.12)), r.node_id);
  }
  logger.info(`考试成绩校准证据: ${subject} 得分率 ${(pct * 100).toFixed(1)}% vs 预期 ${(expected * 100).toFixed(1)}%，已调整 ${rows.length} 个知识点`);
}

// ---------- 查询视图 ----------

/**
 * 周末使用模式（STUDY_WEEKEND_MODE）：学生只有周末才能用电脑，
 * 工作日不催复习——把截至本周日到期的复习统一汇总为「本周复习计划」，
 * 回家后一次性完成。复习间隔仍按真实复习时间计算，不受开关影响。
 */
export function weekendModeEnabled() {
  return getEnv('STUDY_WEEKEND_MODE', 'off').toLowerCase() === 'on';
}

function nextSundayISO() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=周日
  const diff = day === 0 ? 0 : 7 - day;
  const d = new Date(now.getTime() + diff * 86400000);
  return d.toISOString().slice(0, 10);
}

function dueReviews(limit = 30, { throughSunday = false } = {}) {
  const cond = throughSunday
    ? "date(m.next_review_at) <= date('now', 'weekday 0')"
    : "date(m.next_review_at) <= date('now')";
  return db.prepare(
    `SELECT m.*, n.name, n.subject, n.category FROM mastery m
     JOIN knowledge_nodes n ON n.id = m.node_id
     WHERE m.next_review_at IS NOT NULL AND ${cond}
     ORDER BY date(m.next_review_at) ASC, m.p_known ASC
     LIMIT ?`
  ).all(limit);
}

function weakNodes({ subject = null, limit = 15 } = {}) {
  const where = subject ? 'AND n.subject = ?' : '';
  const rows = db.prepare(
    `SELECT n.id, n.name, n.subject, n.category, m.correct, m.wrong, m.stage, m.last_review_at, m.next_review_at, m.p_known, m.stability
     FROM mastery m JOIN knowledge_nodes n ON n.id = m.node_id
     WHERE (m.wrong > 0 OR m.correct > 0 OR m.p_known IS NOT NULL) ${where}`
  ).all(...(subject ? [subject] : []));
  const list = rows.map((r) => withLearningFields(r));
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
    `SELECT n.subject, m.correct, m.wrong, m.stage, m.last_review_at, m.p_known, m.stability FROM mastery m
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

  const weekendMode = weekendModeEnabled();

  return {
    subjects,
    radar,
    weakNodes: weak,
    subjectAverages,
    causeDistribution: causeRows,
    trend: trend.map((t) => ({ ...t, pct: t.total_score ? Math.round((t.score / t.total_score) * 1000) / 10 : 0 })),
    targets: getTargets(),
    reviewDue: dueReviews(20, { throughSunday: weekendMode }).map((r) => withLearningFields(r)),
    reviewDueCount: weekendMode
      ? db.prepare(
          "SELECT COUNT(*) AS c FROM mastery WHERE next_review_at IS NOT NULL AND date(next_review_at) <= date('now', 'weekday 0')"
        ).get().c
      : db.prepare(
          "SELECT COUNT(*) AS c FROM mastery WHERE next_review_at IS NOT NULL AND date(next_review_at) <= date('now')"
        ).get().c,
    weekendMode,
    weekendDueThrough: weekendMode ? nextSundayISO() : null,
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
      content: '你是学情分析师。掌握度由贝叶斯知识追踪（掌握后验×记忆保持率）估计，0~100。根据统计数据输出简洁明的学情报告（Markdown，300 字内）：整体评价、最薄弱的知识点与成因、下一步提升建议（按学科学习方法给出具体做法）。不要编造数据中没有的内容。'
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
    tips.push(
      weekendModeEnabled()
        ? `本周复习计划已排好：${data.reviewDueCount} 个知识点等周末统一过一遍，回家后到学情分析页完成它们。`
        : `今天有 ${data.reviewDueCount} 个知识点等你复习，趁记忆还热乎，去学情分析页完成它们吧。`
    );
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
