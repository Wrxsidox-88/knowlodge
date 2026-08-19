import { db } from '../db.js';

export function upsertNode({ name, subject = null, volume = null, category = null, description = null, materialId = null }) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const subj = subject || null;
  const existing = db
    .prepare('SELECT id FROM knowledge_nodes WHERE name = ? AND ifnull(subject, \'\') = ifnull(?, \'\')')
    .get(clean, subj);
  if (existing) {
    const cur = db.prepare('SELECT description FROM knowledge_nodes WHERE id = ?').get(existing.id);
    const desc = description && (!cur.description || description.length > cur.description.length)
      ? description
      : cur.description;
    db.prepare(
      `UPDATE knowledge_nodes SET
         category = ifnull(?, category),
         description = ?,
         volume = ifnull(?, volume)
       WHERE id = ?`
    ).run(category, desc ?? null, volume, existing.id);
    return existing.id;
  }
  const info = db
    .prepare('INSERT INTO knowledge_nodes (name, subject, volume, category, description, source_material_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(clean, subj, volume, category, description, materialId);
  return Number(info.lastInsertRowid);
}

export function addEdge(sourceId, targetId, relation, materialId = null) {
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const rel = String(relation || '相关').trim() || '相关';
  const existing = db
    .prepare('SELECT id FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND relation = ?')
    .get(sourceId, targetId, rel);
  if (existing) return existing.id;
  const info = db
    .prepare('INSERT INTO knowledge_edges (source_id, target_id, relation, material_id) VALUES (?, ?, ?, ?)')
    .run(sourceId, targetId, rel, materialId);
  return Number(info.lastInsertRowid);
}

/**
 * 创建/复用子知识网并写入成员。
 * - forceNew=false（默认）：按名称复用已有子网（不限来源材料），同一主题的多份材料归入同一子网，
 *   避免"一份资料一个新子网"造成图谱碎片化；
 * - forceNew=true（设置"不允许 AI 修改现有子网"时）：绝不复用已有子网，每次分析都新建独立子网；
 *   为避免与已有子网重名造成混淆，自动追加材料标题/序号生成唯一名称。
 * 返回 { id, created }：created 表示是否本次新建了子网行。
 */
export function ensureSubGraph(name, materialId, nodeIds, description = null, { forceNew = false } = {}) {
  const clean = String(name || '').trim();
  if (!clean || !nodeIds?.length) return null;
  let id = null;
  if (!forceNew) {
    const row = db.prepare('SELECT id FROM sub_graphs WHERE name = ? ORDER BY id LIMIT 1').get(clean);
    id = row?.id;
  }
  let created = false;
  if (!id) {
    let finalName = clean;
    if (forceNew) finalName = uniqueSubGraphName(clean, materialId);
    const info = db.prepare('INSERT INTO sub_graphs (name, material_id, description) VALUES (?, ?, ?)').run(finalName, materialId, description);
    id = Number(info.lastInsertRowid);
    created = true;
  } else if (description) {
    db.prepare('UPDATE sub_graphs SET description = ifnull(NULLIF(description, \'\'), ?) WHERE id = ?').run(description, id);
  }
  const link = db.prepare('INSERT OR IGNORE INTO sub_graph_nodes (sub_graph_id, node_id) VALUES (?, ?)');
  for (const nid of nodeIds) link.run(id, nid);
  return { id, created };
}

// forceNew 模式下生成不与已有子网重复的名称：优先附加材料标题，仍冲突则追加序号
function uniqueSubGraphName(name, materialId) {
  const exists = (n) => Boolean(db.prepare('SELECT id FROM sub_graphs WHERE name = ?').get(n));
  if (!exists(name)) return name;
  const mat = materialId ? db.prepare('SELECT title FROM materials WHERE id = ?').get(materialId) : null;
  const base = mat?.title ? `${name}《${mat.title}》` : `${name}（新）`;
  if (!exists(base)) return base;
  let k = 2;
  while (exists(`${base}(${k})`)) k++;
  return `${base}(${k})`;
}

// 按名称解析已有知识点 id（供分析时把新材料的边连接到已有图谱节点）
export function findNodeIdByName(name, preferSubject = null) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  if (preferSubject) {
    const hit = db.prepare('SELECT id FROM knowledge_nodes WHERE name = ? AND subject = ?').get(clean, preferSubject);
    if (hit) return hit.id;
  }
  const any = db.prepare('SELECT id FROM knowledge_nodes WHERE name = ? ORDER BY id LIMIT 1').get(clean);
  return any?.id || null;
}

