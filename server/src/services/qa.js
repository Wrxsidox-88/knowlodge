import { db } from '../db.js';
import { logger } from '../logger.js';
import { aiEnabled, chat, chatStream } from '../ai/client.js';
import { semanticSearch } from './search.js';
import { masteryScore } from './study.js';
import { FIGURE_TOOL_DOC } from './figures.js';

export const TOOL_DOC = `【工具能力】你可以在回答中输出代码块调用系统工具。\`\`\`figure 图形块会被自动渲染；\`\`\`tool 块属于敏感操作，需用户在界面上明确授权后才执行。输出工具块前先用一句话说明你的意图。
tool 块格式：\`\`\`tool {"tool":"<工具名>","args":{...}}
可用工具：
- generate_document 生成Word文档：{"name":"文档标题","blocks":[{"type":"heading","level":1,"text":"..."},{"type":"text","text":"段落，可换行"},{"type":"figure","spec":<figure图形spec>,"caption":"图1 说明"}]}
- reanalyze_material 重新分析学习材料：{"materialId":1,"guide":"分析引导词"}
- countdown_add 新建倒计时：{"title":"期末考试","targetTime":"2026-09-01T08:00:00"}
- countdown_delete 删除倒计时：{"id":1}
- list_create 新建知识清单：{"name":"清单名","description":"用途说明(辅助AI后续编辑)","content":"Markdown 内容","parentId":null}
- list_edit 更新知识清单（仅限允许AI编辑的清单）：{"id":1,"mode":"append或replace","content":"Markdown 内容"}
- mindmap_create 新建脑图（思维导图）：{"name":"脑图名","subject":"科目可省略","content":{"text":"中心主题","children":[{"text":"分支","children":[{"text":"子节点","children":[]}]}]}}
规则：一次回答最多调用一个 tool；ID 必须来自对话中真实出现的系统数据，不得编造。`;

export function buildReferencesContext(references) {
  if (!Array.isArray(references) || !references.length) return '';
  const parts = [];
  for (const ref of references.slice(0, 8)) {
    if (ref.type === 'material') {
      const m = db.prepare('SELECT id, title, subject, summary, content FROM materials WHERE id = ?').get(Number(ref.id));
      if (m) parts.push(`【材料#${m.id}《${m.title}》${m.subject ? ` 科目:${m.subject}` : ''}】\n${m.summary ? '概览: ' + m.summary + '\n' : ''}${String(m.content).slice(0, 1500)}`);
    } else if (ref.type === 'wrong') {
      const w = db.prepare('SELECT * FROM wrong_questions WHERE id = ?').get(Number(ref.id));
      if (w) parts.push(`【错题#${w.id}（${w.subject || '未分类'}，错因:${w.error_cause || '未标注'}）】\n题干: ${w.question}\n${w.options ? '选项: ' + w.options + '\n' : ''}${w.correct_answer ? '正确答案: ' + w.correct_answer + '\n' : ''}${w.user_answer ? '我的作答: ' + w.user_answer + '\n' : ''}${w.analysis ? '解析: ' + w.analysis : ''}`);
    } else if (ref.type === 'exam') {
      const e = db.prepare('SELECT * FROM exams WHERE id = ?').get(Number(ref.id));
      if (e) parts.push(`【考试#${e.id}】${e.subject} ${e.exam_date} 得分 ${e.score}/${e.total_score}${e.title ? `（${e.title}）` : ''}`);
    } else if (ref.type === 'list') {
      const l = db.prepare('SELECT id, name, description, content FROM knowledge_lists WHERE id = ?').get(Number(ref.id));
      if (l) parts.push(`【知识清单#${l.id}《${l.name}》】\n${l.description ? '描述: ' + l.description + '\n' : ''}${String(l.content || '').slice(0, 2000)}`);
    } else if (ref.type === 'node') {
      const n = db.prepare('SELECT id, name, subject, category, description FROM knowledge_nodes WHERE id = ?').get(Number(ref.id));
      if (n) parts.push(`【知识点#${n.id}《${n.name}》${n.subject ? ` 科目:${n.subject}` : ''}${n.category ? ` 分类:${n.category}` : ''}】\n${n.description || '（无说明）'}`);
    }
  }
  return parts.length ? `\n\n【用户引用的系统数据】\n${parts.join('\n\n')}` : '';
}

