import { Router } from 'express';
import { setEnv } from '../config.js';
import { logger } from '../logger.js';
import { getAIConfig, aiEnabled, visionEnabled, autoAnalyzeEnabled, listsAiAutocreateEnabled, testAI, listModels } from '../ai/client.js';
import { indexSize } from '../services/vectorStore.js';

export const settingsRouter = Router();

const KEY_TO_ENV = {
  'ai.baseUrl': 'AI_BASE_URL',
  'ai.apiKey': 'AI_API_KEY',
  'ai.chatModel': 'AI_CHAT_MODEL',
  'ai.backupModel': 'AI_CHAT_MODEL_BACKUP',
  'ai.retryCount': 'AI_RETRY_COUNT',
  'ai.embedModel': 'AI_EMBED_MODEL',
  'ai.visionModel': 'AI_VISION_MODEL',
  'study.autoAnalyze': 'STUDY_AUTO_ANALYZE',
  'lists.aiAutocreate': 'LISTS_AI_AUTOCREATE'
};

settingsRouter.get('/', (req, res) => {
  const cfg = getAIConfig();
  res.json({
    values: {
      'ai.baseUrl': cfg.baseUrl,
      'ai.apiKey': cfg.apiKey,
      'ai.chatModel': cfg.chatModel,
      'ai.backupModel': cfg.backupModel,
      'ai.retryCount': String(cfg.retryCount),
      'ai.embedModel': cfg.embedModel,
      'ai.visionModel': cfg.visionModel,
      'study.autoAnalyze': autoAnalyzeEnabled() ? 'on' : 'off',
      'lists.aiAutocreate': listsAiAutocreateEnabled() ? 'on' : 'off'
    },
    ai: {
      enabled: aiEnabled(),
      baseUrl: cfg.baseUrl,
      hasKey: Boolean(cfg.apiKey),
      keyPreview: cfg.apiKey ? cfg.apiKey.slice(0, 4) + '****' : '',
      chatModel: cfg.chatModel,
      backupModel: cfg.backupModel,
      retryCount: cfg.retryCount,
      embedModel: cfg.embedModel,
      visionEnabled: visionEnabled(),
      visionModel: cfg.visionModel,
      autoAnalyze: autoAnalyzeEnabled(),
      listsAiAutocreate: listsAiAutocreateEnabled()
    },
    persistedBy: 'server/.env（唯一配置源：自动创建并持久化，重启不丢失，不受系统环境变量影响）',
    vectorIndexSize: indexSize()
  });
});

settingsRouter.put('/', (req, res) => {
  const values = req.body?.values || {};
  const updates = {};
  for (const [key, envName] of Object.entries(KEY_TO_ENV)) {
    if (key in values) updates[envName] = String(values[key] ?? '').trim();
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: '没有可保存的配置项' });
  try {
    setEnv(updates);
    logger.info('设置已保存到 .env', { user: req.user.username, keys: Object.keys(updates) });
    res.json({ ok: true, saved: Object.keys(updates) });
  } catch (e) {
    logger.error(`设置保存失败: ${e.message}`);
    res.status(500).json({ error: `写入 .env 失败: ${e.message}` });
  }
});

settingsRouter.get('/models', async (req, res) => {
  const models = await listModels();
  res.json({ items: models, configured: getAIConfig().chatModel });
});

settingsRouter.post('/ai/test', async (req, res, next) => {
  try {
    if (!aiEnabled()) {
      return res.json({ enabled: false, error: '尚未配置 AI_BASE_URL / AI_API_KEY（.env 或本设置页）' });
    }
    const result = await testAI();
    res.json({ enabled: true, ...result });
  } catch (e) {
    next(e);
  }
});