/**
 * 将节点 aliasId 合并进 keepId：把边、子网成员、错题关联、掌握度、片段、练习等
 * 全部引用转移到 keepId 后删除 aliasId。返回 true 表示合并实际发生。
 * （供"图谱结构优化"去重节点、改名撞上已有节点、分类回填科目冲突时使用）
 */
export function mergeGraphNode(aliasId, keepId) {
  aliasId = Number(aliasId);
  keepId = Number(keepId);
  if (!aliasId || !keepId || aliasId === keepId) return false;
  const alias = db.prepare('SELECT id FROM knowledge_nodes WHERE id = ?').get(aliasId);
  const keep = db.prepare('SELECT id FROM knowledge_nodes WHERE id = ?').get(keepId);
  if (!alias || !keep) return false;

  // 边：端点改指 keep；产生重复边或自环时直接删除
  const edges = db
    .prepare('SELECT id, source_id, target_id, relation FROM knowledge_edges WHERE source_id = ? OR target_id = ?')
    .all(aliasId, aliasId);
  for (const e of edges) {
    const s = e.source_id === aliasId ? keepId : e.source_id;
    const t = e.target_id === aliasId ? keepId : e.target_id;
    if (s === t) {
      db.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(e.id);
      continue;
    }
    const dup = db
      .prepare('SELECT id FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND relation = ? AND id != ?')
      .get(s, t, e.relation, e.id);
    if (dup) {
      db.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(e.id);
      continue;
    }
    db.prepare('UPDATE knowledge_edges SET source_id = ?, target_id = ? WHERE id = ?').run(s, t, e.id);
  }

  // 子网成员：并入 keep（保留 keep 原有成员）
  db.prepare('INSERT OR IGNORE INTO sub_graph_nodes (sub_graph_id, node_id) SELECT sub_graph_id, ? FROM sub_graph_nodes WHERE node_id = ?').run(keepId, aliasId);
  db.prepare('DELETE FROM sub_graph_nodes WHERE node_id = ?').run(aliasId);

  // 错题关联：并入 keep（避免级联丢失错题绑定）
  db.prepare('INSERT OR IGNORE INTO wrong_question_nodes (question_id, node_id) SELECT question_id, ? FROM wrong_question_nodes WHERE node_id = ?').run(keepId, aliasId);
  db.prepare('DELETE FROM wrong_question_nodes WHERE node_id = ?').run(aliasId);

  // 掌握度：keep 无记录则迁移；有记录则累计正确/错误次数并保留较高阶段
  const am = db.prepare('SELECT * FROM mastery WHERE node_id = ?').get(aliasId);
  if (am) {
    const km = db.prepare('SELECT * FROM mastery WHERE node_id = ?').get(keepId);
    if (!km) {
      db.prepare('UPDATE mastery SET node_id = ? WHERE node_id = ?').run(keepId, aliasId);
    } else {
      db.prepare('UPDATE mastery SET correct = correct + ?, wrong = wrong + ?, stage = max(stage, ?) WHERE node_id = ?')
        .run(am.correct || 0, am.wrong || 0, am.stage || 0, keepId);
      db.prepare('DELETE FROM mastery WHERE node_id = ?').run(aliasId);
    }
  }

  // 其余引用直接改指
  db.prepare('UPDATE chunks SET node_id = ? WHERE node_id = ?').run(keepId, aliasId);
  db.prepare('UPDATE practices SET node_id = ? WHERE node_id = ?').run(keepId, aliasId);

  db.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(aliasId);
  return true;
}

