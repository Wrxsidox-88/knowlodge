import { logger } from '../logger.js';
import { getEnv } from '../config.js';

export function getAIConfig() {
  return {
    baseUrl: getEnv('AI_BASE_URL', 'https://api.openai.com/v1'),
    apiKey: getEnv('AI_API_KEY', ''),
    chatModel: getEnv('AI_CHAT_MODEL', 'gpt-4o-mini'),
    backupModel: getEnv('AI_CHAT_MODEL_BACKUP', ''),
    retryCount: Math.max(1, Number(getEnv('AI_RETRY_COUNT', '1')) || 1),
    embedModel: getEnv('AI_EMBED_MODEL', 'text-embedding-3-small'),
    visionModel: getEnv('AI_VISION_MODEL', '')
  };
}

export function autoAnalyzeEnabled() {
  return getEnv('STUDY_AUTO_ANALYZE', 'on').toLowerCase() !== 'off';
}

export function listsAiAutocreateEnabled() {
  return getEnv('LISTS_AI_AUTOCREATE', 'off').toLowerCase() === 'on';
}

const MODEL_HINT =
  '请在"设置"中核对模型名：OpenAI=gpt-4o-mini，DeepSeek=deepseek-chat，通义=qwen-plus，Moonshot=moonshot-v1-8k；并可为备用模型配置 AI_CHAT_MODEL_BACKUP。';

// 非流式请求的总超时：AI 长输出（分析/总结）较慢，给足时间避免误判超时（运行时可调 .env）
function requestTimeoutMs() {
  return Number(getEnv('AI_REQUEST_TIMEOUT_MS', '600000')) || 600000;
}
// 流式请求的"空闲超时"：只要持续有数据块返回就不超时，只在长时间无任何数据时放弃
function streamIdleTimeoutMs() {
  return Number(getEnv('AI_STREAM_IDLE_TIMEOUT_MS', '120000')) || 120000;
}

function decorateModelError(e, model) {
  if (/not\s?found|does\s?not\s?exist|invalid.{0,12}model|unknown\s?model/i.test(e.message)) {
    return new Error(`模型 "${model}" 不存在(${e.message})。${MODEL_HINT}`);
  }
  return e;
}

export function aiEnabled() {
  const { apiKey, baseUrl } = getAIConfig();
  return Boolean(apiKey && baseUrl);
}

export function visionEnabled() {
  const { apiKey, baseUrl, visionModel } = getAIConfig();
  return Boolean(apiKey && baseUrl && visionModel);
}

async function request(pathname, body, { timeoutMs } = {}) {
  const { baseUrl, apiKey } = getAIConfig();
  const url = `${baseUrl.replace(/\/$/, '')}${pathname}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || requestTimeoutMs())
  });
  const text = await res.text();
  if (!res.ok) {
    logger.error(`AI 请求失败 ${pathname} status=${res.status}`, text.slice(0, 500));
    throw new Error(`AI 服务调用失败(${res.status}): ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('AI 服务返回了非法 JSON');
  }
}

export async function chat(messages, { temperature = 0.3, model: modelOverride } = {}) {
  // 内部统一走流式通道再收集完整文本：
  // 1) 避免上游网关对长输出非流式请求返回 504；
  // 2) 超时策略为"空闲超时"，AI 持续输出即不中断；
  // 3) 模型降级/重试逻辑由 chatStream 统一处理。
  return chatStream(messages, { temperature, model: modelOverride });
}

/**
 * 流式对话：逐块回调 onToken(delta, fullText)，返回完整文本。
 * - 超时策略为"空闲超时"：只要 AI 持续输出就不超时，避免长回答被总时长截断；
 * - 外部 signal（如客户端断开）可中止；
 * - 主模型失败自动切备用模型重试（前端以 fullText 覆盖渲染，避免重复）。
 */
export async function chatStream(messages, { temperature = 0.3, model: modelOverride, onToken, signal } = {}) {
  const { baseUrl, apiKey, chatModel, backupModel, retryCount } = getAIConfig();
  const models = modelOverride
    ? [modelOverride]
    : [chatModel, backupModel].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastErr = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      if (signal?.aborted) throw new Error('请求已取消');
      try {
        return await streamOnce(baseUrl, apiKey, model, messages, temperature, onToken, signal);
      } catch (e) {
        lastErr = decorateModelError(e, model);
        logger.warn(`chatStream 调用失败 model=${model} attempt=${attempt}/${retryCount}: ${e.message}`);
      }
    }
  }
  throw lastErr || new Error('无可用对话模型');
}

async function streamOnce(baseUrl, apiKey, model, messages, temperature, onToken, externalSignal) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('AI 流式输出空闲超时')), streamIdleTimeoutMs());
  };
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  armIdle();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ model, messages, temperature, stream: true }),
      signal: controller.signal
    });
  } finally {
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
  if (!res.ok) {
    if (idleTimer) clearTimeout(idleTimer);
    const text = await res.text().catch(() => '');
    logger.error(`AI 流式请求失败 status=${res.status}`, text.slice(0, 500));
    throw new Error(`AI 服务调用失败(${res.status}): ${text.slice(0, 200)}`);
  }
  let full = '';
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.text ?? '';
          if (delta) {
            full += delta;
            try {
              onToken?.(delta, full);
            } catch {
              /* 渲染回调异常不影响流本身 */
            }
          }
        } catch {
          /* 忽略无法解析的心跳/注释行 */
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  return full;
}

export async function listModels() {
  const { baseUrl, apiKey } = getAIConfig();
  if (!baseUrl) return [];
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      logger.warn(`获取模型列表失败 status=${res.status}`);
      return [];
    }
    const data = await res.json();
    const arr = Array.isArray(data?.data) ? data.data : [];
    return arr.map((m) => m.id).filter(Boolean).sort();
  } catch (e) {
    logger.warn(`获取模型列表异常: ${e.message}`);
    return [];
  }
}

export async function visionDescribe(imageDataUrl, note = '') {
  const { visionModel } = getAIConfig();
  const prompt = `你是学习资料中的图像分析助手。请仔细观察这张来自学习材料的图片${note ? `（${note}）` : ''}，输出：
1) 图片类型（公式/图表/示意图/几何图形/表格/题目截图/实验装置/其他）；
2) 图中包含的具体知识点、文字、公式、数据或图形特征（逐项列出，公式请转写为文本）；
3) 它可能关联的学科与知识点名称。
用简洁中文回答，不超过 300 字。只输出分析内容。`;
  const data = await request('/chat/completions', {
    model: visionModel,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      }
    ]
  });
  return (data?.choices?.[0]?.message?.content ?? '').trim();
}

export async function embedBatch(texts) {
  const { embedModel } = getAIConfig();
  const data = await request('/embeddings', {
    model: embedModel,
    input: texts
  });
  return (data?.data ?? [])
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export async function embedText(text) {
  const [vec] = await embedBatch([text]);
  return vec;
}

const TEST_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function testAI() {
  const result = { chat: false, embedding: false, vision: false, chatError: null, embeddingError: null, visionError: null };
  try {
    const content = await chat([{ role: 'user', content: '回复"ok"' }], { temperature: 0 });
    result.chat = Boolean(content);
  } catch (e) {
    result.chatError = e.message;
  }
  try {
    const vec = await embedText('连通性测试');
    result.embedding = Array.isArray(vec) && vec.length > 0;
  } catch (e) {
    result.embeddingError = e.message;
  }
  if (visionEnabled()) {
    try {
      const content = await visionDescribe(TEST_PNG_DATA_URL, '连通性测试图，1x1 像素');
      result.vision = Boolean(content);
    } catch (e) {
      result.visionError = e.message;
    }
  } else {
    result.visionError = '未配置视觉模型（ai.visionModel）';
  }
  return result;
}
