import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { ROOT_DIR, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { aiEnabled, visionEnabled, aiModifySubGraphsEnabled, chat, embedBatch, visionDescribe } from '../ai/client.js';
import { upsertNode, addEdge, ensureSubGraph, findNodeIdByName, graphContextForAI, subGraphsContextForAI, mergeGraphNode } from './graph.js';
import { splitChunks, extractKeywords, sentencesOf } from './textutil.js';
import { upsertVector } from './vectorStore.js';

const SUBJECTS = ['数学', '物理', '化学', '生物', '语文', '英语', '历史', '地理', '政治', '综合', '其他'];
// 知识节点允许的科目取值：材料科目 + “公共”（跨科目通用的方法/注意事项等）
const NODE_SUBJECTS = [...SUBJECTS, '公共'];
const KINDS = ['题目', '笔记', '知识点总结', '教材章节', '其他'];

function updateJob(jobId, patch) {
  const fields = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE analysis_jobs SET ${fields}, updated_at = datetime('now') WHERE id = ?`)
    .run(...Object.values(patch), jobId);
}

// ---- 材料分析实时输出（jobId -> 流水线日志，内存缓冲，进程内共享）----
// 供「分析任务 → 实时输出」面板轮询查看 AI 逐步骤产出（步骤进展 + AI 实际输出片段）。
const jobTrace = new Map();
export function getJobTrace(jobId) {
  return jobTrace.get(Number(jobId)) || [];
}
export function clearJobTrace(jobId) {
  jobTrace.delete(Number(jobId));
}
function trace(jobId, kind, text) {
  try {
    const arr = jobTrace.get(Number(jobId)) || [];
    arr.push({ t: new Date().toISOString(), kind, text });
    if (arr.length > 600) arr.shift();
    jobTrace.set(Number(jobId), arr);
  } catch {
    /* 实时输出不影响分析主流程 */
  }
}
function traceStep(jobId, step) {
  trace(jobId, 'step', step);
}

export function createJob(materialId, batchId = null) {
  const info = db.prepare('INSERT INTO analysis_jobs (material_id, status, step, batch_id) VALUES (?, ?, ?, ?)')
    .run(materialId, 'queued', '排队中', batchId);
  const jobId = Number(info.lastInsertRowid);
  clearJobTrace(jobId);
  traceStep(jobId, '任务已创建，进入排队');
  return jobId;
}

export function runAnalysis(materialId, jobId, guide = '', opts = {}) {
  setImmediate(() => analyze(materialId, jobId, guide, opts).catch((e) => {
    logger.error(`分析任务 ${jobId} 异常: ${e.message}`);
    trace(jobId, 'error', `分析失败：${e.message}`);
    updateJob(jobId, { status: 'failed', message: e.message });
    db.prepare(`UPDATE materials SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(materialId);
  }));
}

