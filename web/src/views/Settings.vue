<template>
  <div>
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div class="row" style="align-items: flex-start">
      <div class="card">
        <h3>AI 模型配置（OpenAI 兼容接口）</h3>
        <div v-if="error" class="error-box">{{ error }}</div>
        <div class="toolbar">
          <span class="badge" :class="info?.ai?.enabled ? 'done' : 'pending'">
            {{ info?.ai?.enabled ? 'AI 已接入' : '离线模式（未配置 Key，使用启发式分析）' }}
          </span>
          <span class="muted" v-if="info?.ai?.keyPreview">当前 Key：{{ info.ai.keyPreview }}</span>
        </div>
        <label class="field">
          <span>API Base URL</span>
          <input v-model="form['ai.baseUrl']" placeholder="https://api.openai.com/v1" />
        </label>
        <label class="field">
          <span>API Key</span>
          <input v-model="form['ai.apiKey']" type="password" placeholder="sk-..." />
        </label>
        <label class="field">
          <span>对话模型（分类/概览/知识抽取/问答）</span>
          <div class="toolbar" style="margin: 0">
            <input v-model="form['ai.chatModel']" placeholder="gpt-4o-mini / deepseek-chat / qwen-plus" style="flex: 1" />
            <button class="small" :disabled="fetchingModels" @click="fetchModels">
              <span v-if="fetchingModels" class="loading"></span>获取模型列表
            </button>
          </div>
        </label>
        <div v-if="models.length" class="toolbar" style="margin-bottom: 10px">
          <span class="muted">可用模型（点击填入）：</span>
          <span v-for="mo in models.slice(0, 12)" :key="mo" class="chip" @click="form['ai.chatModel'] = mo">{{ mo }}</span>
        </div>
        <div class="row">
          <label class="field">
            <span>备用对话模型（主模型失败自动切换）</span>
            <input v-model="form['ai.backupModel']" placeholder="可留空" />
          </label>
          <label class="field" style="max-width: 130px">
            <span>重试次数</span>
            <input v-model="form['ai.retryCount']" type="number" min="1" max="5" />
          </label>
        </div>
        <label class="field">
          <span>向量模型（Embedding：语义检索）</span>
          <input v-model="form['ai.embedModel']" placeholder="text-embedding-3-small / text-embedding-v3" />
        </label>
        <label class="field">
          <span>视觉分析模型（解读 docx/pdf 内嵌图片、图片材料、扫描页）</span>
          <input v-model="form['ai.visionModel']" placeholder="gpt-4o-mini / qwen-vl-plus（可留空）" />
        </label>
        <div class="toolbar">
          <label class="toggle-label"><input type="checkbox" v-model="autoAnalyze" /> 错题录入后自动 AI 分析</label>
          <label class="toggle-label"><input type="checkbox" v-model="listsAutocreate" /> 允许 AI 分析时按需创建知识清单</label>
        </div>
        <div class="toolbar">
          <button class="primary" :disabled="saving" @click="save">
            <span v-if="saving" class="loading"></span>保存设置
          </button>
          <button :disabled="testing" @click="test">
            <span v-if="testing" class="loading"></span>连通性测试
          </button>
          <span class="spacer"></span>
          <span class="muted">向量索引条数：{{ info?.vectorIndexSize ?? '-' }}</span>
        </div>
        <div v-if="testResult" class="node-card">
          <div v-if="testResult.enabled === false" class="muted">{{ testResult.error }}</div>
          <template v-else>
            <div>
              对话模型：<span class="badge" :class="testResult.chat ? 'done' : 'failed'">{{ testResult.chat ? '可用' : '失败' }}</span>
              <span v-if="testResult.chatError" class="muted"> {{ testResult.chatError }}</span>
            </div>
            <div style="margin-top: 6px">
              向量模型：<span class="badge" :class="testResult.embedding ? 'done' : 'failed'">{{ testResult.embedding ? '可用' : '失败' }}</span>
              <span v-if="testResult.embeddingError" class="muted"> {{ testResult.embeddingError }}</span>
            </div>
            <div style="margin-top: 6px">
              视觉模型：<span class="badge" :class="testResult.vision ? 'done' : 'failed'">{{ testResult.vision ? '可用' : testResult.visionError || '未测试' }}</span>
            </div>
          </template>
        </div>
      </div>

      <div class="card">
        <h3>倒计时管理（精确到秒）</h3>
        <div class="toolbar">
          <input v-model="cdForm.title" placeholder="标题，如：期末考试" style="width: 170px" />
          <input v-model="cdForm.date" type="date" style="width: 150px" />
          <input v-model="cdForm.time" type="time" step="1" style="width: 120px" />
          <button class="primary small" @click="addCountdown">新建</button>
        </div>
        <div v-if="!countdowns.length" class="empty">暂无倒计时</div>
        <div v-for="c in countdowns" :key="c.id" class="node-card">
          <div class="toolbar" style="margin: 0">
            <strong>{{ c.title }}</strong>
            <span class="badge pending">{{ fmtTarget(c.target_time) }}</span>
            <div class="spacer"></div>
            <button class="small danger" @click="delCountdown(c)">删除</button>
          </div>
        </div>
        <div class="muted" style="margin-top: 8px">倒计时在首页轮播展示。</div>
      </div>
    </div>

    <div class="row" style="align-items: flex-start">
      <div class="card">
        <h3>数据管理（导出 / 导入）</h3>
        <div class="toolbar">
          <button :disabled="exporting" @click="exportData">
            <span v-if="exporting" class="loading"></span>导出全部数据（zip 压缩包）
          </button>
          <div class="spacer"></div>
          <label class="btn" style="cursor: pointer">
            <span v-if="importing" class="loading"></span>导入数据（zip）
            <input type="file" accept=".zip" style="display: none" @change="importData" />
          </label>
        </div>
        <div class="muted" style="line-height: 1.8; margin-top: 6px">
          · 导出包含：数据库、知识图谱、材料/错题图片、学习数据与 .env 配置。<br />
          · 导入会<strong style="color: var(--warn)">覆盖</strong>当前全部数据并自动重启服务，请谨慎操作。
        </div>
        <h3 style="margin-top: 14px">服务控制</h3>
        <div class="toolbar">
          <button class="danger" @click="restart">重启服务</button>
          <button @click="showPm2 = !showPm2">PM2 开机自启配置</button>
        </div>
        <div v-if="showPm2 && pm2" class="node-card" style="margin-top: 8px">
          <div class="muted" style="margin-bottom: 6px">{{ pm2.note }}</div>
          <pre class="md-text">{{ pm2.commands.join('\n') }}</pre>
          <details style="margin-top: 6px">
            <summary class="muted" style="cursor: pointer">ecosystem 配置文件</summary>
            <pre class="md-text">{{ pm2.config }}</pre>
          </details>
        </div>
      </div>

      <div class="card">
        <h3>说明</h3>
        <ul style="padding-left: 20px; line-height: 2; color: var(--text-dim); font-size: 13px">
          <li><strong>.env 是唯一配置源</strong>：运行时配置只从 server/.env 读取，不受系统环境变量、启动命令影响；设置保存即写入该文件。</li>
          <li>未配置 API Key 时以离线模式运行；配置后走完整 AI 流水线。</li>
          <li>AI 问答可绘图（函数/几何/全符号），由系统精确渲染，非 HTML 绘制，可导出 PNG 插入 Word。</li>
          <li>AI 工具（重析材料/编辑倒计时/知识清单/生成文档）均需用户授权后执行。</li>
          <li>公式使用 LaTeX 语法（$...$ / $$...$$ / $\ce{...}$）自动渲染。</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { api } from '../api.js';
