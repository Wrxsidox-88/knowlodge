<template>
  <div>
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div class="row" style="align-items: flex-start">
      <div class="card" style="max-width: 400px">
        <h3>{{ editing ? '编辑考试记录' : '登记考试/练习' }}</h3>
        <div v-if="error" class="error-box">{{ error }}</div>
        <label class="field"><span>科目 *</span>
          <select v-model="form.subject">
            <option v-for="s in subjects" :key="s">{{ s }}</option>
          </select>
        </label>
        <label class="field"><span>名称（如：期中 / 第3章练习）</span>
          <input v-model="form.title" placeholder="选填" />
        </label>
        <label class="field"><span>所属大型考试（多科目联合考试）</span>
          <input v-model="form.examEventTitle" list="event-options" placeholder="如：高二上学期期中（可留空）" />
          <datalist id="event-options">
            <option v-for="ev in events" :key="ev.id" :value="ev.title">{{ ev.title }}</option>
          </datalist>
        </label>
        <label class="field"><span>日期 *</span>
          <input type="date" v-model="form.examDate" />
        </label>
        <div class="row">
          <label class="field"><span>满分 *</span><input type="number" v-model="form.totalScore" /></label>
          <label class="field"><span>得分 *</span><input type="number" v-model="form.score" /></label>
        </div>
        <label class="field"><span>备注</span><input v-model="form.note" placeholder="选填" /></label>
        <div class="toolbar">
          <button class="primary" :disabled="saving" @click="save">
            <span v-if="saving" class="loading"></span>{{ editing ? '保存修改' : '登记' }}
          </button>
          <button v-if="editing" @click="cancelEdit">取消</button>
        </div>
        <div class="muted">成绩趋势图将按科目自动汇总；重复的考试记录会被拒绝录入。</div>
      </div>

      <div class="card" style="flex: 2">
        <div class="toolbar">
          <h3 style="margin: 0">成绩波动趋势</h3>
          <select v-model="trendSubject" style="width: 140px" @change="loadTrend">
            <option value="">全部科目</option>
            <option v-for="s in usedSubjects" :key="s">{{ s }}</option>
          </select>
        </div>
        <div v-if="trend.length < 1" class="empty">登记考试后在此显示得分率趋势</div>
        <div v-else ref="trendEl" style="height: 280px"></div>
      </div>
    </div>

    <div class="card">
      <h3>历史考试记录（{{ items.length }}）</h3>
      <div v-if="!items.length" class="empty">暂无记录</div>
      <table v-else>
        <thead>
          <tr><th>ID</th><th>科目</th><th>名称</th><th>所属大考</th><th>日期</th><th>得分</th><th>得分率</th><th>备注</th><th>操作</th></tr>
        </thead>
        <tr v-for="e in items" :key="e.id">
          <td>{{ e.id }}</td>
          <td><span class="badge search">{{ e.subject }}</span></td>
          <td>{{ e.title || '-' }}</td>
          <td>
            <a v-if="e.event_title" href="javascript:void(0)" @click="viewEvent(e.exam_event_id)">{{ e.event_title }}</a>
            <span v-else class="muted">-</span>
          </td>
          <td class="muted">{{ e.exam_date }}</td>
          <td>{{ e.score }} / {{ e.total_score }}</td>
          <td>
            <span class="score-bar"><div :style="{ width: pct(e) + '%' }"></div></span>
            <span :style="{ color: pctColor(pct(e)) }">{{ pct(e) }}%</span>
          </td>
          <td class="muted">{{ e.note || '-' }}</td>
          <td>
            <button class="small" @click="edit(e)">编辑</button>
            <button class="small danger" @click="del(e)">删除</button>
          </td>
        </tr>
      </table>
    </div>

    <div class="card">
      <div class="toolbar">
        <h3 style="margin: 0">大型考试总览（多科目联合分析）</h3>
        <select v-model="selectedEvent" style="width: 220px" @change="loadEvent">
          <option value="">选择考试事件</option>
          <option v-for="ev in events" :key="ev.id" :value="ev.id">
            {{ ev.title }}（{{ ev.subject_count }}科 {{ ev.score }}/{{ ev.total_score }}）
          </option>
        </select>
        <button class="small" @click="loadEvents">刷新</button>
      </div>

      <div v-if="eventDetail" style="margin-top: 8px">
        <div class="grid-stats">
          <div class="stat green"><div class="num">{{ eventDetail.totalGot }}/{{ eventDetail.totalScore }}</div><div class="label">总分</div></div>
          <div class="stat"><div class="num">{{ eventDetail.pct }}%</div><div class="label">总得分率</div></div>
          <div class="stat"><div class="num">{{ eventDetail.subjects.length }}</div><div class="label">参考科目</div></div>
          <div class="stat orange"><div class="num">{{ eventDetail.wrongStats?.length || 0 }}</div><div class="label">错因统计组</div></div>
        </div>
        <div class="row" style="align-items: flex-start">
          <div style="flex: 1.4">
            <div v-for="s in eventDetail.subjects" :key="s.id" class="mastery-bar-row">
              <span style="width: 44px">{{ s.subject }}</span>
              <span class="bar"><div :style="{ width: s.pct + '%', background: barColor(s.pct) }"></div></span>
              <span style="width: 110px; text-align: right">{{ s.score }}/{{ s.total_score }} · {{ s.pct }}%</span>
            </div>
          </div>
          <div style="flex: 1">
            <div class="muted" style="margin-bottom: 6px">该次考试错题分布（科目 × 错因）</div>
            <span
              v-for="(w, i) in eventDetail.wrongStats"
              :key="i"
              class="cause-tag"
              style="margin: 3px 4px 3px 0"
              :style="{ background: causeColor(w.cause) + '22', color: causeColor(w.cause), borderColor: causeColor(w.cause) + '66' }"
            >{{ w.subject }}·{{ w.cause }} × {{ w.count }}</span>
            <div v-if="!eventDetail.wrongStats?.length" class="muted">暂无关联错题</div>
          </div>
        </div>
        <h3 style="margin-top: 12px">总体分析
          <span class="badge" :class="eventDetail.summary?.source === 'ai' ? 'done' : 'pending'" style="margin-left: 8px">
            {{ eventDetail.summary?.source === 'ai' ? 'AI 生成' : '规则生成' }}
          </span>
        </h3>
        <div class="md-body" v-html="md(eventDetail.summary?.text || '')"></div>
      </div>
      <div v-else-if="!events.length" class="empty">在上方登记成绩时填写"所属大型考试"，即可把多个科目归入同一次大考进行总分析</div>
      <div v-else class="empty">选择一次大型考试查看总体分析</div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../api.js';