// 生成"已有知识图谱"上下文（供知识抽取 prompt 注入）：
// 让 AI 看到已有知识点与子网，复用同名节点、连接已有节点、归入已有子网
export function graphContextForAI({ maxNodes = 240, maxSubGraphs = 24, maxChars = 4200 } = {}) {
  const nodeTotal = db.prepare('SELECT COUNT(*) AS c FROM knowledge_nodes').get().c;
  if (!nodeTotal) return null;
  const nodes = db.prepare(
    `SELECT n.name, n.subject, n.category,
            ((SELECT COUNT(*) FROM knowledge_edges e WHERE e.source_id = n.id)
           + (SELECT COUNT(*) FROM knowledge_edges e WHERE e.target_id = n.id)) AS degree
     FROM knowledge_nodes n
     ORDER BY degree DESC, n.id DESC
     LIMIT ?`
  ).all(maxNodes);
  const sgRows = db.prepare(
    `SELECT sg.id, sg.name,
            (SELECT group_concat(kn.name, '、') FROM (
               SELECT sgn2.node_id FROM sub_graph_nodes sgn2 WHERE sgn2.sub_graph_id = sg.id LIMIT 12
             ) x JOIN knowledge_nodes kn ON kn.id = x.node_id) AS members
     FROM sub_graphs sg
     ORDER BY sg.id DESC LIMIT ?`
  ).all(maxSubGraphs);
  const lines = [];
  lines.push(`已有知识点 ${nodeTotal} 个${nodeTotal > nodes.length ? `（以下列出关联度最高的 ${nodes.length} 个）` : ''}：`);
  lines.push(nodes.map((n) => `- ${n.name}（${n.subject || '未分科'}${n.category ? '/' + n.category : ''}）`).join('\n'));
  if (sgRows.length) {
    lines.push(`已有子知识网 ${sgRows.length} 个：`);
    lines.push(sgRows.map((s) => `- ${s.name}${s.members ? `（成员：${s.members}）` : ''}`).join('\n'));
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
  return text;
}

// 仅列出"已有子知识网"的上下文（供图谱结构优化 prompt 注入）：
// 让 AI 判断本次新建的子网是否应并入已有子网，或避免与已有子网重复命名
export function subGraphsContextForAI({ maxSubGraphs = 40, maxMembers = 12, maxChars = 2600 } = {}) {
  const total = db.prepare('SELECT COUNT(*) AS c FROM sub_graphs').get().c;
  if (!total) return null;
  const rows = db.prepare(
    `SELECT sg.id, sg.name, sg.description,
            (SELECT COUNT(*) FROM sub_graph_nodes sgn WHERE sgn.sub_graph_id = sg.id) AS node_count,
            (SELECT group_concat(kn.name, '、') FROM (
               SELECT sgn2.node_id FROM sub_graph_nodes sgn2 WHERE sgn2.sub_graph_id = sg.id LIMIT ?
             ) x JOIN knowledge_nodes kn ON kn.id = x.node_id) AS members
     FROM sub_graphs sg
     ORDER BY sg.id DESC LIMIT ?`
  ).all(maxMembers, maxSubGraphs);
  const lines = [`已有子知识网 ${total} 个${total > rows.length ? `（以下列出最近 ${rows.length} 个）` : ''}：`];
  for (const r of rows) {
    lines.push(`- ${r.name}（${r.node_count} 个成员${r.members ? `：${r.members}` : ''}）${r.description ? `｜${r.description}` : ''}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
  return text;
}

export function degreesOf(nodeIds) {
  const result = new Map();
  if (!nodeIds.length) return result;
  const ph = nodeIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT node_id, COUNT(*) AS deg FROM (
        SELECT source_id AS node_id FROM knowledge_edges WHERE source_id IN (${ph})
        UNION ALL
        SELECT target_id AS node_id FROM knowledge_edges WHERE target_id IN (${ph})
      ) GROUP BY node_id`)
    .all(...nodeIds, ...nodeIds);
  for (const r of rows) result.set(r.node_id, r.deg);
  return result;
}

export function getGraph({ subject = null, keyword = null, nodeId = null, depth = 2, limit = 300, full = false } = {}) {
  const nodeTotal = db.prepare('SELECT COUNT(*) AS c FROM knowledge_nodes').get().c;
  const edgeTotal = db.prepare('SELECT COUNT(*) AS c FROM knowledge_edges').get().c;
  let nodes;
  if (nodeId) {
    nodes = bfsNeighborhood(Number(nodeId), Number(depth) || 2, Number(limit) || 300);
  } else {
    const where = [];
    const params = [];
    if (subject) {
      where.push('subject = ?');
      params.push(subject);
    }
    if (keyword) {
      where.push('(name LIKE ? OR ifnull(description, \'\') LIKE ?)');
      params.push(`%${keyword}%`, `%${keyword}%`);
    }
    // 大数据量保护：默认按关联度取 TopN，避免一次性返回/渲染全图造成卡顿
    const cap = full ? Math.min(Number(limit) || 5000, 5000) : Math.min(Math.max(Number(limit) || 300, 1), 2000);
    const sql = `
      SELECT n.*, (
        (SELECT COUNT(*) FROM knowledge_edges e WHERE e.source_id = n.id)
        + (SELECT COUNT(*) FROM knowledge_edges e WHERE e.target_id = n.id)
      ) AS degree
      FROM knowledge_nodes n
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY degree DESC, n.id DESC
      LIMIT ?`;
    nodes = db.prepare(sql).all(...params, cap);
  }
  if (!nodes.length) return { nodes: [], edges: [], subGraphs: [], nodeTotal, edgeTotal };
  const ids = nodes.map((n) => n.id);
  const deg = degreesOf(ids);
  const ph = ids.map(() => '?').join(',');
  const edges = db
    .prepare(`SELECT * FROM knowledge_edges WHERE source_id IN (${ph}) AND target_id IN (${ph})`)
    .all(...ids, ...ids);
  const sgRows = db
    .prepare(
      `SELECT sg.id, sg.name, sg.material_id, sgn.node_id FROM sub_graphs sg
       JOIN sub_graph_nodes sgn ON sgn.sub_graph_id = sg.id
       WHERE sgn.node_id IN (${ph})`
    )
    .all(...ids);
  const sgMap = new Map();
  for (const r of sgRows) {
    if (!sgMap.has(r.id)) sgMap.set(r.id, { id: r.id, name: r.name, material_id: r.material_id, node_ids: [] });
    sgMap.get(r.id).node_ids.push(r.node_id);
  }
  return {
    nodes: nodes.map((n) => ({ ...n, degree: n.degree ?? deg.get(n.id) ?? 0 })),
    edges,
    subGraphs: [...sgMap.values()],
    nodeTotal,
    edgeTotal
  };
}

function bfsNeighborhood(rootId, depth, limit) {
  const seen = new Set([rootId]);
  let frontier = [rootId];
  for (let d = 0; d < depth && frontier.length; d++) {
    const ph = frontier.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT source_id, target_id FROM knowledge_edges WHERE source_id IN (${ph}) OR target_id IN (${ph})`)
      .all(...frontier, ...frontier);
    const next = [];
    for (const r of rows) {
      for (const nid of [r.source_id, r.target_id]) {
        if (!seen.has(nid) && seen.size < limit) {
          seen.add(nid);
          next.push(nid);
        }
      }
    }
    frontier = next;
  }
  if (!seen.has(rootId)) return [];
  const ph = [...seen].map(() => '?').join(',');
  return db.prepare(`SELECT * FROM knowledge_nodes WHERE id IN (${ph})`).all(...seen);
}

export function nodeDetail(nodeId) {
  const node = db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(Number(nodeId));
  if (!node) return null;
  const edges = db
    .prepare(
      `SELECT e.id, e.relation, e.material_id,
              CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END AS other_id,
              CASE WHEN e.source_id = ? THEN 'out' ELSE 'in' END AS direction
       FROM knowledge_edges e
       WHERE e.source_id = ? OR e.target_id = ?`
    )
    .all(nodeId, nodeId, nodeId, nodeId);
  const otherIds = [...new Set(edges.map((e) => e.other_id))];
  const others = otherIds.length
    ? db.prepare(`SELECT id, name, subject FROM knowledge_nodes WHERE id IN (${otherIds.map(() => '?').join(',')})`).all(...otherIds)
    : [];
  const nameMap = new Map(others.map((o) => [o.id, o]));
  const subGraphs = db
    .prepare(
      `SELECT sg.id, sg.name, sg.material_id FROM sub_graphs sg
       JOIN sub_graph_nodes sgn ON sgn.sub_graph_id = sg.id
       WHERE sgn.node_id = ?`
    )
    .all(nodeId);
  const materials = [];
  const matIds = new Set([node.source_material_id, ...edges.map((e) => e.material_id)].filter(Boolean));
  if (matIds.size) {
    const ph = [...matIds].map(() => '?').join(',');
    materials.push(...db.prepare(`SELECT id, title, subject, status FROM materials WHERE id IN (${ph})`).all(...matIds));
  }
  return {
    node,
    edges: edges.map((e) => ({ ...e, other: nameMap.get(e.other_id) || null })),
    subGraphs,
    materials
  };
}

// ---------- 自由编辑（节点/边/子网 CRUD） ----------

export function getNodeRow(id) {
  return db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(Number(id));
}

export function updateNode(id, { name, subject, volume, category, description } = {}) {
  const row = getNodeRow(id);
  if (!row) throw Object.assign(new Error('知识点不存在'), { status: 404 });
  const nextName = name !== undefined ? String(name).trim() : row.name;
  if (!nextName) throw Object.assign(new Error('知识点名称不能为空'), { status: 400 });
  const nextSubject = subject !== undefined ? (subject || null) : row.subject;
  const dup = db
    .prepare('SELECT id FROM knowledge_nodes WHERE name = ? AND ifnull(subject, \'\') = ifnull(?, \'\') AND id != ?')
    .get(nextName, nextSubject, row.id);
  if (dup) throw Object.assign(new Error('同科目下已存在同名知识点'), { status: 409 });
  db.prepare(
    `UPDATE knowledge_nodes SET name = ?, subject = ?, volume = ?, category = ?, description = ? WHERE id = ?`
  ).run(
    nextName,
    nextSubject,
    volume !== undefined ? (volume || null) : row.volume,
    category !== undefined ? (category || null) : row.category,
    description !== undefined ? (description || null) : row.description,
    row.id
  );
  return getNodeRow(row.id);
}

export function deleteNode(id) {
  const row = getNodeRow(id);
  if (!row) throw Object.assign(new Error('知识点不存在'), { status: 404 });
  // 外键级联：关联边、子网成员、错题关联、掌握度一并删除
  db.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(row.id);
  return { ok: true, name: row.name };
}

export function deleteEdge(id) {
  const row = db.prepare('SELECT id FROM knowledge_edges WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('关系不存在'), { status: 404 });
  db.prepare('DELETE FROM knowledge_edges WHERE id = ?').run(row.id);
  return { ok: true };
}

export function listSubGraphs() {
  return db.prepare(
    `SELECT sg.*, m.title AS material_title,
            (SELECT COUNT(*) FROM sub_graph_nodes sgn WHERE sgn.sub_graph_id = sg.id) AS node_count
     FROM sub_graphs sg LEFT JOIN materials m ON m.id = sg.material_id
     ORDER BY sg.id DESC`
  ).all();
}

export function createSubGraph({ name, description = null, materialId = null, nodeIds = [] }) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('子知识网名不能为空'), { status: 400 });
  const info = db.prepare('INSERT INTO sub_graphs (name, material_id, description) VALUES (?, ?, ?)')
    .run(clean, materialId ? Number(materialId) : null, description);
  const id = Number(info.lastInsertRowid);
  const link = db.prepare('INSERT OR IGNORE INTO sub_graph_nodes (sub_graph_id, node_id) VALUES (?, ?)');
  for (const nid of nodeIds || []) link.run(id, Number(nid));
  return db.prepare('SELECT * FROM sub_graphs WHERE id = ?').get(id);
}

export function updateSubGraph(id, { name, description } = {}) {
  const row = db.prepare('SELECT * FROM sub_graphs WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('子知识网不存在'), { status: 404 });
  db.prepare('UPDATE sub_graphs SET name = ?, description = ? WHERE id = ?').run(
    name !== undefined ? (String(name).trim() || row.name) : row.name,
    description !== undefined ? (description || null) : row.description,
    row.id
  );
  return db.prepare('SELECT * FROM sub_graphs WHERE id = ?').get(row.id);
}

export function deleteSubGraph(id) {
  const row = db.prepare('SELECT id FROM sub_graphs WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('子知识网不存在'), { status: 404 });
  db.prepare('DELETE FROM sub_graphs WHERE id = ?').run(row.id);
  return { ok: true };
}

export function updateSubGraphNodes(id, { add = [], remove = [] } = {}) {
  const row = db.prepare('SELECT id FROM sub_graphs WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('子知识网不存在'), { status: 404 });
  const link = db.prepare('INSERT OR IGNORE INTO sub_graph_nodes (sub_graph_id, node_id) VALUES (?, ?)');
  for (const nid of add || []) link.run(row.id, Number(nid));
  const unlink = db.prepare('DELETE FROM sub_graph_nodes WHERE sub_graph_id = ? AND node_id = ?');
  for (const nid of remove || []) unlink.run(row.id, Number(nid));
  return db.prepare('SELECT node_id FROM sub_graph_nodes WHERE sub_graph_id = ?').all(row.id).map((r) => r.node_id);
}
