import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, ROOT_DIR } from './config.js';
import { logger } from './logger.js';
import { loadIndex } from './services/vectorStore.js';
import { authRequired } from './middleware/auth.js';
import { notFound, errorHandler, requestLogger } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { materialsRouter } from './routes/materials.js';
import { analysisRouter } from './routes/analysis.js';
import { graphRouter } from './routes/graph.js';
import { searchRouter } from './routes/search.js';
import { qaRouter } from './routes/qa.js';
import { settingsRouter } from './routes/settings.js';
import { monitorRouter } from './routes/monitor.js';
import { examsRouter } from './routes/exams.js';
import { wrongRouter } from './routes/wrong.js';
import { studyRouter } from './routes/study.js';
import { countdownsRouter } from './routes/countdowns.js';
import { chatRouter } from './routes/chat.js';
import { figuresRouter } from './routes/figures.js';
import { listsRouter } from './routes/lists.js';
import { systemRouter } from './routes/system.js';
import { documentsRouter } from './routes/documents.js';
import { mindmapsRouter } from './routes/mindmaps.js';
import { encourageTick } from './services/study.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', authRouter);

app.use('/api', authRequired);
app.use('/api/materials', materialsRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/graph', graphRouter);
app.use('/api/search', searchRouter);
app.use('/api/qa', qaRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/monitor', monitorRouter);
app.use('/api/exams', examsRouter);
app.use('/api/wrong', wrongRouter);
app.use('/api/study', studyRouter);
app.use('/api/countdowns', countdownsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/figure', figuresRouter);
app.use('/api/lists', listsRouter);
app.use('/api/system', systemRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/mindmaps', mindmapsRouter);

const distDir = path.resolve(ROOT_DIR, '..', 'web', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
  logger.info(`生产模式：已托管前端构建产物 ${distDir}`);
}

app.use(notFound);
app.use(errorHandler);

loadIndex();

setInterval(encourageTick, 3600 * 1000);

app.listen(PORT, () => {
  logger.info(`后端服务已启动: http://localhost:${PORT}`);
});