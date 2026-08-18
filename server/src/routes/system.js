import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import { DATA_DIR, ENV_PATH, UPLOAD_DIR } from '../config.js';
import { logger } from '../logger.js';

export const systemRouter = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `import-${Date.now()}.zip`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8').toLowerCase();
    if (name.endsWith('.zip')) cb(null, true);
    else cb(new Error('仅支持 .zip 数据包'));
  }
});

systemRouter.get('/export', (req, res, next) => {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="knowlodge-backup-${stamp}.zip"`);
    const archive = new ZipArchive();
    archive.on('error', (e) => next(e));
    archive.pipe(res);
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (name === '_import.zip') continue;
      const full = path.join(DATA_DIR, name);
      if (fs.statSync(full).isDirectory()) archive.directory(full, `data/${name}`);
      else archive.file(full, { name: `data/${name}` });
    }
    if (fs.existsSync(ENV_PATH)) {
      archive.file(ENV_PATH, { name: '.env' });
    }
    logger.info('数据导出开始', { user: req.user.username });
    archive.finalize();
  } catch (e) {
    next(e);
  }
});

systemRouter.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未接收到 zip 文件' });
  const dest = path.join(DATA_DIR, '_import.zip');
  fs.copyFileSync(req.file.path, dest);
  fs.rmSync(req.file.path, { force: true });
  logger.warn('数据包已上传，服务即将重启以恢复数据', { user: req.user.username });
  res.json({ ok: true, message: '数据包已接收，服务正在重启以完成导入。约 3 秒后刷新页面。' });
  setTimeout(() => process.exit(0), 500);
});

systemRouter.post('/restart', (req, res) => {
  logger.warn('收到重启指令', { user: req.user.username });
  res.json({ ok: true, message: '服务正在重启。若使用 PM2 将自动拉起；直接 node 运行则需手动重启。' });
  setTimeout(() => process.exit(0), 400);
});

systemRouter.get('/pm2', (req, res) => {
  const config = `module.exports = {
  apps: [
    {
      name: 'knowlodge',
      cwd: '${process.cwd().replace(/\\/g, '\\\\')}',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: 'production' }
    }
  ]
};`;
  res.json({
    config,
    commands: [
      'npm install -g pm2',
      'cd server && pm2 start src/index.js --name knowlodge',
      'pm2 save',
      'pm2 startup   # 按提示执行输出的命令，实现开机自启'
    ],
    note: '服务异常退出或被 /api/system/restart、数据导入触发退出时，PM2 会自动检测并重新拉起（接管）。'
  });
});
