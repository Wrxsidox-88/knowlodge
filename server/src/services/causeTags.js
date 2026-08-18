import { db } from '../db.js';

export function listCauseTags() {
  return db.prepare('SELECT * FROM error_cause_tags ORDER BY id ASC').all();
}

export function createCauseTag(name, description = '', source = 'user') {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('标签名不能为空'), { status: 400 });
  const existing = db.prepare('SELECT * FROM error_cause_tags WHERE name = ?').get(clean);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO error_cause_tags (name, description, source) VALUES (?, ?, ?)')
    .run(clean, String(description || '').trim(), source);
  return db.prepare('SELECT * FROM error_cause_tags WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function updateCauseTag(id, { name, description }) {
  const row = db.prepare('SELECT * FROM error_cause_tags WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('标签不存在'), { status: 404 });
  const cleanName = name != null ? String(name).trim() : row.name;
  if (!cleanName) throw Object.assign(new Error('标签名不能为空'), { status: 400 });
  const dup = db.prepare('SELECT id FROM error_cause_tags WHERE name = ? AND id != ?').get(cleanName, row.id);
  if (dup) throw Object.assign(new Error('同名标签已存在'), { status: 409 });
  db.prepare('UPDATE error_cause_tags SET name = ?, description = ? WHERE id = ?')
    .run(cleanName, description != null ? String(description).trim() : row.description, row.id);
  return db.prepare('SELECT * FROM error_cause_tags WHERE id = ?').get(row.id);
}

export function deleteCauseTag(id) {
  const row = db.prepare('SELECT * FROM error_cause_tags WHERE id = ?').get(Number(id));
  if (!row) throw Object.assign(new Error('标签不存在'), { status: 404 });
  const used = db.prepare('SELECT COUNT(*) AS c FROM wrong_questions WHERE error_cause = ?').get(row.name).c;
  db.prepare('DELETE FROM error_cause_tags WHERE id = ?').run(row.id);
  return { deleted: row.name, referencedByWrong: used };
}

export function resolveCauseTag(name, description = '') {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const existing = db.prepare('SELECT * FROM error_cause_tags WHERE name = ?').get(clean);
  if (existing) return existing;
  return createCauseTag(clean, description, 'ai');
}
