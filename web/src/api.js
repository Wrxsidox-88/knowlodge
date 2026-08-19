import axios from 'axios';
import { markBootReady } from './bootState.js';

// AI 相关接口（问答/分析/判题）输出较慢，给足超时；问答主链路已改为流式
export const http = axios.create({ baseURL: '/api', timeout: 600000 });

// ---------- 全局请求加载指示（顶部进度条）：切换页面/获取信息有延迟时给出视觉反馈 ----------
let pendingCount = 0;
let showTimer = null;

function loadBar() {
  let bar = document.getElementById('kl-loadbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'kl-loadbar';
    document.body.appendChild(bar);
  }
  return bar;
}

function startLoading() {
  pendingCount++;
  if (showTimer || pendingCount !== 1) return;
  // 快速完成的请求不闪烁进度条
  showTimer = setTimeout(() => {
    showTimer = null;
    if (pendingCount > 0) loadBar().classList.add('on');
  }, 180);
}

function stopLoading() {
  pendingCount = Math.max(0, pendingCount - 1);
  if (pendingCount > 0) return;
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  loadBar().classList.remove('on');
}

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('kl_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (typeof config.url === 'string' && !config.url.startsWith('/auth')) anyNonAuthStarted = true;
  startLoading();
  return config;
});

// 首屏"内容就绪"信号：加载层保留到首个非登录（/auth 除外）请求完成才淡出移除。
// 页面的第一个数据请求基本就是首屏关键数据；无初始请求的页面由 main.js 看门狗兜底。
let bootNotified = false;
let anyNonAuthStarted = false;
export function bootRequestStarted() {
  return anyNonAuthStarted;
}
function notifyBoot(res) {
  if (bootNotified) return;
  if (typeof res?.config?.url === 'string' && res.config.url.startsWith('/auth')) return;
  bootNotified = true;
  markBootReady();
}

http.interceptors.response.use(
  (res) => {
    stopLoading();
    notifyBoot(res);
    return res.data;
  },
  (err) => {
    stopLoading();
    notifyBoot(err);
    if (err.response?.status === 401 && location.pathname !== '/login') {
      localStorage.removeItem('kl_token');
      location.href = '/login';
    }
    return Promise.reject(new Error(err.response?.data?.error || err.message || '请求失败'));
  }
);

function authHeaders(extra = {}) {
  return { ...extra, Authorization: `Bearer ${localStorage.getItem('kl_token')}` };
}

