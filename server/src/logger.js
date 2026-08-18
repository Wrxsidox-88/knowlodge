import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';

const RING_SIZE = 300;
const ring = [];
const logFile = path.join(LOG_DIR, 'server.log');

function push(level, msg, extra) {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...(extra !== undefined ? { extra } : {})
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  const line = `[${entry.time}] [${level}] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* 日志落盘失败不影响主流程 */
  }
}

export const logger = {
  info: (msg, extra) => push('INFO', msg, extra),
  warn: (msg, extra) => push('WARN', msg, extra),
  error: (msg, extra) => push('ERROR', msg, extra),
  recent: (n = 100) => ring.slice(-n)
};
