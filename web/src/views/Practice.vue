<template>
  <div>
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div class="row" style="align-items: flex-start">
      <div class="card" style="flex: 1.6">
        <h3>变式训练（针对薄弱考点）</h3>
        <div v-if="error" class="error-box">{{ error }}</div>
        <div class="toolbar">
          <span class="muted">选择薄弱知识点：</span>
          <div class="spacer"></div>
          <button class="primary" :disabled="generating" @click="generate()">
            <span v-if="generating" class="loading"></span>自动选题（最薄弱）
          </button>
        </div>
        <div style="margin-bottom: 10px">
          <span v-for="n in weakNodes" :key="n.id" class="chip" @click="generate(n.id)">
            {{ n.name }} <em style="font-style: normal; color: var(--warn)">{{ n.mastery }}%</em>
          </span>
          <span v-if="!weakNodes.length" class="muted">暂无薄弱知识点，请先录入并分析错题</span>
        </div>

        <template v-if="current">
          <div class="node-card">
            <div class="toolbar" style="margin: 0 0 8px">
              <span class="badge search">{{ current.nodeName }}</span>
              <span class="muted">练习 #{{ current.id }}</span>
              <span v-if="replayMode" class="badge done">回放模式</span>
              <div class="spacer"></div>
              <button v-if="replayMode" class="small" @click="closeCurrent">关闭</button>
            </div>
            <div class="md-body" v-html="md(current.question)"></div>
            <svg v-if="figure" viewBox="0 0 300 300" class="fig-svg">
              <template v-if="figure.type === 'polygon'">
                <polygon :points="polyPoints" fill="rgba(79,140,255,0.12)" stroke="#4f8cff" stroke-width="2" />
                <text v-for="(p, i) in figure.points" :key="i" :x="p[0]" :y="p[1] - 8" style="fill: var(--text)" font-size="13" text-anchor="middle">
                  {{ (figure.labels || [])[i] || '' }}
                </text>
              </template>
              <template v-else-if="figure.type === 'circle'">
                <circle :cx="figure.cx" :cy="figure.cy" :r="figure.r" fill="rgba(39,200,160,0.12)" stroke="#27c8a0" stroke-width="2" />
                <text v-if="(figure.labels || []).length" :x="figure.cx" :y="figure.cy + 4" style="fill: var(--text)" font-size="13" text-anchor="middle">
                  {{ figure.labels[0] }}
                </text>
              </template>
            </svg>

            <!-- 回放：展示当时的作答与结果 -->
            <template v-if="replayMode">
              <label class="field" style="margin-top: 10px">
                <span>当时的作答</span>
                <div class="md-body" style="border: 1px solid var(--border); border-radius: 8px; padding: 10px" v-html="md(current.userAnswer || '（未作答）')"></div>
              </label>
            </template>
            <template v-else>
              <label class="field" style="margin-top: 10px">
                <span>你的解答</span>
                <textarea v-model="answer" rows="4" placeholder="写出解题过程与答案"></textarea>
              </label>
              <div class="toolbar">
                <button class="primary" :disabled="submitting || !answer.trim()" @click="submit()">
                  <span v-if="submitting" class="loading"></span>提交（AI 判题）
                </button>
                <button :disabled="submitting" @click="submit(true)">自评：做对了</button>
                <button :disabled="submitting" @click="submit(false)">自评：做错了</button>
              </div>
            </template>
          </div>

          <div v-if="result" class="node-card" style="margin-top: 10px">
            <div class="toolbar" style="margin: 0">
              <span class="badge" :class="result.isCorrect ? 'done' : 'failed'">{{ result.isCorrect ? '回答正确' : '回答错误' }}</span>
              <span v-if="result.byAI" class="badge search">AI 判定</span>
              <span v-else class="badge">自我判定</span>
              <div class="spacer"></div>
              <span v-if="result.mastery != null" class="muted">
                知识点掌握度更新：<strong :style="{ color: result.mastery >= 60 ? '#27c8a0' : '#ef5f6b' }">{{ result.mastery }}%</strong>
              </span>
            </div>
            <p class="muted" style="margin-top: 8px; line-height: 1.7" v-html="md(result.comment || '')"></p>
            <template v-if="result.referenceAnswer">
              <h3>参考答案</h3>
              <div class="md-body" v-html="md(result.referenceAnswer)"></div>
            </template>
          </div>
        </template>
      </div>

      <div class="card" style="flex: 1">
        <h3>练习记录（可回放 / 继续作答）</h3>
        <div v-if="!history.length" class="empty">暂无记录</div>
        <table v-else>
          <thead><tr><th>ID</th><th>知识点</th><th>结果</th><th>时间</th><th>操作</th></tr></thead>
          <tr v-for="p in history" :key="p.id">
            <td>{{ p.id }}</td>
            <td>{{ p.node_name || '-' }}</td>
            <td>
              <span v-if="p.status === 'open'" class="badge">进行中</span>
              <span v-else class="badge" :class="p.is_correct ? 'done' : 'failed'">{{ p.is_correct ? '正确' : '错误' }}</span>
            </td>
            <td class="muted">{{ p.created_at }}</td>
            <td>
              <button v-if="p.status === 'open'" class="small primary" @click="continuePractice(p)">继续作答</button>
              <button v-else class="small" @click="replay(p)">回放</button>
            </td>
          </tr>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { renderMarkdown } from '../util.js';

