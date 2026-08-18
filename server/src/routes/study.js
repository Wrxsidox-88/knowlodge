import { Router } from 'express';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { aiEnabled, chat } from '../ai/client.js';
import {
  overview, report, reportSummary,
  completeReview, recordPracticeResult, masteryScore, weakCandidates, encourage, getEncourage, refreshEncourage
} from '../services/study.js';
import { listCauseTags } from '../services/causeTags.js';

export const studyRouter = Router();

studyRouter.get('/overview', (req, res) => {
  res.json(overview({ subject: req.query.subject || null }));
});

studyRouter.get('/causes', (req, res) => {
  res.json({ items: listCauseTags() });
});

studyRouter.get('/encourage', async (req, res, next) => {
  try {
    res.json(await getEncourage());
  } catch (e) {
    next(e);
  }
});

studyRouter.post('/encourage/refresh', async (req, res, next) => {
  try {
    res.json(await refreshEncourage());
  } catch (e) {
    next(e);
  }
});

studyRouter.post('/reviews/:nodeId/complete', (req, res) => {
  const nodeId = Number(req.params.nodeId);
  const m = completeReview(nodeId);
  if (!m) return res.status(404).json({ error: '该知识点暂无掌握度记录' });
  const node = db.prepare('SELECT name FROM knowledge_nodes WHERE id = ?').get(nodeId);
  res.json({ ok: true, mastery: masteryScore(m), name: node?.name, nextReview: m.next_review_at });
});

studyRouter.get('/practices', (req, res) => {
  const rows = db.prepare(
    `SELECT p.*, n.name AS node_name FROM practices p
     LEFT JOIN knowledge_nodes n ON n.id = p.node_id
     ORDER BY p.id DESC LIMIT 50`
  ).all();
  res.json({ items: rows });
});

studyRouter.post('/practice/generate', async (req, res, next) => {
  try {
    const nodeId = req.body?.nodeId ? Number(req.body.nodeId) : null;
    let node;
    if (nodeId) {
      node = db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(nodeId);
      if (!node) return res.status(404).json({ error: '知识点不存在' });
    } else {
      const weak = weakCandidates(1);
      if (!weak.length) return res.status(400).json({ error: '暂无薄弱知识点，请先录入并分析错题' });
      node = db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(weak[0].id);
    }
    const source = db.prepare(
      `SELECT w.* FROM wrong_questions w
       JOIN wrong_question_nodes wn ON wn.question_id = w.id
       WHERE wn.node_id = ? ORDER BY w.id DESC LIMIT 1`
    ).get(node.id);

    let generated;
    if (aiEnabled()) {
      generated = await aiGenerateVariant(node, source);
    } else {
      generated = offlineVariant(node, source);
    }

    const info = db.prepare(
      `INSERT INTO practices (node_id, source_wrong_id, question, figure, reference_answer, status)
       VALUES (?, ?, ?, ?, ?, 'open')`
    ).run(node.id, source?.id ?? null, generated.question, generated.figure ? JSON.stringify(generated.figure) : null, generated.referenceAnswer || null);
    const id = Number(info.lastInsertRowid);
    logger.info(`变式练习生成: #${id} 知识点《${node.name}》 (${aiEnabled() ? 'AI' : '离线模板'})`);
    res.status(201).json({ id, nodeId: node.id, nodeName: node.name, question: generated.question, figure: generated.figure || null });
  } catch (e) {
    next(e);
  }
});

