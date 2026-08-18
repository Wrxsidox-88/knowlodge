import { logger } from '../logger.js';

export function notFound(req, res) {
  res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` });
}

export function errorHandler(err, req, res, _next) {
  logger.error(`请求处理异常 ${req.method} ${req.originalUrl}: ${err.message}`);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || '服务器内部错误' });
}

export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`;
    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.info(line);
  });
  next();
}
