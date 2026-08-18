import path from 'node:path';
import fs from 'node:fs';
import { db } from '../db.js';
import { IMAGE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { aiEnabled, visionEnabled, chat, visionDescribe } from '../ai/client.js';
import { upsertNode } from './graph.js';
import { registerWrongOnNodes } from './study.js';
import { listCauseTags, resolveCauseTag } from './causeTags.js';
import { extractKeywords } from './textutil.js';

function parseJSONLoose(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function visionReadQuestion(w) {
  try {
    const buf = fs.readFileSync(path.join(IMAGE_DIR, w.image_path));
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    return await visionDescribe(
      dataUrl,
      '这是一道错题的照片。请尽量转写：题干、选项、用户作答与批改痕迹、涉及的公式与图形。'
    );
  } catch (e) {
    logger.warn(`错题 ${w.id} 图像识别失败: ${e.message}`);
    return null;
  }
}

export async function analyzeWrongQuestion(id, guide = '') {
  const w = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(id);
  if (!w) throw new Error('错题不存在');
  db.prepare("UPDATE wrong_questions SET status = 'analyzing', updated_at = datetime('now') WHERE id = ?").run(id);

  try {
    let structured = null;
    let imageText = null;
    if (w.image_path && visionEnabled()) {
      imageText = await visionReadQuestion(w);
      if (imageText && (!w.question || w.question.trim().length < 10)) {
        db.prepare("UPDATE wrong_questions SET question = ?, updated_at = datetime('now') WHERE id = ?").run(imageText, id);
        w.question = imageText;
      }
    }

    if (aiEnabled()) {
      structured = await aiStructure(w, imageText, guide);
    } else {
      structured = offlineStructure(w);
    }

    db.prepare('DELETE FROM wrong_question_nodes WHERE question_id = ?').run(id);
    const nodeIds = [];
    const subject = w.subject || structured.subject || null;
    for (const kp of structured.knowledgePoints || []) {
      const nodeId = upsertNode({
        name: kp.name,
        subject,
        category: kp.category || '考点',
        description: kp.description || `由错题#${id}关联的考点`,
        materialId: null
      });
      if (nodeId) {
        nodeIds.push(nodeId);
        db.prepare('INSERT OR IGNORE INTO wrong_question_nodes (question_id, node_id) VALUES (?, ?)').run(id, nodeId);
      }
    }
    registerWrongOnNodes(nodeIds);

    db.prepare(
      `UPDATE wrong_questions SET
         subject = ifnull(?, subject),
         options = ifnull(CASE WHEN ifnull(options,'') = '' THEN ? END, options),
         correct_answer = ifnull(CASE WHEN ifnull(correct_answer,'') = '' THEN ? END, correct_answer),
         user_answer = ifnull(CASE WHEN ifnull(user_answer,'') = '' THEN ? END, user_answer),
         error_cause = ifnull(CASE WHEN ifnull(error_cause,'') = '' THEN ? END, error_cause),
         cause_note = ifnull(CASE WHEN ifnull(cause_note,'') = '' THEN ? END, cause_note),
         analysis = ?,
         knowledge_points = ?,
         status = 'done',
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      structured.subject || null,
      structured.options || null,
      structured.correctAnswer || null,
      structured.userAnswer || null,
      structured.errorCause || null,
      structured.causeNote || null,
      structured.analysis || null,
      JSON.stringify(structured.knowledgePoints || []),
      id
    );
    logger.info(`错题 ${id} 分析完成：知识点 ${nodeIds.length} 个，错因 ${structured.errorCause || '-'}`);
  } catch (e) {
    db.prepare("UPDATE wrong_questions SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(id);
    logger.error(`错题 ${id} 分析失败: ${e.message}`);
    throw e;
  }
}

async function aiStructure(w, imageText, guide) {
  const tags = listCauseTags();
  const tagList = tags.length
    ? tags.map((t) => `- ${t.name}：${t.description || '（无说明）'}`).join('\n')
    : '（暂无预设标签，可自行创建）';

  const context = [`题目标题/题干：${w.question}`];
  if (w.options) context.push(`选项：${w.options}`);
  if (w.correct_answer) context.push(`正确答案：${w.correct_answer}`);
  if (w.user_answer) context.push(`用户作答：${w.user_answer}`);
  if (w.cause_note) context.push(`用户自述：${w.cause_note}`);
  if (imageText) context.push(`图片识别内容：${imageText}`);

  const reply = await chat([
    {
      role: 'system',
      content: `你是错题分析专家。系统当前已有错因标签（名称：说明）：
${tagList}

请把错题结构化，只输出 JSON：
{
 "subject":"${['数学', '物理', '化学', '生物', '语文', '英语', '历史', '地理', '政治', '其他'].join('|')}"或留空,
 "options":"整理后的选项文本，可空",
 "correctAnswer":"正确答案",
 "userAnswer":"用户作答",
 "errorCause":"错因标签名（2-6字）",
 "isNewCause":true或false,
 "causeDescription":"若 isNewCause=true，为新标签写一句说明；否则留空",
 "causeNote":"不超过60字的错因说明",
 "analysis":"不超过200字的解析：正确思路、易错点、注意事项。公式用 LaTeX（$...$ / $\\ce{...}$）",
 "knowledgePoints":[{"name":"知识点/考点名","category":"概念|方法|规律|公式|定理|题型","description":"不超过30字"}]
}
错因标签判定规则（务必严格执行）：
1. 逐一对照上方已有标签，判断其说明是否与本题错误的根本原因完全吻合；
2. 有完全吻合的标签 → 直接使用该标签名，isNewCause=false；
3. 没有任何已有标签能准确概括（例如错因属于标签未覆盖的新类型）→ 必须新建：给出一个 2-6 字的简洁标签名，isNewCause=true，并在 causeDescription 写清适用情形；
4. 禁止为了复用而牵强套用不吻合的已有标签（如把"计算失误"硬归入"知识盲区"）。
知识点命名必须精准、无歧义，1-4 个。不要输出 JSON 以外的内容。`
    },
    {
      role: 'user',
      content: `${context.join('\n')}${guide ? `\n\n用户分析引导：${guide}` : ''}`
    }
  ], { temperature: 0.2 });

  const data = parseJSONLoose(reply);
  if (!data) {
    logger.warn(`错题 ${w.id} AI 返回无法解析，降级离线结构化`);
    return offlineStructure(w);
  }
  if (data.errorCause) {
    const existingNames = new Set(tags.map((t) => t.name));
    // AI 声称新建但给出的名字已存在 → 按复用处理；给出的新名字不存在 → 落库为 source=ai 的新标签
    const resolved = resolveCauseTag(
      data.errorCause,
      data.isNewCause ? (data.causeDescription || data.causeNote || '') : ''
    );
    data.errorCause = resolved ? resolved.name : w.error_cause || '其他';
    if (resolved && data.isNewCause && !existingNames.has(data.errorCause)) {
      logger.info(`错题 ${w.id} AI 新建错因标签「${resolved.name}」`);
    }
  } else {
    data.errorCause = w.error_cause || '其他';
  }
  data.knowledgePoints = Array.isArray(data.knowledgePoints) ? data.knowledgePoints.filter((k) => k?.name) : [];
  return data;
}

function offlineStructure(w) {
  const keywords = extractKeywords(`${w.question} ${w.options || ''}`, 4);
  return {
    subject: w.subject || null,
    options: w.options || null,
    correctAnswer: w.correct_answer || null,
    userAnswer: w.user_answer || null,
    errorCause: w.error_cause || '未标注',
    causeNote: w.cause_note || '离线模式：未经过 AI 分析',
    analysis: '离线模式（未配置 AI）：已按关键词关联知识点。配置模型后重新分析可获得完整解析。',
    knowledgePoints: keywords.map((k) => ({ name: k, category: '考点' }))
  };
}
