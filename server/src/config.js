import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, '..');
// 仅 .env 文件路径本身允许通过 KNOWLODGE_ENV_PATH 引导（用于多实例/测试隔离）
export const ENV_PATH = process.env.KNOWLODGE_ENV_PATH || path.join(ROOT_DIR, '.env');
const ENV_EXAMPLE = path.join(ROOT_DIR, '.env.example');

const ENV_TEMPLATE = `# knowlodge 系统配置（唯一配置源：运行时关键配置只从本文件读取，不受系统环境变量/启动命令影响）
# 服务启动时若不存在会自动创建；"设置"页保存的配置会写回本文件
PORT=8787
AUTH_SECRET=knowlodge-dev-secret
# 数据目录（默认 server/data，可填绝对路径）
# DATA_DIR=
AI_BASE_URL=
AI_API_KEY=
AI_CHAT_MODEL=gpt-4o-mini
AI_CHAT_MODEL_BACKUP=
AI_RETRY_COUNT=1
AI_EMBED_MODEL=text-embedding-3-small
AI_VISION_MODEL=
STUDY_AUTO_ANALYZE=on
LISTS_AI_AUTOCREATE=off
# 允许 AI 分析时直接修改现有子知识网（on=注入已有图谱由 AI 决定并入或新建；off=每次均新建独立子网）
AI_MODIFY_SUBGRAPHS=on
`;

if (!fs.existsSync(ENV_PATH)) {
  try {
    fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
    if (fs.existsSync(ENV_EXAMPLE)) fs.copyFileSync(ENV_EXAMPLE, ENV_PATH);
    else fs.writeFileSync(ENV_PATH, ENV_TEMPLATE, 'utf8');
    console.log(`[knowlodge] 未检测到 .env，已自动创建 ${ENV_PATH}`);
  } catch (e) {
    console.warn(`[knowlodge] 自动创建 .env 失败: ${e.message}`);
  }
}

// .env 唯一配置源：解析文件内容到内存，运行期一律读取该存储
const ENV = (() => {
  try {
    return dotenv.parse(fs.readFileSync(ENV_PATH));
  } catch {
    return {};
  }
})();

export function getEnv(key, fallback = '') {
  const v = ENV[key];
  return v === undefined || v === '' ? fallback : v;
}

export function setEnv(updates) {
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    content = ENV_TEMPLATE;
  }
  const remaining = { ...updates };
  const out = content.split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (m && m[1] in remaining) {
      const value = remaining[m[1]] ?? '';
      delete remaining[m[1]];
      return `${m[1]}=${value}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(remaining)) {
    out.push(`${key}=${value ?? ''}`);
  }
  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(ENV_PATH, text, 'utf8');
  Object.assign(ENV, updates);
}

export const DATA_DIR = (() => {
  const v = getEnv('DATA_DIR', '');
  if (!v) return path.join(ROOT_DIR, 'data');
  return path.isAbsolute(v) ? v : path.join(ROOT_DIR, v);
})();
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const DOCUMENT_DIR = path.join(DATA_DIR, 'documents');

for (const dir of [DATA_DIR, UPLOAD_DIR, IMAGE_DIR, LOG_DIR, DOCUMENT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const PORT = Number(getEnv('PORT', '8787'));
export const AUTH_SECRET = getEnv('AUTH_SECRET', 'knowlodge-dev-secret');
export const TOKEN_TTL = 7 * 24 * 3600 * 1000;
export const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };
