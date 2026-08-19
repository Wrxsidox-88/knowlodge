import { Router } from 'express';
import { setEnv } from '../config.js';
import { logger } from '../logger.js';
import { getAIConfig, aiEnabled, visionEnabled, autoAnalyzeEnabled, listsAiAutocreateEnabled, aiModifySubGraphsEnabled, streamEnabled, getStreamCfg, testAI, listModels } from '../ai/client.js';
import { indexSize } from '../services/vectorStore.js';
import { meterEnabled, meterConfig } from '../services/meter.js';
import { updateConfig } from '../services/updater.js';

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
  'lists.aiAutocreate': 'LISTS_AI_AUTOCREATE',
  'graph.aiModifySubGraphs': 'AI_MODIFY_SUBGRAPHS',
  'stream.qa': 'STREAM_QA',
  'stream.vision': 'STREAM_VISION',
  'stream.encourage': 'STREAM_ENCOURAGE',
  'stream.embed': 'STREAM_EMBED',
  'stream.summary': 'STREAM_SUMMARY',
  'stream.classify': 'STREAM_CLASSIFY',
  'stream.graph': 'STREAM_GRAPH',
  'meter.enabled': 'METERCALC_ENABLED',
  'meter.period': 'METERCALC_PERIOD',
  'meter.value': 'METERCALC_VALUE',
  'meter.unit': 'METERCALC_UNIT',
  'meter.windowDays': 'METERCALC_WINDOW',
  'update.repo': 'UPDATE_REPO',
  'update.proxy': 'UPDATE_PROXY',
  'update.intervalHours': 'UPDATE_INTERVAL_HOURS',
  'update.autoMode': 'UPDATE_AUTO_MODE',
  'update.method': 'UPDATE_METHOD'
};

const STREAM_KEYS = ['qa', 'vision', 'encourage', 'embed', 'summary', 'classify', 'graph']; 

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
      'lists.aiAutocreate': listsAiAutocreateEnabled() ? 'on' : 'off',
      'graph.aiModifySubGraphs': aiModifySubGraphsEnabled() ? 'on' : 'off',
      'stream.qa': streamEnabled('qa') ? 'on' : 'off',
      'stream.vision': streamEnabled('vision') ? 'on' : 'off',
      'stream.encourage': streamEnabled('encourage') ? 'on' : 'off',
      'stream.embed': streamEnabled('embed') ? 'on' : 'off',
      'stream.summary': streamEnabled('summary') ? 'on' : 'off',
      'stream.classify': streamEnabled('classify') ? 'on' : 'off',
      'stream.graph': streamEnabled('graph') ? 'on' : 'off',
      'meter.enabled': meterEnabled() ? 'on' : 'off',
      'meter.period': meterConfig().period,
      'meter.value': String(meterConfig().value),
      'meter.unit': meterConfig().unit,
      'meter.windowDays': String(meterConfig().windowDays),
      'update.repo': updateConfig().repo,
      'update.proxy': updateConfig().proxy,
      'update.intervalHours': String(updateConfig().intervalHours),
      'update.autoMode': updateConfig().autoMode,
      'update.method': updateConfig().method
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
      listsAiAutocreate: listsAiAutocreateEnabled(),
      aiModifySubGraphs: aiModifySubGraphsEnabled(),
      stream: getStreamCfg()
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
