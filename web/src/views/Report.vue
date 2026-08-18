<template>
  <div>
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div v-if="error" class="error-box">{{ error }}</div>

    <div class="grid-stats">
      <div class="stat green"><div class="num">{{ avgMastery }}%</div><div class="label">平均掌握度</div></div>
      <div class="stat"><div class="num">{{ data.wrongTotal ?? 0 }}</div><div class="label">累计错题</div></div>
      <div class="stat"><div class="num">{{ data.practiceStats?.rate != null ? data.practiceStats.rate + '%' : '-' }}</div><div class="label">变式练习正确率</div></div>
      <div class="stat orange"><div class="num">{{ data.reviewDone ?? 0 }}</div><div class="label">已完成复习轮次</div></div>
    </div>

    <div class="row" style="align-items: flex-start">
      <div class="card">
        <h3>各科目考点掌握度</h3>
        <div v-if="!data.subjectAverages?.length" class="empty">暂无数据</div>
        <div v-else ref="subjectEl" style="height: 300px"></div>
      </div>
      <div class="card">
        <h3>错因 × 科目分布</h3>
        <div v-if="!data.wrongBySubject?.length" class="empty">暂无数据</div>
        <div v-else ref="stackEl" style="height: 300px"></div>
      </div>
    </div>

    <div class="card">
      <h3>成长轨迹（成绩得分率趋势）</h3>
      <div v-if="!data.trend?.length" class="empty">登记考试后显示</div>
      <div v-else ref="trendEl" style="height: 260px"></div>
    </div>

    <div class="card">
      <div class="toolbar">
        <h3 style="margin: 0">AI 学情总结</h3>
        <div class="spacer"></div>
        <input v-model="guide" placeholder="关注点（可选），如：数学如何提分" style="width: 260px" />
        <button class="primary" :disabled="summarizing" @click="summary">
          <span v-if="summarizing" class="loading"></span>生成总结
        </button>
      </div>
      <div v-if="summaryNote" class="muted" style="margin-top: 8px">{{ summaryNote }}</div>
      <div v-if="aiSummary" class="md-body" style="margin-top: 10px" v-html="md(aiSummary)"></div>
      <div v-else class="empty">点击上方按钮，AI 将根据考点理解程度与能力提升数据给出总结与建议</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../api.js';
import echarts, { CHART_COLORS, AXIS_STYLE, chartPalette } from '../charts.js';
import { causeColor } from '../util.js';
import { renderMarkdown } from '../util.js';

const md = renderMarkdown;
const data = ref({});
const error = ref('');
const guide = ref('');
const aiSummary = ref('');
const summaryNote = ref('');
const summarizing = ref(false);
const pageLoading = ref(true);
const subjectEl = ref(null);
const stackEl = ref(null);
const trendEl = ref(null);
const charts = [];

const avgMastery = computed(() => {
  const list = data.value.subjectAverages || [];
  if (!list.length) return 0;
  return Math.round(list.reduce((a, b) => a + b.mastery, 0) / list.length);
});

async function load() {
  try {
    data.value = await api.getReport();
    await nextTick();
    renderAll();
  } catch (e) {
    error.value = e.message;
  }
}

function chartOf(el) {
  let c = charts.find((x) => x.getDom() === el.value);
  if (!c && el.value) {
    c = echarts.init(el.value);
    charts.push(c);
  }
  return c;
}

function renderAll() {
  renderSubject();
  renderStack();
  renderTrend();
}

function renderSubject() {
  if (!data.value.subjectAverages?.length) return;
  const CP = chartPalette();
  const c = chartOf(subjectEl);
  const rows = data.value.subjectAverages;
  c.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { formatter: (p) => `${p.name}：${p.value}%（${rows[p.dataIndex].nodes} 个知识点）` },
      grid: { left: 60, right: 30, top: 12, bottom: 26 },
      xAxis: { type: 'category', data: rows.map((r) => r.subject), ...AXIS_STYLE },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', color: CP.axisLabel }, splitLine: AXIS_STYLE.splitLine },
      series: [
        {
          type: 'bar',
          barMaxWidth: 34,
          data: rows.map((r) => ({
            value: r.mastery,
            itemStyle: {
              color: r.mastery >= 80 ? '#27c8a0' : r.mastery >= 60 ? '#f0a938' : '#ef5f6b',
              borderRadius: [6, 6, 0, 0]
            }
          })),
          label: { show: true, position: 'top', formatter: '{c}%', color: CP.label }
        }
      ]
    },
    true
  );
}

function renderStack() {
  if (!data.value.wrongBySubject?.length) return;
  const CP = chartPalette();
  const c = chartOf(stackEl);
  const subjects = [...new Set(data.value.wrongBySubject.map((r) => r.subject))];
  const causesList = [...new Set(data.value.wrongBySubject.map((r) => r.cause))];
  const series = causesList.map((cause) => ({
    name: cause,
    type: 'bar',
    stack: 'total',
    barMaxWidth: 30,
    itemStyle: { color: causeColor(cause) },
    data: subjects.map((s) => data.value.wrongBySubject.find((r) => r.subject === s && r.cause === cause)?.count || 0)
  }));
  c.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { bottom: 0, textStyle: { color: CP.axisLabel } },
      grid: { left: 60, right: 16, top: 12, bottom: 44 },
      xAxis: { type: 'category', data: subjects, ...AXIS_STYLE },
      yAxis: { type: 'value', axisLabel: { color: CP.axisLabel }, splitLine: AXIS_STYLE.splitLine },
      series
    },
    true
  );
}

function renderTrend() {
  if (!data.value.trend?.length) return;
  const CP = chartPalette();
  const c = chartOf(trendEl);
  c.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', valueFormatter: (v) => `${v}%` },
      grid: { left: 44, right: 16, top: 16, bottom: 26 },
      xAxis: { type: 'category', data: data.value.trend.map((t) => `${t.exam_date} ${t.subject}`), ...AXIS_STYLE },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', color: CP.axisLabel }, splitLine: AXIS_STYLE.splitLine },
      series: [
        {
          type: 'line',
          smooth: true,
          symbolSize: 8,
          areaStyle: { color: 'rgba(79,140,255,0.15)' },
          lineStyle: { width: 3, color: '#4f8cff' },
          itemStyle: { color: '#4f8cff' },
          data: data.value.trend.map((t) => t.pct)
        }
      ]
    },
    true
  );
}

async function summary() {
  summarizing.value = true;
  error.value = '';
  try {
    const r = await api.reportSummary(guide.value);
    aiSummary.value = r.summary || '';
    summaryNote.value = r.note || '';
  } catch (e) {
    error.value = e.message;
  } finally {
    summarizing.value = false;
  }
}

const onResize = () => charts.forEach((c) => c.resize());
window.addEventListener('resize', onResize);
onMounted(async () => {
  try {
    await load();
  } finally {
    pageLoading.value = false;
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  charts.forEach((c) => c.dispose());
  charts.length = 0;
});
</script>
