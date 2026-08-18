import { verifyToken } from '../token.js';
import { db } from '../db.js';

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  // 支持 ?token= 查询参数兜底（用于 <a> 链接/新标签页下载等无法携带 Header 的场景）
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query?.token || null);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(payload.uid);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  req.user = user;
  next();
}