// 带鉴权的文件下载（修复直接打开下载链接报"未登录"的问题）
async function downloadWithAuth(url, fallbackName) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    let msg = `下载失败(${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch { /* 非 JSON 响应 */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = fallbackName || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

export const api = {
  login: (username, password) => http.post('/auth/login', { username, password }),
  me: () => http.get('/auth/me'),
  updateAccount: (data) => http.post('/auth/account', data),
  verifyPassword: (password) => http.post('/auth/verify-password', { password }),
  devStatus: () => http.get('/dev/status'),
  devEnable: (password) => http.post('/dev/enable', { password }),
  devDisable: () => http.post('/dev/disable'),
  devClearData: (password) => http.post('/dev/clear-data', { password }),
  getLogs: () => http.get('/dev/logs'),

  listMaterials: (params) => http.get('/materials', { params }),
  getMaterial: (id) => http.get(`/materials/${id}`),
  // opts.meta=true 时仅返回轻量元信息（全部图片、无 dataUrl），用于分页浏览/重分析选择
  getMaterialImages: (id, opts = {}) =>
    http.get(`/materials/${id}/images`, { params: opts.meta ? { meta: 1 } : {} }),
  // 按需加载单张图片（含 dataUrl）：看哪张点哪张，不提前加载
  getMaterialImage: (id, imgId) => http.get(`/materials/${id}/images/${imgId}`),
  createMaterial: (data) => http.post('/materials', data),
  uploadMaterial: (form, onProgress) =>
    http.post('/materials/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: onProgress
    }),
  deleteMaterial: (id) => http.delete(`/materials/${id}`),

  // opts.imageIds=[图片id...] 用户选定"参与识别"的照片（未提供 = 全部参与）
  // opts.reanalyzeImageIds=[图片id...] 仅重新识别勾选的图片；opts.reanalyzeImages=true 全部重新识别
  // 默认复用已有识别结果，节省 token
  runAnalysis: (materialId, guide, opts = {}) =>
    http.post('/analysis/run', {
      materialId,
      guide,
      reanalyzeImages: !!opts.reanalyzeImages,
      reanalyzeImageIds: Array.isArray(opts.reanalyzeImageIds) ? opts.reanalyzeImageIds : undefined,
      imageIds: Array.isArray(opts.imageIds) ? opts.imageIds : undefined
    }),
  // 批量分析：多份材料一次提交，AI 逐份处理（分批），全部完成后统一汇总
  // imageIdsMap: { 材料id: [图片id...] } 逐材料选定参与识别的照片
  runBatchAnalysis: (materialIds, guide, imageIdsMap) =>
    http.post('/analysis/batch', { materialIds, guide, imageIds: imageIdsMap || undefined }),
  listBatches: () => http.get('/analysis/batches'),
  getBatch: (id) => http.get(`/analysis/batches/${id}`),
  listJobs: (materialId) => http.get('/analysis/jobs', { params: materialId ? { materialId } : {} }),
  getJobLogs: (jobId) => http.get(`/analysis/jobs/${jobId}/logs`),
  getJob: (id) => http.get(`/analysis/jobs/${id}`),

  ask: (question) => http.post('/qa', { question }),
  search: (query, topK) => http.post('/search', { query, topK }),

  graph: (params) => http.get('/graph', { params }),
  nodeDetail: (id) => http.get(`/graph/node/${id}`),
  nodeExplain: (id, force = false) => http.get(`/graph/node/${id}/explain${force ? '?force=1' : ''}`),
  subGraphs: () => http.get('/graph/subgraphs'),
  createNode: (data) => http.post('/graph/nodes', data),
  updateNode: (id, data) => http.put(`/graph/nodes/${id}`, data),
  deleteNode: (id) => http.delete(`/graph/nodes/${id}`),
  createEdge: (data) => http.post('/graph/edges', data),
  deleteEdge: (id) => http.delete(`/graph/edges/${id}`),
  createSubGraph: (data) => http.post('/graph/subgraphs', data),
  updateSubGraph: (id, data) => http.put(`/graph/subgraphs/${id}`, data),
  updateSubGraphNodes: (id, data) => http.put(`/graph/subgraphs/${id}/nodes`, data),
  deleteSubGraph: (id) => http.delete(`/graph/subgraphs/${id}`),

  getSettings: () => http.get('/settings'),
  saveSettings: (values) => http.put('/settings', { values }),
  getUsagemeter: () => http.get('/usagemeter/status'),
  saveUsagemeter: (cfg) => http.post('/usagemeter/config', cfg),
  usagemeterGrant: (value, unit) => http.post('/usagemeter/grant', { value, unit }),
  usagemeterReset: () => http.post('/usagemeter/reset'),  testAI: () => http.post('/settings/ai/test'),

  getUpdateStatus: () => http.get('/update/status'),
  checkUpdate: () => http.post('/update/check'),
  getUpdateDiff: () => http.get('/update/diff'),
  saveUpdateSettings: (values, password) => http.post('/update/settings', { ...values, password: password || '' }),
  applyUpdate: (payload) => http.post('/update/apply', payload),
  getUpdateReadme: () => http.get('/update/readme'),
  getUpdateLog: () => http.get('/update/log'),

  monitor: () => http.get('/monitor'),

  listExams: (params) => http.get('/exams', { params }),
  examTrend: (subject) => http.get('/exams/trend', { params: subject ? { subject } : {} }),
  createExam: (data) => http.post('/exams', data),
  updateExam: (id, data) => http.put(`/exams/${id}`, data),
  deleteExam: (id) => http.delete(`/exams/${id}`),
  listExamEvents: () => http.get('/exams/events'),
  getExamEvent: (id) => http.get(`/exams/events/${id}`),

  listWrong: (params) => http.get('/wrong', { params }),
  getWrong: (id) => http.get(`/wrong/${id}`),
  createWrong: (data) => http.post('/wrong', data),
  uploadWrong: (form) => http.post('/wrong/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } }),
  analyzeWrong: (id, guide) => http.post(`/wrong/${id}/analyze`, { guide }),
  updateWrong: (id, data) => http.put(`/wrong/${id}`, data),
  deleteWrong: (id) => http.delete(`/wrong/${id}`),
  wrongCauses: () => http.get('/wrong/causes'),
  createCause: (data) => http.post('/wrong/causes', data),
  updateCause: (id, data) => http.put(`/wrong/causes/${id}`, data),
  deleteCause: (id) => http.delete(`/wrong/causes/${id}`),

  studyOverview: (subject) => http.get('/study/overview', { params: subject ? { subject } : {} }),
  completeReview: (nodeId) => http.post(`/study/reviews/${nodeId}/complete`),
  generatePractice: (nodeId) => http.post('/study/practice/generate', nodeId ? { nodeId } : {}),
  listPractices: () => http.get('/study/practices'),
  submitPractice: (id, data) => http.post(`/study/practices/${id}/submit`, data),
  getReport: () => http.get('/study/report'),
  reportSummary: (guide) => http.get('/study/report/summary', { params: guide ? { guide } : {} }),

  listCountdowns: () => http.get('/countdowns'),
  createCountdown: (data) => http.post('/countdowns', data),
  deleteCountdown: (id) => http.delete(`/countdowns/${id}`),

  listConversations: () => http.get('/chat/conversations'),
  createConversation: (title) => http.post('/chat/conversations', title ? { title } : {}),
  renameConversation: (id, title) => http.put(`/chat/conversations/${id}`, { title }),
  deleteConversation: (id) => http.delete(`/chat/conversations/${id}`),
  getMessages: (convId) => http.get(`/chat/conversations/${convId}/messages`),
  sendMessage: (convId, question, model, references) =>
    http.post(`/chat/conversations/${convId}/messages`, { question, model, references }),
  addNote: (convId, content) => http.post(`/chat/conversations/${convId}/note`, { content }),
  executeTool: (tool, args) => http.post('/chat/tools/execute', { tool, args }),
  saveToolState: (messageId, index, status, result) =>
    http.post(`/chat/messages/${messageId}/tool-state`, { index, status, result }),

  models: () => http.get('/settings/models'),

  renderFigure: (spec) => http.post('/figure/render', { spec }),
  figurePngBlob: (spec) =>
    fetch('/api/figure/png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('kl_token')}` },
      body: JSON.stringify({ spec })
    }).then((r) => r.blob()),

  listsTree: () => http.get('/lists/tree'),
  getList: (id) => http.get(`/lists/${id}`),
  createList: (data) => http.post('/lists', data),
  updateList: (id, data) => http.put(`/lists/${id}`, data),
  deleteList: (id) => http.delete(`/lists/${id}`),

  generateDocument: (data) => http.post('/documents/generate', data),
  listDocuments: () => http.get('/documents'),
  deleteDocument: (id) => http.delete(`/documents/${id}`),
  downloadDocument: (id, name) => downloadWithAuth(`/api/documents/${id}/download`, name || `document-${id}.docx`),

  listMindMaps: () => http.get('/mindmaps'),
  getMindMap: (id) => http.get(`/mindmaps/${id}`),
  createMindMap: (data) => http.post('/mindmaps', data),
  updateMindMap: (id, data) => http.put(`/mindmaps/${id}`, data),
  deleteMindMap: (id) => http.delete(`/mindmaps/${id}`),
  aiGenerateMindMap: (prompt, refs) => http.post('/mindmaps/ai-generate', { prompt, refs }),

  exportData: () =>
    fetch('/api/system/export', { headers: authHeaders() }),
  importData: (form) => http.post('/system/import', form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 }),
  restartSystem: () => http.post('/system/restart'),
  pm2Info: () => http.get('/system/pm2'),

  encourage: () => http.get('/study/encourage'),
  encourageRefresh: () => http.post('/study/encourage/refresh')
};

