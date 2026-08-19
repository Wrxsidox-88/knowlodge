import { Router } from 'express';
import { db, verifyPassword, hashPassword } from '../db.js';
import { signToken } from '../token.js';
import { authRequired } from '../middleware/auth.js';
import { logger } from '../logger.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
  if (!user || !verifyPassword(password, user.password_hash)) {
    logger.warn(`登录失败: ${username}`);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = signToken({ uid: user.id, username: user.username });
  logger.info(`用户登录: ${user.username}`);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// 修改账户：可改用户名、改密码（需校验原密码）。需登录。
authRouter.post('/account', authRequired, (req, res) => {
  const { username, newPassword, currentPassword } = req.body || {};
  const user = req.user;
  if (!user) return res.status(401).json({ error: '未登录' });

  // 1) 校验原密码：改密码必填；仅改用户名时若提供了也一并校验
  if (newPassword && !currentPassword) {
    return res.status(400).json({ error: '修改密码需要验证当前密码' });
  }
  if (currentPassword) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      return res.status(400).json({ error: '当前密码不正确' });
    }
  }

  // 2) 修改用户名
  let nextUsername = user.username;
  if (username !== undefined && String(username).trim() !== '') {
    const u = String(username).trim();
    if (u.length > 32) return res.status(400).json({ error: '用户名长度不能超过 32 个字符' });
    if (u !== user.username) {
      const exists = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(u, user.id);
      if (exists) return res.status(409).json({ error: '该用户名已被占用' });
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(u, user.id);
      nextUsername = u;
      logger.info(`用户 #${user.id} 修改用户名: ${user.username} -> ${u}`);
    }
  }

  // 3) 修改密码
  if (newPassword) {
    const p = String(newPassword);
    if (p.length < 4) return res.status(400).json({ error: '密码长度至少 4 位' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(p), user.id);
    logger.info(`用户 #${user.id} 已修改密码`);
  }

  res.json({ ok: true, user: { id: user.id, username: nextUsername, role: user.role } });
});

authRouter.get('/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

// 校验当前用户密码（用于数据管理等危险操作的二次确认）
authRouter.post('/verify-password', authRequired, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: '请输入密码' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(400).json({ error: '密码不正确' });
  }
  res.json({ ok: true });
});