import { winConfirm, winAlert } from '../dialogs.js';

const info = ref(null);
const form = reactive({
  'ai.baseUrl': '', 'ai.apiKey': '', 'ai.chatModel': '', 'ai.backupModel': '',
  'ai.retryCount': '1', 'ai.embedModel': '', 'ai.visionModel': '',
  'study.autoAnalyze': 'on', 'lists.aiAutocreate': 'off'
});
const error = ref('');
const saving = ref(false);
const testing = ref(false);
const testResult = ref(null);
const models = ref([]);
const pageLoading = ref(true);
const fetchingModels = ref(false);
const autoAnalyze = ref(true);
const listsAutocreate = ref(false);

const countdowns = ref([]);
const cdForm = reactive({ title: '', date: '', time: '08:00:00' });

const exporting = ref(false);
const importing = ref(false);
const showPm2 = ref(false);
const pm2 = ref(null);

async function load() {
  info.value = await api.getSettings();
  form['ai.baseUrl'] = info.value.ai.baseUrl || '';
  form['ai.apiKey'] = info.value.values['ai.apiKey'] || '';
  form['ai.chatModel'] = info.value.ai.chatModel || '';
  form['ai.backupModel'] = info.value.ai.backupModel || '';
  form['ai.retryCount'] = String(info.value.ai.retryCount || 1);
  form['ai.embedModel'] = info.value.ai.embedModel || '';
  form['ai.visionModel'] = info.value.ai.visionModel || '';
  form['study.autoAnalyze'] = (info.value.values['study.autoAnalyze'] || 'on');
  form['lists.aiAutocreate'] = (info.value.values['lists.aiAutocreate'] || 'off');
  autoAnalyze.value = form['study.autoAnalyze'] === 'on';
  listsAutocreate.value = form['lists.aiAutocreate'] === 'on';
  countdowns.value = (await api.listCountdowns()).items;
}