// ---------- 批量分析：多份材料一次提交，AI 逐份串行处理（分批），全部完成后统一汇总 ----------
export function runBatchAnalysis(batchId, items, guide = '') {
  setImmediate(() => processBatch(batchId, items, guide).catch((e) => {
    logger.error(`批量分析 ${batchId} 异常: ${e.message}`);
    db.prepare(`UPDATE analysis_batches SET status = 'failed', summary = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(`批量分析异常终止：${e.message}`, batchId);
  }));
}

async function processBatch(batchId, items, guide) {
  for (let i = 0; i < items.length; i++) {
    const { materialId, jobId, opts } = items[i];
    logger.info(`批量分析 ${batchId}：开始第 ${i + 1}/${items.length} 份（材料 ${materialId}）`);
    try {
      await analyze(materialId, jobId, guide, opts || {});
      db.prepare(`UPDATE analysis_batches SET done_count = done_count + 1, updated_at = datetime('now') WHERE id = ?`).run(batchId);
    } catch (e) {
      logger.error(`批量分析 ${batchId}：材料 ${materialId} 失败: ${e.message}`);
      updateJob(jobId, { status: 'failed', message: e.message });
      db.prepare(`UPDATE materials SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(materialId);
      db.prepare(`UPDATE analysis_batches SET failed_count = failed_count + 1, updated_at = datetime('now') WHERE id = ?`).run(batchId);
    }
  }
  const materialIds = items.map((it) => it.materialId);
  const summary = await summarizeBatch(batchId, materialIds, guide);
  db.prepare(`UPDATE analysis_batches SET status = 'done', summary = ?, updated_at = datetime('now') WHERE id = ?`).run(summary, batchId);
  logger.info(`批量分析 ${batchId} 完成（${items.length} 份），统一汇总已生成`);
}

// 批次统一汇总：基于各材料已生成的概览，AI 合并为一段整体汇总；离线降级为拼接
async function summarizeBatch(batchId, materialIds, guide = '') {
  const ph = materialIds.map(() => '?').join(',');
  const mats = db.prepare(`SELECT id, title, subject, summary, status FROM materials WHERE id IN (${ph})`).all(...materialIds);
  const okMats = mats.filter((m) => m.status === 'done' && m.summary);
  if (!okMats.length) {
    return `本批次 ${mats.length} 份材料均未成功分析，请在任务列表查看失败原因后重试。`;
  }
  if (!aiEnabled()) {
    return `本次共分析 ${okMats.length} 份材料：${okMats.map((m) => `《${m.title}》`).join('、')}。（未配置 AI，统一汇总降级为列表，详见各材料概览）`;
  }
  try {
    const reply = await chat([
      {
        role: 'system',
        content: '你是学习资料分析助手。用户刚批量分析了多份学习材料，请根据各材料的概览生成一段 150~300 字的统一汇总：整体内容概况、共同主题与知识主线、跨材料的关联点、后续学习建议。只输出汇总文本本身，不要标题、不要 Markdown 标记。'
      },
      {
        role: 'user',
        content: `本批次材料（共 ${okMats.length} 份）：\n${okMats.map((m, i) => `${i + 1}. 《${m.title}》（${m.subject || '未分科'}）：${m.summary}`).join('\n')}${guide ? `\n\n用户分析引导：${guide}` : ''}`
      }
    ]);
    return reply.trim();
  } catch (e) {
    logger.warn(`批量分析 ${batchId} 统一汇总生成失败，降级为列表: ${e.message}`);
    return `本次共分析 ${okMats.length} 份材料：${okMats.map((m) => `《${m.title}》`).join('、')}。（AI 汇总生成失败，详见各材料概览）`;
  }
}

async function analyze(materialId, jobId, guide = '', opts = {}) {
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
  if (!material) throw new Error('材料不存在');
  db.prepare(`UPDATE materials SET status = 'analyzing', updated_at = datetime('now') WHERE id = ?`).run(materialId);
  updateJob(jobId, { status: 'running', progress: 5, step: '开始分析' });
  traceStep(jobId, `开始分析《${material.title || `材料 #${materialId}`}》`);

  const useAI = aiEnabled();
  if (!useAI) {
    logger.warn(`材料 ${materialId} 使用离线启发式分析（未配置 AI API Key）`);
  }

  updateJob(jobId, { progress: 10, step: '图片识别' });
  const { enrichedContent, imageCount, describedCount, reusedCount, skippedCount } = await enrichWithVision(materialId, material, jobId, opts);
  trace(jobId, 'step', `图片识别完成：${imageCount} 张${describedCount ? `（新识别 ${describedCount}）` : ''}${reusedCount ? `（复用 ${reusedCount}）` : ''}${skippedCount ? `（跳过 ${skippedCount}）` : ''}`);

  // 纯图片材料保护：视觉分析是最先执行的步骤；若图片全部未识别成功则明确提示，避免后续步骤基于空文本乱猜
  const meaningfulText = enrichedContent
    .replace(/【图片内容分析】[\s\S]*$/, '')
    .replace(/\[图片\d+\][：:][^\n]*/g, '')
    .replace(/\[图片\d+\]/g, '')
    .trim();
  if (imageCount > 0 && describedCount === 0 && reusedCount === 0 && meaningfulText.length < 20) {
    if (Array.isArray(opts.imageIds) && opts.imageIds.length === 0) {
      throw new Error('该材料仅包含图片，且未选择任何参与识别的图片；请至少勾选一张图片后重新分析');
    }
    if (!visionEnabled()) {
      throw new Error('该材料仅包含图片且未配置视觉分析模型（设置 → 视觉分析模型），无法识别图片内容；请配置后重新分析');
    }
    logger.warn(`材料 ${materialId} 图片视觉识别全部失败，后续步骤将基于有限文本进行`);
    updateJob(jobId, { message: '提示：图片视觉识别失败，结果可能不完整' });
  }

  // ---------- 步骤 2：生成概览 ----------
  updateJob(jobId, { progress: 25, step: '生成概览' });
  const summary = useAI ? await smartSummarize(material.title, enrichedContent, jobId) : fallbackSummary({ ...material, content: enrichedContent });
  trace(jobId, 'ai', `概览（AI 输出）：${summary.trim().slice(0, 300)}`);
  db.prepare('UPDATE materials SET summary = ?, updated_at = datetime(\'now\') WHERE id = ?').run(summary, materialId);

  // ---------- 步骤 3：知识抽取 ----------
  // 子网策略（设置 → AI 设置 → 允许 AI 直接修改现有子网）：
  // - 开启：注入已有知识图谱（知识点+子网），由 AI 自行判断"并入已有子网"还是"新建子网"；
  // - 关闭：不注入已有图谱，每次分析都为材料新建独立子网，不改动任何已有子网。
  const modifySubGraphs = aiModifySubGraphsEnabled();
  const graphContext = useAI && modifySubGraphs ? graphContextForAI() : null;
  if (useAI && modifySubGraphs) {
    updateJob(jobId, {
      message: graphContext
        ? '已载入现有知识图谱，AI 将自行判断并入已有子网或新建子网'
        : '图谱暂无已有内容，本次将按材料主题新建子网（后续分析可并入已有子网）'
    });
  } else if (useAI) {
    updateJob(jobId, { message: '子网模式：每次分析新建独立子网（设置中已关闭"允许 AI 直接修改现有子网"）' });
  }
  updateJob(jobId, { progress: 40, step: '知识抽取' });
  // 分类已调整到内容分析完成后进行，抽取阶段仅以用户预设科目作兜底
  const presetSubject = material.subject || null;
  let extraction;
  if (useAI) {
    extraction = await smartExtract(material.title, enrichedContent, presetSubject, guide, jobId, graphContext);
  } else {
    extraction = fallbackExtract({ ...material, content: enrichedContent });
  }
  trace(jobId, 'ai',
    `知识抽取：${extraction.nodes.length} 个知识点（${extraction.nodes.slice(0, 40).map((n) => n.name).join('、')}${extraction.nodes.length > 40 ? '…' : ''}），${extraction.edges.length} 条关系，${(extraction.subGraphs || []).length} 个子知识网`);

  // ---------- 步骤 4：并入知识图谱 ----------
  updateJob(jobId, { progress: 55, step: '并入知识图谱' });
  const nodeIdMap = new Map();
  for (const n of extraction.nodes) {
    // 科目不再按材料预先隔离：优先采用 AI 为每个节点标注的科目；
    // 跨科目通用节点（做题方法、注意事项等）AI 会标注为"公共"；无法识别时回退用户预设科目（可空，分类后回填）
    const nodeSubject = NODE_SUBJECTS.includes(n.subject) ? n.subject : presetSubject;
    const id = upsertNode({
      name: n.name,
      subject: nodeSubject,
      // 分类（含分册判定）后置，此处仅用用户预设分册，分类结果在步骤 6 回填
      volume: material.volume || null,
      category: n.category || '概念',
      description: n.description || null,
      materialId
    });
    if (id) nodeIdMap.set(normName(n.name), id);
  }
  let edgeCount = 0;
  let linkedExisting = 0;
  for (const e of extraction.edges) {
    let s = nodeIdMap.get(normName(e.source));
    let t = nodeIdMap.get(normName(e.target));
    // 端点未出现在本次抽取结果中时，按名字解析已有图谱节点——使新材料能连接到已有知识网络
    if (!s) { s = findNodeIdByName(e.source, presetSubject); if (s) linkedExisting++; }
    if (!t) { t = findNodeIdByName(e.target, presetSubject); if (t) linkedExisting++; }
    if (s && t && addEdge(s, t, e.relation, materialId)) edgeCount++;
  }
  const createdSubGraphIds = [];
  const touchedSubGraphIds = [];
  for (const sg of extraction.subGraphs || []) {
    const memberIds = (sg.nodes || [])
      .map((name) => nodeIdMap.get(normName(name)) || findNodeIdByName(name, presetSubject))
      .filter(Boolean);
    // forceNew：关闭"允许 AI 修改现有子网"时不按名称复用已有子网，每次分析都新建独立子网；
    // 开启时仍按名称复用——同主题材料并入同一子网，是否同主题由 AI 在抽取时自行判断
    const ensured = ensureSubGraph(sg.name, materialId, memberIds, sg.description || null, { forceNew: !modifySubGraphs });
    if (ensured) {
      touchedSubGraphIds.push(ensured.id);
      if (ensured.created) createdSubGraphIds.push(ensured.id);
    }
  }
  logger.info(`材料 ${materialId} 图谱合并完成: 节点 ${nodeIdMap.size}，新增边 ${edgeCount}${linkedExisting ? `（其中 ${linkedExisting} 个端点连接到已有知识点）` : ''}，子网新建 ${createdSubGraphIds.length}/${touchedSubGraphIds.length}`);

  // ---------- 步骤 5：图谱结构优化（生成后由 AI 再次审查：去重/改名/边修剪/子网拆分合并） ----------
  if (useAI) {
    updateJob(jobId, { progress: 68, step: '图谱结构优化' });
    try {
      const stats = await optimizeGraphStructure(materialId, material.title, extraction, nodeIdMap, touchedSubGraphIds, createdSubGraphIds, {
        modifySubGraphs,
        subject: presetSubject
      });
      updateJob(jobId, { message: `图谱结构优化完成：${stats.text}` });
      trace(jobId, 'ai', `图谱结构优化：${stats.text}`);
      logger.info(`材料 ${materialId} 图谱结构优化: ${stats.text}`);
    } catch (e) {
      logger.warn(`材料 ${materialId} 图谱结构优化失败（保留原结构）: ${e.message}`);
      updateJob(jobId, { message: `提示：图谱结构优化失败（${e.message}），已保留原结构` });
    }
  }

  // ---------- 步骤 6：材料分类（放在最后） ----------
  // 基于已分析出的概览 / 知识点 / 子网等实际内容分类，而不是在分析前只看标题瞎猜
  updateJob(jobId, { progress: 82, step: '材料分类' });
  let classification;
  if (useAI) {
    classification = await classify(material.title, enrichedContent, guide, { summary, extraction });
  } else {
    classification = fallbackClassify({ ...material, content: enrichedContent });
  }
  const subject = material.subject || classification.subject || '其他';
  const volume2 = material.volume || classification.volume || null;
  const kind = material.kind || classification.kind || '其他';
  trace(jobId, 'ai', `材料分类：科目「${subject}」${volume2 ? `分册「${volume2}」` : ''}类型「${kind}」${(classification.logicalParts || []).length ? `（含 ${classification.logicalParts.length} 个逻辑部分）` : ''}`);
  db.prepare('UPDATE materials SET subject = ?, volume = ?, kind = ?, meta = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(subject, volume2, kind, JSON.stringify({ logicalParts: classification.logicalParts || [], imageCount }), materialId);
  // 科目/分册回填：本次材料新建但尚未定科目（或分册）的节点，按分类结果补齐（撞上已有同名节点时自动合并）
  backfillNodeSubjects(materialId, subject, volume2);
  logger.info(`材料 ${materialId} 分类完成: ${subject}/${volume2 || '-'}/${kind}`, classification.logicalParts?.length ? { parts: classification.logicalParts.length } : undefined);

  // ---------- 步骤 7：向量化 ----------
  updateJob(jobId, { progress: 90, step: '向量化' });
  const chunks = splitChunks(enrichedContent).map((text, i) => {
    const partMatch = (classification.logicalParts || []).find((p) => p.title && text.includes(p.title));
    return { title: partMatch?.title || `片段${i + 1}`, text };
  });
  db.prepare('DELETE FROM chunks WHERE material_id = ?').run(materialId);
  const insertChunk = db.prepare('INSERT INTO chunks (material_id, title, text, embedding) VALUES (?, ?, ?, ?)');
  const chunkRows = [];
  for (const c of chunks) {
    const info = insertChunk.run(materialId, c.title, c.text, null);
    chunkRows.push({ id: Number(info.lastInsertRowid), text: c.text });
  }
  if (useAI && chunkRows.length) {
    try {
      for (let i = 0; i < chunkRows.length; i += 16) {
        const batch = chunkRows.slice(i, i + 16);
        const vectors = await embedBatch(batch.map((c) => c.text.slice(0, 2000)));
        batch.forEach((c, j) => {
          const vec = vectors[j];
          if (vec) {
            db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(JSON.stringify(vec), c.id);
            upsertVector(c.id, vec);
          }
        });
      }
    } catch (e) {
      logger.warn(`材料 ${materialId} 向量化失败（不影响图谱）: ${e.message}`);
    }
  }

  const imageNote = imageCount
    ? `，图片 ${imageCount} 张${describedCount ? `（新识别 ${describedCount}）` : ''}${reusedCount ? `（复用已有识别 ${reusedCount}）` : ''}${skippedCount ? `（未参与识别 ${skippedCount}）` : ''}`
    : '';
  updateJob(jobId, { status: 'done', progress: 100, step: '完成', message: `知识点 ${nodeIdMap.size}，关系 ${edgeCount}，子知识网新建 ${createdSubGraphIds.length}，片段 ${chunkRows.length}${imageNote}` });
  traceStep(jobId, `分析完成：知识点 ${nodeIdMap.size}，关系 ${edgeCount}，子知识网新建 ${createdSubGraphIds.length}，片段 ${chunkRows.length}`);
  db.prepare(`UPDATE materials SET status = 'done', updated_at = datetime('now') WHERE id = ?`).run(materialId);
  logger.info(`材料 ${materialId} 分析完成`);
}

async function enrichWithVision(materialId, material, jobId, opts = {}) {
  const rows = db.prepare('SELECT * FROM material_images WHERE material_id = ? ORDER BY id').all(materialId);
  if (!rows.length) {
    updateJob(jobId, { step: '图片识别（本材料无图片）' });
    return { enrichedContent: material.content, imageCount: 0, describedCount: 0, reusedCount: 0, skippedCount: 0 };
  }

  const useVision = visionEnabled();
  // 图片识别控制：
  // - opts.imageIds:          [图片id...] 用户选定"参与识别"的照片集合（启动分析时勾选）；
  //                           未提供 = 全部图片参与。未选中的图片：已有结果照常复用，无结果则跳过不识别
  // - opts.reanalyzeImageIds: 仅强制重新识别指定 id 的图片（用户逐张勾选，避免影响其他正常图片）
  // - opts.reanalyzeImages:   全部强制重新识别（默认均复用已有识别结果，节省 token）
  const selectedIds = Array.isArray(opts.imageIds) ? new Set(opts.imageIds.map(Number)) : null;
  const forceIds = Array.isArray(opts.reanalyzeImageIds) ? new Set(opts.reanalyzeImageIds) : null;
  const forceAll = !!opts.reanalyzeImages;
  const inSelection = (row) => !selectedIds || selectedIds.has(row.id);
  const shouldForce = (row) => forceAll || (forceIds ? forceIds.has(row.id) : false);
  let content = material.content;
  const appendix = [];
  let describedCount = 0;
  let reusedCount = 0;
  let skippedCount = 0;

  const selectedRows = rows.filter(inSelection);
  const pendingSelected = selectedRows.filter((r) => !r.description || shouldForce(r)).length;
  const skippedNoDesc = rows.filter((r) => !inSelection(r) && !r.description).length;

  if (!useVision) {
    updateJob(jobId, {
      step: '图片识别（已跳过）',
      message: `本材料含 ${rows.length} 张图片，但未配置视觉分析模型，图片内容未识别（设置 → 视觉分析模型）`
    });
    logger.warn(`材料 ${materialId} 含 ${rows.length} 张图片，未配置视觉模型，图片内容未注入分析上下文`);
  } else {
    updateJob(jobId, {
      step: '图片识别',
      message: forceAll
        ? `共 ${rows.length} 张图片，应用户要求全部重新识别`
        : selectedIds
          ? `共 ${rows.length} 张图片：用户选定 ${selectedRows.length} 张参与识别（其中待识别 ${pendingSelected} 张），未选定 ${rows.length - selectedRows.length} 张${skippedNoDesc ? `（其中 ${skippedNoDesc} 张无识别结果，将跳过）` : '（复用已有结果）'}`
          : forceIds && forceIds.size
            ? `共 ${rows.length} 张图片：用户指定重新识别 ${forceIds.size} 张，其余复用已有结果`
            : pendingSelected
              ? `共 ${rows.length} 张图片：待识别 ${pendingSelected} 张，复用已有识别结果 ${rows.length - pendingSelected} 张`
              : `共 ${rows.length} 张图片，全部复用已有识别结果（不消耗 token）`
    });
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let description = row.description;
    const forced = shouldForce(row);
    const selected = inSelection(row);
    const needAnalyze = selected && (forced || !description);
    if (needAnalyze && useVision) {
      try {
        updateJob(jobId, {
          step: `正在识别图片 ${i + 1}/${rows.length}（视觉模型${forced && description ? '·重新识别' : ''}）`,
          message: `AI 正在分析图片 ${i + 1}/${rows.length}，请稍候…`
        });
        // file_path 相对 DATA_DIR 存储（如 images/m1/1.png），兼容带 data/ 前缀的历史数据
        const filePath = row.file_path.startsWith('data/')
          ? path.join(ROOT_DIR, row.file_path)
          : path.join(DATA_DIR, row.file_path);
        const buf = fs.readFileSync(filePath);
        const dataUrl = `data:${row.content_type};base64,${buf.toString('base64')}`;
        description = await visionDescribe(dataUrl, row.note || '');
        db.prepare('UPDATE material_images SET description = ? WHERE id = ?').run(description, row.id);
        describedCount++;
      } catch (e) {
        logger.warn(`材料 ${materialId} 图片 ${row.id} 视觉分析失败: ${e.message}`);
        updateJob(jobId, { message: `图片 ${i + 1}/${rows.length} 识别失败：${e.message}` });
      }
    } else if (!selected && !description) {
      // 未选参与识别且无已有结果：跳过
      skippedCount++;
      updateJob(jobId, { step: `图片识别 ${i + 1}/${rows.length}（未选参与识别，跳过）` });
    } else if (!needAnalyze) {
      reusedCount++;
      updateJob(jobId, { step: `图片识别 ${i + 1}/${rows.length}（复用已有结果）` });
    }
    if (description) {
      const marker = row.placeholder || `[图片${i + 1}]`;
      if (content.includes(marker)) {
        content = content.replace(marker, `${marker}：${description}`);
      } else {
        appendix.push(`${marker}：${description}`);
      }
    }
  }

  if (appendix.length) content += `\n\n【图片内容分析】\n${appendix.join('\n')}`;
  if (useVision) {
    updateJob(jobId, {
      step: '图片识别完成',
      message: `图片识别完成：新识别 ${describedCount} 张${reusedCount ? `，复用 ${reusedCount} 张` : ''}${skippedCount ? `，未参与识别 ${skippedCount} 张` : ''}（共 ${rows.length} 张）`
    });
    logger.info(`材料 ${materialId} 图片识别完成: 新识别 ${describedCount}/${rows.length}，复用 ${reusedCount} 张，跳过 ${skippedCount} 张`);
  }
  return { enrichedContent: content, imageCount: rows.length, describedCount, reusedCount, skippedCount };
}

function normName(name) {
  return String(name || '').trim().toLowerCase();
}

function stripFences(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

function parseLLMJSON(text) {
  try {
    return JSON.parse(stripFences(text));
  } catch {
    throw new Error('AI 返回内容无法解析为 JSON，请重试或检查模型配置');
  }
}

/**
 * 材料分类（流水线最后一步）：基于"已分析出的实际内容"（概览 + 抽取的知识点/子网）分类，
 * 而不是在分析前只凭标题猜测。analyzed 为空时退化为纯内容分类（离线/兜底场景）。
 */
async function classify(title, content, guide = '', analyzed = null) {
  const body = content.slice(0, 2500);
  const nodeNames = (analyzed?.extraction?.nodes || []).map((n) => String(n?.name || '').trim()).filter(Boolean).slice(0, 60);
  const sgNames = (analyzed?.extraction?.subGraphs || []).map((s) => String(s?.name || '').trim()).filter(Boolean).slice(0, 20);
  const analyzedSection = analyzed
    ? `
【已分析出的内容（请以此为分类依据，权重高于标题）】
内容概览：${analyzed.summary || '（无）'}
已提取知识点（${nodeNames.length} 个）：${nodeNames.join('、') || '（无）'}
已建子知识网：${sgNames.join('、') || '（无）'}
`
    : '';
  const reply = await chat([
    {
      role: 'system',
      content: `你是学习资料分类助手。该材料已完成内容概览与知识抽取，请根据"已分析出的实际内容"判断材料分类（标题可能有误导性，不要只看标题），只输出 JSON，格式：
{"subject":"${SUBJECTS.join('|')}"之一,"volume":"分册或教材模块，如'必修一'，无法判断则为空字符串","kind":"${KINDS.join('|')}"之一,"logicalParts":[{"title":"逻辑部分标题","summary":"一句话概括"}]}
logicalParts 提取材料中的方法、规律、总结等逻辑部分，2-6 个。
注意：一份材料可能同时包含多个科目的内容，若明显跨多个科目，subject 填"综合"，不要强行归入单一科目。不要输出 JSON 以外的内容。`
    },
    { role: 'user', content: `标题：${title}\n${analyzedSection}\n材料内容（节选）：\n${body}${guide ? `\n\n用户分析引导：${guide}` : ''}` }
  ], { temperature: 0.1 });
  const data = parseLLMJSON(reply);
  if (!SUBJECTS.includes(data.subject)) data.subject = '其他';
  if (!KINDS.includes(data.kind)) data.kind = '其他';
  data.logicalParts = Array.isArray(data.logicalParts) ? data.logicalParts.filter((p) => p?.title) : [];
  return data;
}

async function summarize(title, content) {
  const body = content.slice(0, 4000);
  const reply = await chat([
    { role: 'system', content: '你是学习资料分析助手。用 100~200 字中文概括材料的核心内容、涉及的主要知识点与适用场景。材料中如有"【图片内容分析】"，也纳入概括。只输出概括文本。' },
    { role: 'user', content: `标题：${title}\n\n材料内容：\n${body}` }
  ]);
  return reply.trim();
}

// ---------- 大文件分段策略：逐段小结 → 合并总概览，避免一次性超长导致失败 ----------
const LONG_SUMMARY_THRESHOLD = 4000;
const LONG_EXTRACT_THRESHOLD = 6000;

async function smartSummarize(title, content, jobId) {
  if (content.length <= LONG_SUMMARY_THRESHOLD) return summarize(title, content);
  const parts = splitChunks(content, { maxLen: 2500 }).slice(0, 8);
  logger.info(`材料《${title}》较长(${content.length} 字)，概览拆分为 ${parts.length} 段处理`);
  const partSummaries = [];
  for (let i = 0; i < parts.length; i++) {
    updateJob(jobId, { step: `分段概览 ${i + 1}/${parts.length}` });
    try {
      const reply = await chat([
        { role: 'system', content: '你是学习资料分析助手。这是一份较长材料的其中一部分。用 60~120 字中文概括这部分的核心内容与涉及的知识点。只输出概括文本。' },
        { role: 'user', content: `标题：${title}\n\n第 ${i + 1}/${parts.length} 部分内容：\n${parts[i]}` }
      ]);
      partSummaries.push(reply.trim());
    } catch (e) {
      logger.warn(`材料《${title}》分段概览失败(${i + 1}/${parts.length}): ${e.message}`);
      partSummaries.push(parts[i].replace(/\s+/g, ' ').slice(0, 80));
    }
  }
  updateJob(jobId, { step: '汇总概览' });
  if (partSummaries.length <= 1) return partSummaries[0] || '';
  try {
    const reply = await chat([
      { role: 'system', content: '你是学习资料分析助手。下面是一份长材料各部分的小结，请合并为一段 100~200 字的整体概览：突出核心内容、主要知识点与适用场景。只输出概览文本。' },
      { role: 'user', content: `标题：${title}\n\n各部分小结：\n${partSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}` }
    ]);
    return reply.trim();
  } catch (e) {
    logger.warn(`材料《${title}》概览合并失败，直接拼接: ${e.message}`);
    return partSummaries.join('；').slice(0, 400);
  }
}

async function smartExtract(title, content, subject, guide, jobId, graphContext = null) {
  if (content.length <= LONG_EXTRACT_THRESHOLD) return extractKnowledge(title, content, subject, guide, graphContext);
  const parts = splitChunks(content, { maxLen: 3500 }).slice(0, 6);
  logger.info(`材料《${title}》较长(${content.length} 字)，知识抽取拆分为 ${parts.length} 段处理`);
  const merged = { nodes: [], edges: [], subGraphs: [] };
  const seenNodes = new Map();
  for (let i = 0; i < parts.length; i++) {
    updateJob(jobId, { step: `分段知识抽取 ${i + 1}/${parts.length}` });
    try {
      const part = await extractKnowledge(title, parts[i], subject, guide, graphContext);
      for (const n of part.nodes) {
        const key = `${normName(n.name)}|${String(n.subject || '').trim()}`;
        if (!seenNodes.has(key)) {
          seenNodes.set(key, n);
          merged.nodes.push(n);
        } else {
          const cur = seenNodes.get(key);
          if (String(n.description || '').length > String(cur.description || '').length) cur.description = n.description;
        }
      }
      merged.edges.push(...part.edges);
      merged.subGraphs.push(...part.subGraphs);
    } catch (e) {
      logger.warn(`材料《${title}》分段知识抽取失败(${i + 1}/${parts.length}): ${e.message}`);
    }
  }
  const seenEdges = new Set();
  merged.edges = merged.edges.filter((e) => {
    const key = `${normName(e.source)}|${normName(e.target)}|${String(e.relation || '')}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });
  const seenSg = new Set();
  merged.subGraphs = merged.subGraphs.filter((s) => {
    const key = normName(s.name);
    if (seenSg.has(key)) return false;
    seenSg.add(key);
    return true;
  });
  return merged;
}

async function extractKnowledge(title, content, subject, guide = '', graphContext = null) {
  const body = content.slice(0, 6000);
  // 已有图谱上下文：让 AI 复用已有节点名、连接已有知识点；子网去留由 AI 按主题独立判断
  const graphSection = graphContext
    ? `
【已有知识图谱（抽取前必读）】
${graphContext}

图谱连接要求（非常重要）：
6. 若材料中的知识点与上方"已有知识点"中的某个相同或等价，nodes 中必须输出与已有完全一致的名字（系统按"名字+科目"自动合并为同一节点），严禁另起近似名造成重复节点。
7. edges 的 source/target 允许直接引用已有知识点的名字（即使该名字未出现在本次 nodes 中）。请尽量让新知识点与已有知识点建立关联，使本材料融入现有图谱而不是孤立存在。
8. subGraphs 子网归属（请逐个主题独立判断，不要盲目合并，也不要盲目新建）：
   - 仅当本材料某主题与某个已有子网的主题实质相同（同一章节/同一题型/同一知识专题，且本材料是它的延续、补充、练习或同套内容）时，才直接输出该已有子网的完全一致名称，把新成员并入该子网；
   - 主题不同、只是松散相关、或本材料属于新章节/新试卷/新专题时，必须新建子网并起一个准确概括主题的新名字，严禁把不相关的内容塞进已有子网使其无限膨胀；
   - 拿不准时倾向于新建子网。每个子网应聚焦一个明确主题。`
    : '';
  const subjectHint = subject
    ? `无法判断时可参考当前科目：${subject}。`
    : '确实无法判断时可留空，系统会在分类后补齐。';
  const reply = await chat([
    {
      role: 'system',
      content: `你是知识图谱构建专家。请认真细致地从学习材料中提取知识点及其关联，只输出 JSON：
{
 "nodes":[{"name":"知识点名(简洁唯一)","subject":"该知识点所属科目","category":"概念|方法|规律|公式|定理|题型|总结","description":"不超过50字的说明"}],
 "edges":[{"source":"知识点名","target":"知识点名","relation":"如 属于|包含|应用于|推导自|前置知识|用于求解|相关"}],
 "subGraphs":[{"name":"按题目或主题命名的子知识网名","description":"简述","nodes":["成员知识点名"]}]
}
要求：
1. 知识点命名准确、避免歧义；edges 的 source/target 必须是本次 nodes 中出现的名字，或【已有知识图谱】中已存在的知识点名。
2. 关联必须基于材料内容，宁缺毋滥，避免错误关联。
3. 每道题目或每个主题构建一个 subGraph，子网名简洁准确地概括其主题${graphContext ? '（与已有子网的关系按下方第 8 条判断）' : ''}。
4. 每个节点的 subject 必须从以下取值中选择：${NODE_SUBJECTS.join('|')}。
   - 材料可能包含多个科目的内容，不要预先隔离科目，请根据每个知识点的内容逐个判断其所属科目；
   - 做题方法、注意事项、学习习惯、考试技巧等跨多个科目通用的节点，subject 填"公共"；
   - ${subjectHint}
5. 材料中如有"【图片内容分析】"，同样作为知识来源提取。描述中的数学/化学公式请使用 LaTeX 语法（数学如 $F=ma$，化学如 $\\ce{2H2 + O2 -> 2H2O}$）。不要输出 JSON 以外的内容。${graphSection}`
    },
    { role: 'user', content: `标题：${title}\n\n材料内容：\n${body}${guide ? `\n\n用户分析引导：${guide}` : ''}` }
  ], { temperature: 0.2 });
  const data = parseLLMJSON(reply);
  return {
    nodes: (data.nodes || []).filter((n) => n?.name),
    edges: (data.edges || []).filter((e) => e?.source && e?.target),
    subGraphs: (data.subGraphs || []).filter((s) => s?.name)
  };
}

// ---------- 生成后结构优化：图谱写入后，再由 AI 审查一遍结构并做去冗/纠偏 ----------
// 输入本次分析涉及的节点与子网现状，AI 输出结构化"修订操作"，系统安全地应用。
// 该步骤失败不影响主流程（analyze 中已 try/catch）。
export async function optimizeGraphStructure(materialId, title, extraction, nodeIdMap, touchedSubGraphIds, createdSubGraphIds, opts = {}) {
  const { modifySubGraphs = true, subject = null } = opts;
  // 本次涉及的节点（以图谱中实际存在的为准）
  const nodeIds = [...new Set([...nodeIdMap.values()])];
  if (!nodeIds.length) return summarizeNoop('无节点，跳过结构优化');

  const ph = nodeIds.map(() => '?').join(',');
  const nodeRows = db.prepare(`SELECT id, name, subject, category, description FROM knowledge_nodes WHERE id IN (${ph})`).all(...nodeIds);
  const nameById = new Map(nodeRows.map((r) => [r.id, r.name]));

  // 本次涉及的边（端点均在本次节点集合内）
  const edgeRows = db.prepare(
    `SELECT source_id, target_id, relation FROM knowledge_edges
     WHERE material_id = ? AND source_id IN (${ph}) AND target_id IN (${ph})`
  ).all(materialId, ...nodeIds, ...nodeIds);

  // 本次涉及子网的当前成员（含并入已有子网后的完整成员，便于 AI 判断是否过载/混杂）
  const sgInfo = [];
  for (const sgId of [...new Set(touchedSubGraphIds)]) {
    const sg = db.prepare('SELECT id, name, description FROM sub_graphs WHERE id = ?').get(sgId);
    if (!sg) continue;
    const members = db.prepare(
      `SELECT node_id FROM sub_graph_nodes WHERE sub_graph_id = ?`
    ).all(sgId).map((r) => r.node_id);
    sgInfo.push({
      id: sg.id,
      name: sg.name,
      description: sg.description || '',
      isNew: createdSubGraphIds.includes(sg.id),
      members: members.map((id) => nameById.get(id)).filter(Boolean)
    });
  }

  const payload = {
    material: title,
    subject: subject || '',
    nodes: nodeRows.map((r) => ({ id: r.id, name: r.name, subject: r.subject || '', category: r.category || '', description: r.description || '' })),
    edges: edgeRows.map((e) => ({ source: nameById.get(e.source_id), target: nameById.get(e.target_id), relation: e.relation })),
    subGraphs: sgInfo
  };

  const existingSgContext = modifySubGraphs ? subGraphsContextForAI() : '';
  const reply = await chat([
    {
      role: 'system',
      content: `你是知识图谱结构优化专家。刚把一份学习材料分析并写入了知识图谱，请审查本次写入的结构并给出"结构修订操作"，让图谱更干净、子网划分更合理。只输出 JSON，格式：
{
 "mergeNodes":[{"keepId":节点id,"removeIds":[节点id],"reason":"简短理由"}],
 "renameNodes":[{"id":节点id,"newName":"更简洁准确的名字","reason":"简短理由"}],
 "deleteEdges":[{"source":"名","target":"名","relation":"关系","reason":"简短理由"}],
 "splitSubGraph":[{"id":子网id,"into":[{"name":"新子网名","description":"简述","members":["成员知识点名"]}],"reason":"简短理由"}],
 "moveSubGraph":[{"subGraphId":子网id,"members":["成员知识点名"],"newName":"可选：整体改名","reason":"简短理由"}]
}
规则（务必保守，宁缺毋滥，可全部输出空数组表示无需调整）：
1. mergeNodes 仅当两个节点明显是同一知识点（同义、繁简、别名）时合并，保留更通用者 keepId；不要合并仅"相关"的节点。
2. renameNodes 仅当名字冗长、含多余符号/序号、或不够规范时改名；保持简洁、可检索。
3. deleteEdges 仅删除明显错误、牵强、或重复冗余的关系。
4. splitSubGraph 仅当一个子网成员过多或主题混杂时拆分；拆分后的成员名必须来自该子网现有成员。
5. moveSubGraph 用于给子网整体改一个更贴切的名字（newName），或对成员做小幅增删（members 给出期望的完整成员名单）。
6. ${modifySubGraphs
    ? '允许并入/复用已有子网（上下文见"已有子知识网"）：若本次某子网与已有子网同主题，可通过 moveSubGraph 把 newName 设为该已有子网名以并入。'
    : '本次设置不允许改动已有子网：不要引用或并入已有子网，只在本次新建的子网内部优化。'}
7. 只允许引用输入中出现的节点 id / 子网 id / 成员名；不要编造。不要输出 JSON 以外的内容。${existingSgContext ? `\n\n【已有子知识网（供参考）】\n${existingSgContext}` : ''}`
    },
    { role: 'user', content: JSON.stringify(payload) }
  ], { temperature: 0.1 });

  let plan;
  try {
    plan = parseLLMJSON(reply);
  } catch (e) {
    logger.warn(`材料 ${materialId} 结构优化返回无法解析，跳过: ${e.message}`);
    return summarizeNoop('AI 修订结果无法解析，已跳过');
  }
  return applyStructureRevisions(materialId, plan, { modifySubGraphs, nameById });
}

function summarizeNoop(msg) {
  return { merged: 0, renamed: 0, edgesDeleted: 0, split: 0, moved: 0, note: msg, text: msg };
}

// 安全应用 AI 的结构修订：所有操作都做存在性校验，逐项 try/catch，单条失败不影响其余
function applyStructureRevisions(materialId, plan, { modifySubGraphs, nameById }) {
  const stats = { merged: 0, renamed: 0, edgesDeleted: 0, split: 0, moved: 0, errors: 0 };
  const nodeIdExists = (id) => Boolean(db.prepare('SELECT id FROM knowledge_nodes WHERE id = ?').get(Number(id)));

  // 1) 合并重复节点
  for (const m of plan?.mergeNodes || []) {
    try {
      const keep = Number(m?.keepId);
      const removes = (m?.removeIds || []).map(Number).filter((id) => id && id !== keep);
      if (!nodeIdExists(keep) || !removes.length) continue;
      for (const rid of removes) {
        if (!nodeIdExists(rid)) continue;
        if (mergeGraphNode(rid, keep)) stats.merged++;
      }
    } catch (e) {
      stats.errors++;
      logger.warn(`结构优化 mergeNodes 失败: ${e.message}`);
    }
  }

  // 2) 节点改名（避免与现有节点撞名导致意外合并，撞名时转为合并）
  for (const r of plan?.renameNodes || []) {
    try {
      const id = Number(r?.id);
      const newName = String(r?.newName || '').trim();
      if (!nodeIdExists(id) || !newName) continue;
      const cur = db.prepare('SELECT name, subject FROM knowledge_nodes WHERE id = ?').get(id);
      if (cur.name === newName) continue;
      const dup = db.prepare('SELECT id FROM knowledge_nodes WHERE name = ? AND id != ?').get(newName, id);
      if (dup) {
        // 已有同名节点：优先同科目者合并，避免产生"同名不同 id"
        if (mergeGraphNode(id, dup.id)) stats.merged++;
      } else {
        db.prepare('UPDATE knowledge_nodes SET name = ? WHERE id = ?').run(newName, id);
        stats.renamed++;
      }
    } catch (e) {
      stats.errors++;
      logger.warn(`结构优化 renameNodes 失败: ${e.message}`);
    }
  }

  // 3) 删除冗余/错误边（仅限本材料写入的边）
  for (const d of plan?.deleteEdges || []) {
    try {
      const s = resolveNodeIdByName(d?.source);
      const t = resolveNodeIdByName(d?.target);
      if (!s || !t) continue;
      const rel = String(d?.relation || '').trim();
      const row = rel
        ? db.prepare('SELECT id FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND relation = ? AND material_id = ?').get(s, t, rel, materialId)
        : db.prepare('SELECT id FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND material_id = ? LIMIT 1').get(s, t, materialId);
      if (row) {
        db.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(row.id);
        stats.edgesDeleted++;
      }
    } catch (e) {
      stats.errors++;
      logger.warn(`结构优化 deleteEdges 失败: ${e.message}`);
    }
  }

  // 4) 子网拆分（仅限本次新建的子网：历史子网不允许在此删除）
  for (const sp of plan?.splitSubGraph || []) {
    try {
      const sgId = Number(sp?.id);
      const sg = db.prepare('SELECT id, name FROM sub_graphs WHERE id = ?').get(sgId);
      const into = Array.isArray(sp?.into) ? sp.into : [];
      if (!sg || into.length < 2 || !createdHere(sg.id)) continue;
      // 先校验各目标合法，再落地，避免半途产生孤儿子网
      const parts = [];
      let ok = true;
      for (const part of into) {
        const name = String(part?.name || '').trim();
        const memberIds = [...new Set((part?.members || []).map(resolveNodeIdByName).filter(Boolean))];
        if (!name || !memberIds.length) { ok = false; break; }
        parts.push({ name, description: part.description || null, memberIds });
      }
      if (!ok) continue;
      for (const p of parts) {
        ensureSubGraph(p.name, materialId, p.memberIds, p.description, { forceNew: !modifySubGraphs });
      }
      db.prepare('DELETE FROM sub_graphs WHERE id = ?').run(sg.id);
      stats.split++;
    } catch (e) {
      stats.errors++;
      logger.warn(`结构优化 splitSubGraph 失败: ${e.message}`);
    }
  }

  // 5) 子网改名/成员整理
  for (const mv of plan?.moveSubGraph || []) {
    try {
      const sgId = Number(mv?.subGraphId);
      const sg = db.prepare('SELECT id, name FROM sub_graphs WHERE id = ?').get(sgId);
      if (!sg) continue;
      const newName = String(mv?.newName || '').trim();
      if (newName && newName !== sg.name) {
        const dup = db.prepare('SELECT id FROM sub_graphs WHERE name = ? AND id != ?').get(newName, sg.id);
        if (dup) {
          // 目标名已有子网：把成员并入目标子网后删除本子网（仅限本次新建者）
          const memberIds = db.prepare('SELECT node_id FROM sub_graph_nodes WHERE sub_graph_id = ?').all(sg.id).map((r) => r.node_id);
          if (memberIds.length) {
            const link = db.prepare('INSERT OR IGNORE INTO sub_graph_nodes (sub_graph_id, node_id) VALUES (?, ?)');
            for (const nid of memberIds) link.run(dup.id, nid);
          }
          if (createdHere(sg.id)) db.prepare('DELETE FROM sub_graphs WHERE id = ?').run(sg.id);
        } else {
          db.prepare('UPDATE sub_graphs SET name = ? WHERE id = ?').run(newName, sg.id);
        }
        stats.moved++;
      }
      if (Array.isArray(mv?.members)) {
        const desired = mv.members.map(resolveNodeIdByName).filter(Boolean);
        if (desired.length) {
          // 增补缺失成员（不做激进删除，避免误移历史成员）
          const link = db.prepare('INSERT OR IGNORE INTO sub_graph_nodes (sub_graph_id, node_id) VALUES (?, ?)');
          for (const nid of desired) link.run(sg.id, nid);
        }
      }
    } catch (e) {
      stats.errors++;
      logger.warn(`结构优化 moveSubGraph 失败: ${e.message}`);
    }
  }

  // 判断某子网是否为本次材料新建（历史子网不允许在结构优化中删除）
  function createdHere(sgId) {
    const row = db.prepare('SELECT material_id, created_at FROM sub_graphs WHERE id = ?').get(sgId);
    if (!row) return false;
    return row.material_id === materialId;
  }

  return { ...stats, text: formatStats(stats) };
}

function resolveNodeIdByName(name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const any = db.prepare('SELECT id FROM knowledge_nodes WHERE name = ? ORDER BY id LIMIT 1').get(clean);
  return any?.id || null;
}

function formatStats(s) {
  const parts = [];
  if (s.merged) parts.push(`合并重复节点 ${s.merged}`);
  if (s.renamed) parts.push(`规范命名 ${s.renamed}`);
  if (s.edgesDeleted) parts.push(`清理冗余关系 ${s.edgesDeleted}`);
  if (s.split) parts.push(`拆分过载子网 ${s.split}`);
  if (s.moved) parts.push(`整理子网 ${s.moved}`);
  if (!parts.length) return '结构良好，无需调整';
  return parts.join('，') + (s.errors ? `（${s.errors} 项跳过）` : '');
}

// 分类后置后，用分类得到的科目/分册回填本次新建节点（仅处理 source_material_id 对应者，
// 避免影响其他材料的同名节点；若补齐科目会撞上已有同名同科目节点，则安全合并而非违约）
function backfillNodeSubjects(materialId, subject, volume = null) {
  const rows = db.prepare('SELECT id, name, subject, volume FROM knowledge_nodes WHERE source_material_id = ?').all(materialId);
  let changed = 0;
  for (const r of rows) {
    const needSubject = !r.subject;
    const needVolume = Boolean(volume) && !r.volume;
    if (!needSubject && !needVolume) continue;
    if (needSubject) {
      const dup = db
        .prepare('SELECT id FROM knowledge_nodes WHERE name = ? AND subject = ? AND id != ?')
        .get(r.name, subject, r.id);
      if (dup) {
        // 已有同名同科目节点：合并（转移全部引用后删除），避免 UNIQUE(name, subject) 冲突
        if (mergeGraphNode(r.id, dup.id)) changed++;
        continue;
      }
    }
    db.prepare(
      `UPDATE knowledge_nodes SET
         subject = CASE WHEN subject IS NULL OR subject = '' THEN ? ELSE subject END,
         volume = CASE WHEN volume IS NULL OR volume = '' THEN ? ELSE volume END
       WHERE id = ?`
    ).run(subject, volume || null, r.id);
    changed++;
  }
  if (changed) logger.info(`材料 ${materialId} 科目/分册回填: 处理 ${changed} 个节点`);
}

function fallbackClassify(material) {
  return {
    subject: material.subject || '其他',
    volume: material.volume || '',
    kind: material.kind || '其他',
    logicalParts: splitChunks(material.content, { maxLen: 500 }).slice(0, 5).map((c, i) => ({
      title: `部分${i + 1}`,
      summary: c.slice(0, 50)
    }))
  };
}

function fallbackSummary(material) {
  return material.content.replace(/\s+/g, ' ').slice(0, 180);
}

function fallbackExtract(material) {
  const keywords = extractKeywords(material.content, 12);
  const nodes = keywords.map((w) => ({ name: w, category: '概念', description: `来自材料《${material.title}》的高频知识点` }));
  const edges = [];
  const sentences = sentencesOf(material.content);
  for (const sent of sentences) {
    const present = keywords.filter((w) => sent.includes(w));
    for (let i = 1; i < present.length; i++) {
      edges.push({ source: present[0], target: present[i], relation: '同句共现' });
    }
  }
  const subGraphs = keywords.length
    ? [{ name: `《${material.title}》主题网`, description: '离线模式基于共现构建的子知识网', nodes: keywords.slice(0, 8) }]
    : [];
  return { nodes, edges, subGraphs };
}