import echarts, { CHART_COLORS, AXIS_STYLE, chartPalette } from '../charts.js';
import { causeColor, renderMarkdown } from '../util.js';
import { winConfirm } from '../dialogs.js';

const md = renderMarkdown;
const subjects = ['数学', '物理', '化学', '生物', '语文', '英语', '历史', '地理', '政治'];
const items = ref([]);
const events = ref([]);
const selectedEvent = ref('');
const eventDetail = ref(null);
const trend = ref([]);
const trendSubject = ref('');
const error = ref('');
const saving = ref(false);
const editing = ref(null);
const trendEl = ref(null);
const pageLoading = ref(true);
let chart = null;

const form = reactive({ subject: '数学', title: '', examDate: '', totalScore: 100, score: '', note: '', examEventTitle: '' });
const usedSubjects = computed(() => [...new Set(items.value.map((i) => i.subject))]);

function pct(e) {
  return e.total_score ? Math.round((e.score / e.total_score) * 1000) / 10 : 0;
}
function pctColor(v) {
  return v >= 80 ? '#27c8a0' : v >= 60 ? '#f0a938' : '#ef5f6b';
}
const barColor = pctColor;

async function load() {
  items.value = (await api.listExams({})).items;
  await Promise.all([loadTrend(), loadEvents()]);
}

async function loadEvents() {
  events.value = (await api.listExamEvents()).items;
}

async function loadEvent() {
  if (!selectedEvent.value) {
    eventDetail.value = null;
    return;
  }
  eventDetail.value = await api.getExamEvent(selectedEvent.value);
}

async function viewEvent(id) {
  selectedEvent.value = id;
  await loadEvent();
}

async function loadTrend() {
  trend.value = (await api.examTrend(trendSubject.value || undefined)).items;
  await nextTick();
  renderTrend();
}

function renderTrend() {
  if (!trendEl.value || !trend.value.length) return;
  if (!chart) chart = echarts.init(trendEl.value);
  const CP = chartPalette();
  const bySubject = new Map();
  for (const t of trend.value) {
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject).push(t);
  }
  const series = [...bySubject.entries()].map(([s, list], i) => ({
    name: s,
    type: 'line',
    smooth: true,
    symbolSize: 8,
    lineStyle: { width: 3, color: CHART_COLORS[i % CHART_COLORS.length] },
    itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] },
    data: list.map((t) => [t.exam_date, t.pct])
  }));
  chart.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', valueFormatter: (v) => `${v}%` },
      legend: { textStyle: { color: CP.axisLabel }, top: 0 },
      grid: { left: 44, right: 16, top: 36, bottom: 26 },
      xAxis: { type: 'category', ...AXIS_STYLE },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', color: CP.axisLabel }, splitLine: AXIS_STYLE.splitLine },
      series
    },
    true
  );
  chart.resize();
}

async function save() {
  error.value = '';
  saving.value = true;
  try {
    if (editing.value) {
      await api.updateExam(editing.value, {
        subject: form.subject,
        title: form.title,
        examDate: form.examDate,
        totalScore: Number(form.totalScore),
        score: Number(form.score),
        note: form.note,
        examEventTitle: form.examEventTitle || undefined
      });
      editing.value = null;
    } else {
      await api.createExam({
        subject: form.subject,
        title: form.title,
        examDate: form.examDate,
        totalScore: Number(form.totalScore),
        score: Number(form.score),
        note: form.note,
        examEventTitle: form.examEventTitle || undefined
      });
    }
    Object.assign(form, { title: '', score: '', note: '', examEventTitle: '' });
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

function edit(e) {
  editing.value = e.id;
  Object.assign(form, {
    subject: e.subject,
    title: e.title || '',
    examDate: e.exam_date,
    totalScore: e.total_score,
    score: e.score,
    note: e.note || '',
    examEventTitle: e.event_title || ''
  });
}

function cancelEdit() {
  editing.value = null;
}

async function del(e) {
  if (!(await winConfirm({ title: '删除确认', message: `删除考试记录 #${e.id}（${e.subject} ${e.score}/${e.total_score}）？`, danger: true }))) return;
  await api.deleteExam(e.id);
  await load();
}

window.addEventListener('resize', () => chart?.resize());
onMounted(async () => {
  try {
    await load();
  } finally {
    pageLoading.value = false;
  }
});
onBeforeUnmount(() => chart?.dispose());
</script>