studyRouter.post('/practices/:id/submit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const p = db.prepare('SELECT * FROM practices WHERE id = ?').get(id);
    if (!p) return res.status(404).json({ error: '练习不存在' });
    if (p.status !== 'open') return res.status(409).json({ error: '该练习已完成' });
    const { answer, selfCorrect } = req.body || {};

    let isCorrect;
    let comment;
    let byAI = false;
    if (aiEnabled()) {
      byAI = true;
      const judged = await aiJudge(p, answer || '');
      isCorrect = judged.isCorrect;
      comment = judged.comment;
    } else {
      isCorrect = Boolean(selfCorrect);
      comment = '离线模式：自我判定';
    }

    db.prepare(
      `UPDATE practices SET user_answer = ?, is_correct = ?, comment = ?, status = ? WHERE id = ?`
    ).run(answer || null, isCorrect ? 1 : 0, comment || null, byAI ? 'done' : 'self', id);
    recordPracticeResult(p.node_id, isCorrect);

    const m = db.prepare('SELECT * FROM mastery WHERE node_id = ?').get(p.node_id);
    const node = db.prepare('SELECT name FROM knowledge_nodes WHERE id = ?').get(p.node_id);
    res.json({
      isCorrect,
      comment,
      byAI,
      referenceAnswer: p.reference_answer,
      nodeName: node?.name,
      mastery: m ? masteryScore(m) : null
    });
  } catch (e) {
    next(e);
  }
});

studyRouter.get('/report', (req, res) => {
  res.json(report());
});

studyRouter.get('/report/summary', async (req, res, next) => {
  try {
    res.json(await reportSummary(req.query.guide || ''));
  } catch (e) {
    next(e);
  }
});

async function aiGenerateVariant(node, source) {
  const reply = await chat([
    {
      role: 'system',
      content: `你是命题专家。围绕知识点出一道同源变式练习题，只输出 JSON：
{
 "question":"完整题干（含已知条件与问题）",
 "figure":"若题目需要几何图形则输出 JSON 对象，否则为 null",
 "referenceAnswer":"参考答案与关键步骤，公式用 LaTeX"
}
figure 图形规范（系统会据此渲染，不要让 AI 画图）：
{"type":"polygon","points":[[x,y],...],"labels":["A","B",...] } 或 {"type":"circle","cx":150,"cy":150,"r":80,"labels":["O"]}
坐标系 0~300，y 向下。不要输出 JSON 以外的内容。`
    },
    {
      role: 'user',
      content: `知识点：${node.name}（${node.subject || '未知科目'}，${node.category || ''}）
${node.description ? `知识点说明：${node.description}` : ''}
${source ? `原错题：${source.question}\n原正确答案：${source.correct_answer || '-'}` : '无原错题，直接出新题'}`
    }
  ], { temperature: 0.7 });

  let s = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    const data = JSON.parse(s);
    const figure = data.figure && typeof data.figure === 'object' && ['polygon', 'circle'].includes(data.figure.type)
      ? data.figure
      : null;
    return { question: data.question || '（生成失败，请重试）', figure, referenceAnswer: data.referenceAnswer || null };
  } catch {
    return { question: reply.trim(), figure: null, referenceAnswer: null };
  }
}

function offlineVariant(node, source) {
  if (source) {
    return {
      question: `【离线变式】基于原错题改编：请再次作答并说明思路 ——\n${source.question}`,
      figure: null,
      referenceAnswer: source.correct_answer || '（暂无参考答案，配置 AI 后可自动生成）'
    };
  }
  return {
    question: `【离线变式】围绕知识点「${node.name}」默写其定义/公式，并举一个应用场景。`,
    figure: null,
    referenceAnswer: node.description || '（暂无参考答案，配置 AI 后可自动生成）'
  };
}

async function aiJudge(p, answer) {
  const reply = await chat([
    {
      role: 'system',
      content: '你是阅卷老师。对照参考答案判断用户作答，只输出 JSON：{"isCorrect":true或false,"comment":"不超过80字的点评，指出对错原因，公式用 LaTeX"}'
    },
    {
      role: 'user',
      content: `题目：${p.question}\n参考答案：${p.reference_answer || '（未提供，按解题合理性判断）'}\n用户作答：${answer}`
    }
  ], { temperature: 0.1 });
  try {
    let s = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    const data = JSON.parse(s);
    return { isCorrect: Boolean(data.isCorrect), comment: data.comment || '' };
  } catch {
    return { isCorrect: false, comment: reply.trim().slice(0, 120) };
  }
}