/**
 * 流式发送聊天消息（SSE）。
 * handlers: { onMeta(meta), onToken(delta, full), onDone({messageId, result}), onError(message) }
 * 返回 AbortController 供调用方取消。
 */
export function sendMessage(convId, question, model, references) {
  return http.post(`/chat/conversations/${convId}/messages`, {
    question,
    model: model || undefined,
    references: references && references.length ? references : undefined,
    stream: false
  });
}

export function sendMessageStream(convId, question, model, references, handlers = {}) {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`/api/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ question, model, references, stream: true }),
        signal: controller.signal
      });
      if (!res.ok) {
        let msg = `请求失败(${res.status})`;
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch { /* ignore */ }
        if (res.status === 401 && location.pathname !== '/login') {
          localStorage.removeItem('kl_token');
          location.href = '/login';
        }
        handlers.onError?.(msg);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let evt;
            try {
              evt = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if (evt.type === 'meta') handlers.onMeta?.(evt);
            else if (evt.type === 'token') handlers.onToken?.(evt.delta, evt.full);
            else if (evt.type === 'done') handlers.onDone?.(evt);
            else if (evt.type === 'error') handlers.onError?.(evt.message || '回答失败');
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') handlers.onError?.(e.message || '网络错误');
    }
  })();
  return controller;
}