export function buildLearningProfile() {
  const weak = db.prepare(
    `SELECT n.name, n.subject, m.correct, m.wrong, m.stage, m.last_review_at
     FROM mastery m JOIN knowledge_nodes n ON n.id = m.node_id
     WHERE m.wrong > 0 ORDER BY m.wrong DESC LIMIT 5`
  ).all().map((r) => ({ ...r, mastery: masteryScore(r) }));
  weak.sort((a, b) => a.mastery - b.mastery);

  const recentWrong = db.prepare(
    `SELECT id, subject, question, error_cause FROM wrong_questions ORDER BY id DESC LIMIT 5`
  ).all();
  const recentExams = db.prepare(
    'SELECT subject, exam_date, total_score, score FROM exams ORDER BY exam_date DESC, id DESC LIMIT 3'
  ).all();
  const practice = db.prepare(
    "SELECT COUNT(*) AS total, ifnull(SUM(is_correct = 1), 0) AS correct FROM practices WHERE status != 'open'"
  ).get();
  const reviewDue = db.prepare(
    "SELECT COUNT(*) AS c FROM mastery WHERE wrong > 0 AND next_review_at IS NOT NULL AND date(next_review_at) <= date('now')"
  ).get().c;

  const hasData = weak.length || recentWrong.length || recentExams.length;
  if (!hasData) return null;

  const lines = ['【用户个人学情（来自系统统计，可用于个性化回答）】'];
  if (weak.length) {
    lines.push(`薄弱知识点：${weak.map((n) => `${n.name}(${n.subject || '未分类'}，掌握度${n.mastery}%)`).join('；')}`);
  }
  if (recentWrong.length) {
    lines.push(`最近错题：${recentWrong.map((w) => `${w.subject || '未分类'}/${w.error_cause || '未标注'}：${String(w.question).slice(0, 40)}`).join('；')}`);
  }
  if (recentExams.length) {
    lines.push(`近期考试：${recentExams.map((e) => `${e.subject}(${e.exam_date}) ${e.score}/${e.total_score}`).join('；')}`);
  }
  if (practice.total) {
    lines.push(`变式练习正确率：${Math.round((practice.correct / practice.total) * 100)}%（共${practice.total}题）`);
  }
  if (reviewDue) lines.push(`今日待复习知识点（记忆曲线到期）：${reviewDue} 个`);
  return lines.join('\n');
}

/**
 * 问答上下文准备（检索 + 学情 + 引用），非流式与流式共用。
 */
export async function prepareAnswerContext(question, { history = [], references = null } = {}) {
  const q = String(question || '').trim();
  if (!q) throw Object.assign(new Error('问题不能为空'), { status: 400 });

  const hits = await semanticSearch(q, { topN: 6 });
  const nodeNames = collectNodes(q, hits);
  const tree = buildTree(nodeNames);

  const citations = [];
  const seenMaterial = new Set();
  for (const h of hits) {
    if (seenMaterial.has(h.material_id)) continue;
    seenMaterial.add(h.material_id);
    citations.push({
      index: citations.length + 1,
      chunkId: h.id,
      materialId: h.material_id,
      materialTitle: h.material_title,
      subject: h.subject,
      kind: h.kind,
      snippet: h.text.slice(0, 200),
      score: h.score,
      source: `材料 #${h.material_id}《${h.material_title}》`
    });
  }

  const profile = buildLearningProfile();
  const personalTip = buildPersonalTip(nodeNames);
  const refsContext = buildReferencesContext(references);

  return { q, hits, tree, citations, profile, personalTip, refsContext, history };
}