async function save() {
  saving.value = true;
  error.value = '';
  try {
    const values = { ...form };
    values['study.autoAnalyze'] = autoAnalyze.value ? 'on' : 'off';
    values['lists.aiAutocreate'] = listsAutocreate.value ? 'on' : 'off';
    await api.saveSettings(values);
    await load();
    winAlert({ title: '提示', message: '设置已保存到 .env' });
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await api.testAI();
  } catch (e) {
    error.value = e.message;
  } finally {
    testing.value = false;
  }
}

async function fetchModels() {
  fetchingModels.value = true;
  try {
    const r = await api.models();
    models.value = r.items || [];
    if (!models.value.length) winAlert({ title: '提示', message: '未获取到模型列表（请确认 base_url 支持 /models 接口）' });
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  } finally {
    fetchingModels.value = false;
  }
}

function fmtTarget(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

async function addCountdown() {
  if (!cdForm.title.trim() || !cdForm.date) {
    winAlert({ title: '提示', message: '请填写标题与日期' });
    return;
  }
  const time = cdForm.time || '00:00:00';
  await api.createCountdown({ title: cdForm.title.trim(), targetTime: `${cdForm.date}T${time}` });
  cdForm.title = '';
  countdowns.value = (await api.listCountdowns()).items;
}

async function delCountdown(c) {
  if (!(await winConfirm({ title: '删除确认', message: `删除倒计时「${c.title}」？`, danger: true }))) return;
  await api.deleteCountdown(c.id);
  countdowns.value = (await api.listCountdowns()).items;
}

async function exportData() {
  exporting.value = true;
  try {
    const res = await api.exportData();
    if (!res.ok) throw new Error('导出失败 ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `knowlodge-backup-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  } finally {
    exporting.value = false;
  }
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!(await winConfirm({ title: '导入确认', message: '导入将覆盖当前全部数据并重启服务，确定继续？', danger: true }))) return;
  importing.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await api.importData(fd);
    winAlert({ title: '提示', message: r.message || '数据包已接收，服务正在重启…' });
    setTimeout(() => location.reload(), 3500);
  } catch (err) {
    winAlert({ title: '操作失败', message: err.message });
    importing.value = false;
  }
}

async function restart() {
  if (!(await winConfirm({ title: '重启确认', message: '确定重启服务？', danger: true }))) return;
  try {
    const r = await api.restartSystem();
    winAlert({ title: '提示', message: r.message || '正在重启…' });
    setTimeout(() => location.reload(), 3000);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function loadPm2() {
  try {
    pm2.value = await api.pm2Info();
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  Promise.all([load(), loadPm2()])
    .catch(() => {})
    .finally(() => {
      pageLoading.value = false;
    });
});
</script>
