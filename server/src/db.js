import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { DATA_DIR, ENV_PATH, DEFAULT_ADMIN } from './config.js';
import { logger } from './logger.js';

// 启动时若存在待导入数据包（由"数据导入"上传并触发重启），先恢复再打开数据库
const IMPORT_ZIP = path.join(DATA_DIR, '_import.zip');
if (fs.existsSync(IMPORT_ZIP)) {
  try {
    const zip = new AdmZip(IMPORT_ZIP);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, '/');
      if (name === '.env') {
        fs.writeFileSync(ENV_PATH, entry.getData());
        continue;
      }
      const cleaned = name.replace(/^data\//, '');
      const dest = path.resolve(DATA_DIR, cleaned);
      if (!dest.startsWith(path.resolve(DATA_DIR) + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
    fs.rmSync(IMPORT_ZIP);
    console.log('[knowlodge] 已恢复导入的数据包');
  } catch (e) {
    console.error(`[knowlodge] 数据导入恢复失败: ${e.message}`);
  }
}

export const db = new DatabaseSync(path.join(DATA_DIR, 'knowlodge.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject TEXT,
  volume TEXT,
  kind TEXT,
  content TEXT NOT NULL,
  file_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT,
  volume TEXT,
  category TEXT,
  description TEXT,
  source_material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, subject)
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON knowledge_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON knowledge_edges(target_id);

CREATE TABLE IF NOT EXISTS sub_graphs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  material_id INTEGER REFERENCES materials(id) ON DELETE CASCADE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sub_graph_nodes (
  sub_graph_id INTEGER NOT NULL REFERENCES sub_graphs(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (sub_graph_id, node_id)
);

CREATE TABLE IF NOT EXISTS material_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  placeholder TEXT,
  note TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_images_material ON material_images(material_id);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  node_id INTEGER REFERENCES knowledge_nodes(id) ON DELETE SET NULL,
  title TEXT,
  text TEXT NOT NULL,
  embedding TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_material ON chunks(material_id);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  step TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 批量分析批次：多份材料一次提交，AI 逐份处理，全部完成后统一汇总
CREATE TABLE IF NOT EXISTS analysis_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  done_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  guide TEXT,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  title TEXT,
  exam_date TEXT NOT NULL,
  total_score REAL NOT NULL,
  score REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exams_subject ON exams(subject);

CREATE TABLE IF NOT EXISTS wrong_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER REFERENCES exams(id) ON DELETE SET NULL,
  subject TEXT,
  question TEXT NOT NULL,
  options TEXT,
  correct_answer TEXT,
  user_answer TEXT,
  error_cause TEXT,
  cause_note TEXT,
  analysis TEXT,
  knowledge_points TEXT,
  image_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  guide TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wrong_subject ON wrong_questions(subject);

CREATE TABLE IF NOT EXISTS wrong_question_nodes (
  question_id INTEGER NOT NULL REFERENCES wrong_questions(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, node_id)
);

CREATE TABLE IF NOT EXISTS mastery (
  node_id INTEGER PRIMARY KEY REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  correct INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  stage INTEGER NOT NULL DEFAULT 0,
  last_review_at TEXT,
  next_review_at TEXT
);

CREATE TABLE IF NOT EXISTS practices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER REFERENCES knowledge_nodes(id) ON DELETE SET NULL,
  source_wrong_id INTEGER REFERENCES wrong_questions(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  figure TEXT,
  reference_answer TEXT,
  user_answer TEXT,
  is_correct INTEGER,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS countdowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  target_time TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS exam_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  exam_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(title)
);

CREATE TABLE IF NOT EXISTS error_cause_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS study_encourage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ai',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES knowledge_lists(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note',
  name TEXT NOT NULL,
  description TEXT,
  content TEXT,
  ai_editable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parent_id, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mindmaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT,
  description TEXT,
  content TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  scope TEXT NOT NULL DEFAULT 'chat',
  model TEXT NOT NULL DEFAULT '-',
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  estimate INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage (ts);
`;

db.exec(SCHEMA);

// 已下线功能的历史表清理：用户查询记录（queries）与学习计划（study_plans）已于 2026-08-16 移除
db.exec('DROP TABLE IF EXISTS queries; DROP TABLE IF EXISTS study_plans;');

// 性能索引：数据量增大后避免全表扫描（图谱/清单/练习等高频查询）
db.exec(`
CREATE INDEX IF NOT EXISTS idx_nodes_subject ON knowledge_nodes(subject);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON knowledge_nodes(name);
CREATE INDEX IF NOT EXISTS idx_lists_parent ON knowledge_lists(parent_id);
CREATE INDEX IF NOT EXISTS idx_practices_node ON practices(node_id);
CREATE INDEX IF NOT EXISTS idx_practices_status ON practices(status);
CREATE INDEX IF NOT EXISTS idx_wrong_status ON wrong_questions(status);
CREATE INDEX IF NOT EXISTS idx_mastery_next ON mastery(next_review_at);
CREATE INDEX IF NOT EXISTS idx_subgraph_nodes_node ON sub_graph_nodes(node_id);
CREATE INDEX IF NOT EXISTS idx_materials_status ON materials(status);
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    logger.info(`数据库迁移: ${table} 新增列 ${column}`);
  }
}

ensureColumn('exams', 'exam_event_id', 'INTEGER REFERENCES exam_events(id) ON DELETE SET NULL');
ensureColumn('analysis_jobs', 'batch_id', 'INTEGER REFERENCES analysis_batches(id) ON DELETE SET NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_batch ON analysis_jobs(batch_id)');

const DEFAULT_CAUSE_TAGS = [
  ['知识盲区', '完全没有学过或没有印象的知识点，看到题目无从下手', 'user'],
  ['逻辑错误', '知识点记得，但推理、推导过程出错', 'user'],
  ['概念混淆', '把相似的概念、公式或适用条件弄混', 'user'],
  ['粗心', '会做但看错题、算错数、抄错答案等非知识性失误', 'user'],
  ['方法错误', '解题思路或方法选择不当，走了弯路或方向错误', 'user'],
  ['其他', '以上类型均不适用，需具体说明', 'user']
];
const tagCount = db.prepare('SELECT COUNT(*) AS c FROM error_cause_tags').get().c;
if (tagCount === 0) {
  const insert = db.prepare('INSERT INTO error_cause_tags (name, description, source) VALUES (?, ?, ?)');
  for (const [name, description, source] of DEFAULT_CAUSE_TAGS) insert.run(name, description, source);
  logger.info('已初始化默认错因标签');
}

export function hashPassword(password, salt = crypto.randomBytes(8).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
}

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(DEFAULT_ADMIN.username, hashPassword(DEFAULT_ADMIN.password), 'admin');
    logger.info(`已创建默认管理员账号 ${DEFAULT_ADMIN.username}`);
  }
}

seed();