const md = renderMarkdown;
const weakNodes = ref([]);
const current = ref(null);
const answer = ref('');
const result = ref(null);
const history = ref([]);
const error = ref('');
const generating = ref(false);
const submitting = ref(false);
const replayMode = ref(false);
const pageLoading = ref(true);

const figure = computed(() => current.value?.figure || null);
const polyPoints = computed(() => (figure.value?.points || []).map((p) => p.join(',')).join(' '));

async function loadBase() {
  const ov = await api.studyOverview();
  weakNodes.value = ov.weakNodes || [];
  history.value = (await api.listPractices()).items;
}

async function generate(nodeId) {
  error.value = '';
  generating.value = true;
  result.value = null;
  answer.value = '';
  replayMode.value = false;
  try {
    current.value = await api.generatePractice(nodeId);
    await loadHistory();
  } catch (e) {
    error.value = e.message;
  } finally {
    generating.value = false;
  }
}

// 进行中的题目：继续完成作答
function continuePractice(p) {
  error.value = '';
  result.value = null;
  replayMode.value = false;
  answer.value = '';
  current.value = {
    id: p.id,
    nodeId: p.node_id,
    nodeName: p.node_name || `知识点#${p.node_id}`,
    question: p.question,
    figure: parseFigure(p.figure)
  };
}

// 已完成的题目：回放（题目 + 当时作答 + 判定结果 + 参考答案）
function replay(p) {
  error.value = '';
  replayMode.value = true;
  answer.value = '';
  current.value = {
    id: p.id,
    nodeId: p.node_id,
    nodeName: p.node_name || `知识点#${p.node_id}`,
    question: p.question,
    figure: parseFigure(p.figure),
    userAnswer: p.user_answer
  };
  result.value = {
    isCorrect: Boolean(p.is_correct),
    comment: p.comment || '',
    byAI: p.status === 'done',
    referenceAnswer: p.reference_answer,
    mastery: null
  };
}

function closeCurrent() {
  current.value = null;
  result.value = null;
  replayMode.value = false;
}

function parseFigure(raw) {
  if (!raw) return null;
  try {
    const f = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return f && typeof f === 'object' && ['polygon', 'circle'].includes(f.type) ? f : null;
  } catch {
    return null;
  }
}

async function loadHistory() {
  history.value = (await api.listPractices()).items;
}

async function submit(selfCorrect) {
  if (!current.value) return;
  submitting.value = true;
  error.value = '';
  try {
    const useAI = selfCorrect === undefined;
    const data = useAI ? { answer: answer.value } : { answer: answer.value, selfCorrect };
    if (!useAI) data.selfCorrect = selfCorrect;
    result.value = await api.submitPractice(current.value.id, data);
    await loadHistory();
    const ov = await api.studyOverview();
    weakNodes.value = ov.weakNodes || [];
  } catch (e) {
    error.value = e.message;
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    await loadBase();
  } catch (e) {
    error.value = e.message;
  } finally {
    pageLoading.value = false;
  }
});
</script>