export function buildAnswerMessages(ctx, model = null) {
  const hasRefs = ctx.citations.length > 0;
  const context = ctx.citations
    .map((c) => `[${c.index}] ${c.source}：${c.snippet}`)
    .join('\n');
  const refRules = hasRefs
    ? `2. 优先依据"参考资料"回答，并在用到资料处标注引用，如 [1][2]，编号与参考资料一致；资料不足的部分可结合自身知识补充，但要注明"以下为通用知识补充"。`
    : `2. 知识库中没有检索到相关资料，请基于你自身的知识完整回答用户，并在开头简要说明"知识库暂无相关资料"。`;
  return [
    {
      role: 'system',
      content: `你是"有求必应"的智能学习助手：既能回答学科知识、解题方法，也能闲聊式地提供学习建议与规划。
1. 回答准确、条理清晰，使用 Markdown，语气友好。
${refRules}
3. 数学/化学公式一律使用 LaTeX 语法：行内如 $a^2+b^2=c^2$，独立成行用 $$...$$，化学方程式用 $\\ce{...}$。
4. 不确定的内容如实说明，不要编造事实或数据。
5. 若提供了"用户学情"，你已具备调用该生系统数据的能力：请结合其薄弱点、错题、考试与复习状态给出个性化建议（如推荐复习的知识点、提醒记忆曲线复习），体现在回答末尾的"给你的建议"中。
${FIGURE_TOOL_DOC}
${TOOL_DOC}
${ctx.profile ? `\n${ctx.profile}` : ''}`
    },
    ...ctx.history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: `${hasRefs ? `参考资料：\n${context}\n\n` : ''}${ctx.refsContext ? ctx.refsContext.slice(2) + '\n\n' : ''}用户问题：${ctx.q}`
    }
  ];
}

export function buildAnswerResult(ctx, answer) {
  return {
    question: ctx.q,
    answer,
    relatedTree: ctx.tree,
    citations: ctx.citations,
    personalTip: ctx.personalTip,
    matchedChunks: ctx.hits.map((h) => ({
      chunkId: h.id,
      materialId: h.material_id,
      materialTitle: h.material_title,
      title: h.title,
      text: h.text.slice(0, 300),
      score: h.score,
      nodeName: h.node_name
    }))
  };
}

function offlineAnswer(ctx) {
  if (ctx.hits.length) {
    let answer = `（离线模式：未配置 AI 模型，以下为知识库检索结果摘要）\n\n${ctx.hits
      .slice(0, 3)
      .map((h, i) => `${i + 1}. ${h.text.slice(0, 150)}`)
      .join('\n\n')}`;
    if (ctx.personalTip) answer += `\n\n**学情提示**：${ctx.personalTip}`;
    return answer;
  }
  let answer = '我是你的智能学习助手。当前未配置 AI 模型，且知识库中没有与该问题相关的材料——请在"设置"中配置 AI，或先上传学习材料。';
  if (ctx.personalTip) answer += `\n\n**学情提示**：${ctx.personalTip}`;
  return answer;
}

export async function answerQuestion(question, userId = null, { history = [], conversationId = null, model = null, references = null } = {}) {
  const ctx = await prepareAnswerContext(question, { history, references });

  let answer;
  if (aiEnabled()) {
    const reply = await chat(buildAnswerMessages(ctx, model), { model });
    answer = reply.trim();
  } else {
    answer = offlineAnswer(ctx);
  }

  const result = buildAnswerResult(ctx, answer);
  logger.info(`智能问答: "${ctx.q.slice(0, 40)}" 命中 ${ctx.hits.length} 条片段${ctx.profile ? '（含学情上下文）' : ''}`);
  return result;
}

