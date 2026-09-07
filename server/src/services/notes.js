/**
 * 学习笔记服务（v1.7.0）
 * ============================================================
 * 用户主动输入的笔记（自由文本录入 / 拍照上传）：
 *   拍照上传 → 视觉模型转写（OCR）→ 专用模型按"科学笔记方法"结构化
 *   → 可选抽取知识点并入知识图谱 / 一键存为脑图。
 * 支持四种科学笔记方法：
 *   mindmap 思维导图（层级树）/ cornell 康奈尔笔记（线索-正文-总结）
 *   outline 结构大纲（层级要点）/ flashcards 闪卡（问答对，可衔接练习）
 */
import path from 'node:path';
import fs from 'node:fs';
import { db } from '../db.js';
import { IMAGE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { aiEnabled, visionEnabled, chat, visionDescribe } from '../ai/client.js';
import { upsertNode, addEdge } from './graph.js';
import { subjectProfile } from './subjects.js';

export const NOTE_METHODS = ['mindmap', 'cornell', 'outline', 'flashcards'];

export function noteMethodLabel(method) {
  return { mindmap: '思维导图', cornell: '康奈尔笔记', outline: '结构大纲', flashcards: '闪卡' }[method] || method;
}

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

/** 视觉模型转写笔记照片（保留层级、公式转 LaTeX） */
async function ocrNoteImage(imagePath) {
  try {
    const buf = fs.readFileSync(path.join(IMAGE_DIR, imagePath));
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    return await visionDescribe(
      dataUrl,
      '这是一页学习笔记的照片。请完整转写其中的文字内容：保持原有的层级与编号结构（用缩进表达），公式转写为 LaTeX（$...$，化学式用 $\\ce{...}$），图表用【图：…】文字概括。只输出转写内容，不要评价。'
    );
  } catch (e) {
    logger.warn(`笔记图像识别失败: ${e.message}`);
    return null;
  }
}

function methodSpec(method) {
  switch (method) {
    case 'cornell':
      return `{"title":"笔记标题","cue":["左侧线索栏：针对笔记内容提出的问题或关键词，3-6条"],"notes":"主体笔记（Markdown，保留层级，公式用 LaTeX）","summary":"底部总结栏：3 句话以内概括核心"}`;
    case 'outline':
      return `{"title":"笔记标题","sections":[{"heading":"一级标题","points":["要点（公式用 LaTeX）"],"children":[{"heading":"二级标题","points":["要点"],"children":[]}]}]}`;
    case 'flashcards':
      return `{"title":"笔记标题","cards":[{"front":"问题/概念名","back":"答案/解释（公式用 LaTeX）"}]}`;
    case 'mindmap':
    default:
      return `{"title":"笔记标题","root":{"text":"中心主题","children":[{"text":"一级分支","children":[{"text":"子节点","note":"可选的补充说明","children":[]}]}]}}`;
  }
}

function structurePrompt(note, rawText, method, guide) {
  const profile = subjectProfile(note.subject);
  const subjectLine = note.subject ? `学科：${note.subject}（${profile.type}型知识）。该学科的笔记组织建议：${profile.noteMethodHint}；记忆要点：${profile.memoryHint}。` : '学科未知，按内容自行判断。';
  return [
    {
      role: 'system',
      content: `你是笔记整理专家，擅长把杂乱的笔记重整为科学的结构化笔记。请把下面的笔记内容整理为「${noteMethodLabel(method)}」，只输出 JSON：
${methodSpec(method)}

要求：
1. 忠于原笔记内容，可归纳、合并、补全层次，但不要编造原笔记没有的知识点；
2. ${subjectLine}
3. 数学/化学公式一律用 LaTeX（$...$ / $\\ce{...}$）。
不要输出 JSON 以外的内容。`
    },
    { role: 'user', content: `${rawText}${guide ? `\n\n用户整理引导：${guide}` : ''}` }
  ];
}

/** 离线降级：无 AI 时按空行/缩进做最简单的层级整理 */
function offlineStructure(rawText, method) {
  const lines = String(rawText || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const title = (lines[0] || '未命名笔记').replace(/^#+\s*/, '').slice(0, 40);
  if (method === 'flashcards') {
    const cards = [];
    for (let i = 0; i + 1 < lines.length; i += 2) cards.push({ front: lines[i].slice(0, 60), back: lines[i + 1].slice(0, 200) });
    return { title, cards: cards.length ? cards : [{ front: title, back: lines.slice(1).join(' ').slice(0, 200) || '（离线模式）' }] };
  }
  if (method === 'cornell') {
    return {
      title,
      cue: lines.slice(1, 5).map((l) => l.replace(/^[-*#\d.、\s]+/, '').slice(0, 24)),
      notes: lines.join('\n'),
      summary: lines.slice(1, 3).join('；').slice(0, 80) || '（离线模式：未配置 AI，仅做基础整理）'
    };
  }
  if (method === 'outline') {
    return {
      title,
      sections: lines.slice(0, 12).map((l) => ({ heading: l.replace(/^[-*#\d.、\s]+/, '').slice(0, 40) || l.slice(0, 40), points: [] }))
    };
  }
  const kids = lines.slice(0, 8).map((l) => ({ text: l.replace(/^[-*#\d.、\s]+/, '').slice(0, 40) || l.slice(0, 40), children: [] }));
  return { title, root: { text: title, children: kids } };
}

/** 从结构化结果中抽取知识点（名称+层级），供并入知识图谱 */
export function knowledgePointsFromStructure(structure, method) {
  const points = [];
  const push = (name, category, description) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (clean && clean.length >= 2 && clean.length <= 30 && !points.some((p) => p.name === clean)) {
      points.push({ name: clean, category, description: description || '' });
    }
  };
  if (!structure || typeof structure !== 'object') return points;
  if (method === 'mindmap' && structure.root) {
    push(structure.root.text, '主题');
    const walk = (node, parent) => {
      for (const c of node.children || []) {
        push(c.text, '概念', c.note || '');
        walk(c, node.text);
      }
    };
    walk(structure.root, null);
  } else if (method === 'outline' && Array.isArray(structure.sections)) {
    for (const s of structure.sections) {
      push(s.heading, '主题');
      for (const p of s.points || []) push(p, '要点');
      for (const sub of s.children || []) push(sub.heading, '概念');
    }
  } else if (method === 'cornell') {
    push(structure.title, '主题');
    for (const c of structure.cue || []) push(c, '线索');
  } else if (method === 'flashcards' && Array.isArray(structure.cards)) {
    for (const c of structure.cards.slice(0, 20)) push(c.front, '概念');
  }
  return points;
}

/** 将结构化笔记并入知识图谱：按层级建立"包含"关系边 */
export function mergeNoteIntoGraph(noteId, structure, method, subject) {
  if (!structure || typeof structure !== 'object') return 0;
  let count = 0;
  const link = (name, category, description, parentName = null) => {
    const id = upsertNode({
      name,
      subject: subject || null,
      category: category || '笔记',
      description: description || `由笔记#${noteId}整理`,
      materialId: null
    });
    if (id) {
      count++;
      if (parentName) {
        const parentId = upsertNode({ name: parentName, subject: subject || null, category: '主题' });
        if (parentId) addEdge(parentId, id, '包含', null);
      }
    }
    return id;
  };

  if (method === 'mindmap' && structure.root) {
    link(structure.root.text, '主题');
    const walk = (node, parentName) => {
      for (const c of node.children || []) {
        link(c.text, '概念', c.note, parentName);
        walk(c, c.text);
      }
    };
    walk(structure.root, structure.root.text);
  } else if (method === 'outline' && Array.isArray(structure.sections)) {
    for (const s of structure.sections) {
      link(s.heading, '主题');
      for (const sub of s.children || []) link(sub.heading, '概念', '', s.heading);
    }
  } else if (method === 'cornell') {
    const t = link(structure.title || '笔记', '主题');
    for (const c of structure.cue || []) {
      const id = upsertNode({ name: c, subject: subject || null, category: '线索', description: `由笔记#${noteId}整理` });
      if (id && t) addEdge(t, id, '包含', null);
    }
  } else if (method === 'flashcards' && Array.isArray(structure.cards)) {
    for (const c of structure.cards.slice(0, 20)) link(c.front, '概念');
  }
  return count;
}

/**
 * 笔记分析流水线：OCR（可选）→ 结构化 → 落库（→ 可选并入图谱）
 * method: mindmap | cornell | outline | flashcards
 */
export async function analyzeNote(id, { method, guide, mergeGraph = false } = {}) {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (!note) throw new Error('笔记不存在');
  const m = NOTE_METHODS.includes(method) ? method : (NOTE_METHODS.includes(note.note_method) ? note.note_method : 'mindmap');
  db.prepare("UPDATE notes SET status = 'analyzing', note_method = ?, updated_at = datetime('now') WHERE id = ?").run(m, id);

  try {
    let rawText = note.raw_text || '';
    if (note.image_path && (!rawText || rawText.trim().length < 10)) {
      if (visionEnabled()) {
        const ocr = await ocrNoteImage(note.image_path);
        if (ocr) {
          rawText = ocr;
          db.prepare("UPDATE notes SET raw_text = ?, updated_at = datetime('now') WHERE id = ?").run(ocr, id);
        }
      } else {
        logger.warn(`笔记 #${id} 未配置视觉模型，跳过 OCR`);
      }
    }

    let structure;
    if (aiEnabled() && rawText.trim()) {
      const reply = await chat(structurePrompt(note, rawText, m, guide), { temperature: 0.2 });
      structure = parseJSONLoose(reply);
      if (!structure) {
        logger.warn(`笔记 ${id} AI 返回无法解析，降级离线整理`);
        structure = offlineStructure(rawText, m);
      }
    } else {
      structure = offlineStructure(rawText, m);
    }

    // 结构合法性兜底：至少保留标题
    if (!structure || typeof structure !== 'object') structure = { title: note.title || '未命名笔记' };
    if (!structure.title) structure.title = note.title || '未命名笔记';

    let merged = 0;
    if (mergeGraph) {
      merged = mergeNoteIntoGraph(id, structure, m, note.subject);
    }

    db.prepare(
      `UPDATE notes SET
         title = ifnull(NULLIF(?, ''), title),
         raw_text = ifnull(NULLIF(?, ''), raw_text),
         structure = ?,
         graph_merged = ?,
         status = 'done',
         updated_at = datetime('now')
       WHERE id = ?`
    ).run(structure.title || '', rawText || '', JSON.stringify(structure), mergeGraph ? 1 : note.graph_merged ? 1 : 0, id);
    logger.info(`笔记 ${id} 分析完成：${noteMethodLabel(m)}，并入图谱 ${merged} 个知识点`);
    return { structure, method: m, merged };
  } catch (e) {
    db.prepare("UPDATE notes SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(id);
    logger.error(`笔记 ${id} 分析失败: ${e.message}`);
    throw e;
  }
}

/** 把 mindmap 结构的笔记保存为一张脑图（复用 mindmaps 表） */
export function saveNoteAsMindmap(id) {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (!note) throw new Error('笔记不存在');
  const structure = parseJSONLoose(note.structure);
  if (!structure?.root) throw Object.assign(new Error('该笔记尚无思维导图结构，请先用「思维导图」方法分析'), { status: 400 });
  const title = note.title || structure.title || `笔记#${id} 脑图`;
  const existing = db.prepare('SELECT id FROM mindmaps WHERE name = ?').get(title);
  if (existing) {
    db.prepare("UPDATE mindmaps SET content = ?, subject = ifnull(NULLIF(?,''), subject), updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(structure.root), note.subject || '', existing.id);
    return { id: existing.id, name: title, updated: true };
  }
  const info = db.prepare('INSERT INTO mindmaps (name, subject, content) VALUES (?, ?, ?)')
    .run(title, note.subject || null, JSON.stringify(structure.root));
  return { id: Number(info.lastInsertRowid), name: title, updated: false };
}
