import { Router } from 'express';
import { db, verifyPassword } from '../db.js';
import { signToken } from '../token.js';
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

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user });
});