/**
 * 流式问答：先完成检索与上下文准备并回调 onMeta(ctx 摘要)，
 * 然后流式生成回答（onToken(delta, full)），结束后返回完整 result。
 * 未配置 AI 时降级为非流式离线回答（一次性 onToken 全文）。
 */
export async function answerQuestionStream(question, userId = null, { history = [], conversationId = null, model = null, references = null, signal = null, onMeta, onToken } = {}) {
  const ctx = await prepareAnswerContext(question, { history, references });
  onMeta?.({
    question: ctx.q,
    relatedTree: ctx.tree,
    citations: ctx.citations,
    personalTip: ctx.personalTip,
    matchedChunks: buildAnswerResult(ctx, '').matchedChunks
  });

  let answer;
  if (aiEnabled()) {
    answer = (await chatStream(buildAnswerMessages(ctx, model), { model, onToken, signal })).trim();
  } else {
    answer = offlineAnswer(ctx);
    onToken?.(answer, answer);
  }

  const result = buildAnswerResult(ctx, answer);
  logger.info(`智能问答(流式): "${ctx.q.slice(0, 40)}" 命中 ${ctx.hits.length} 条片段${ctx.profile ? '（含学情上下文）' : ''}`);
  return result;
}

function buildPersonalTip(matchedNodes) {
  if (!matchedNodes.length) return null;
  const ids = matchedNodes.map((n) => n.id);
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT n.name, m.correct, m.wrong, m.stage, m.last_review_at FROM mastery m
     JOIN knowledge_nodes n ON n.id = m.node_id WHERE m.wrong > 0 AND n.id IN (${ph})`
  ).all(...ids);
  if (!rows.length) return null;
  const withScore = rows.map((r) => ({ ...r, mastery: masteryScore(r) })).sort((a, b) => a.mastery - b.mastery);
  const worst = withScore[0];
  return `「${worst.name}」是你的薄弱知识点（掌握度 ${worst.mastery}%，曾错 ${worst.wrong} 次），建议结合错题本针对性复习，并到"练习中心"完成变式训练。`;
}

function collectNodes(question, hits) {
  const nodes = db.prepare('SELECT id, name, subject, category, description FROM knowledge_nodes').all();
  const matched = nodes.filter((n) => question.includes(n.name));
  const fromChunks = hits
    .filter((h) => h.node_name)
    .map((h) => nodes.find((n) => n.name === h.node_name))
    .filter(Boolean);
  const merged = new Map();
  for (const n of [...matched, ...fromChunks]) merged.set(n.id, n);
  return [...merged.values()].slice(0, 8);
}

function buildTree(nodes) {
  if (!nodes.length) return null;
  const bySubject = new Map();
  const nodeIds = nodes.map((n) => n.id);
  const ph = nodeIds.map(() => '?').join(',');
  const edges = db.prepare(
    `SELECT * FROM knowledge_edges WHERE source_id IN (${ph}) OR target_id IN (${ph})`
  ).all(...nodeIds, ...nodeIds);
  const nameOf = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();
  for (const e of edges) {
    if (!nameOf.has(e.source_id) || !nameOf.has(e.target_id)) continue;
    if (!childrenOf.has(e.source_id)) childrenOf.set(e.source_id, []);
    childrenOf.get(e.source_id).push({ node: nameOf.get(e.target_id), relation: e.relation });
  }
  for (const n of nodes) {
    const subj = n.subject || '未分类';
    if (!bySubject.has(subj)) bySubject.set(subj, []);
    bySubject.get(subj).push(n);
  }
  return {
    root: '关联知识点',
    children: [...bySubject.entries()].map(([subject, list]) => ({
      label: subject,
      children: list.map((n) => ({
        label: n.name,
        category: n.category,
        description: n.description,
        nodeId: n.id,
        relations: (childrenOf.get(n.id) || []).map((c) => ({
          relation: c.relation,
          target: c.node.name,
          nodeId: c.node.id
        }))
      }))
    }))
  };
}
