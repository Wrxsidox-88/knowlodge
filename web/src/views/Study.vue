<template>
  <div>
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div v-if="error" class="error-box">{{ error }}</div>

    <div class="grid-stats">
      <div class="stat"><div class="num">{{ data.wrongTotal ?? 0 }}</div><div class="label">错题总数</div></div>
      <div class="stat orange"><div class="num">{{ data.reviewDueCount ?? 0 }}</div><div class="label">待复习（记忆曲线到期）</div></div>
      <div class="stat green"><div class="num">{{ data.practiceStats?.rate != null ? data.practiceStats.rate + '%' : '-' }}</div><div class="label">练习正确率</div></div>
      <div class="stat"><div class="num">{{ data.weakNodes?.length ?? 0 }}</div><div class="label">薄弱知识点（Top）</div></div>
    </div>

    <div class="row" style="align-items: flex-start">
      <div class="card">
        <div class="toolbar" style="margin-bottom: 4px">
          <h3 style="margin: 0">薄弱知识点雷达图</h3>
          <WinComboBox
            :ItemsSource="subjectOptions"
            DisplayMemberPath="label"
            SelectedValuePath="value"
            v-model:SelectedValue="subject"
            @SelectionChanged="load"
            Width="150" />
        </div>
        <div v-if="!radarHasData" class="empty">录入并分析错题后生成雷达图</div>
        <div v-else ref="radarEl" style="height: 340px"></div>
      </div>
      <div class="card">
        <h3>错因标签分布</h3>
        <div v-if="!data.causeDistribution?.length" class="empty">暂无错因数据</div>
        <div v-else ref="causeEl" style="height: 340px"></div>
      </div>
    </div>

    <div class="row" style="align-items: flex-start">
      <div class="card">
        <h3>知识点掌握度（薄弱 Top，越低越需加强）</h3>
        <div v-if="!data.weakNodes?.length" class="empty">暂无掌握度数据</div>
        <div v-else ref="weakEl" :style="{ height: weakHeight + 'px' }"></div>
      </div>
      <div class="card">
        <div class="toolbar" style="margin-bottom: 4px">
          <h3 style="margin: 0">成绩波动趋势（得分率 %）</h3>
          <WinComboBox
            :ItemsSource="windowOptions"
            DisplayMemberPath="label"
            SelectedValuePath="value"
            v-model:SelectedValue="trendWindow"
            @SelectionChanged="load"
            Width="140" />
          <WinComboBox
            :ItemsSource="trendMetricOptions"
            DisplayMemberPath="label"
            SelectedValuePath="value"
            v-model:SelectedValue="trendMetric"
            @SelectionChanged="renderTrend"
            Width="130" />
        </div>
        <div class="muted" style="font-size: 12px; margin-bottom: 6px">
          目标线（虚线）取自设置页「目标成绩」；近期平均线（点线）取筛选窗口内各科平均值。
        </div>
        <div v-if="!data.trend?.length" class="empty">登记考试后显示</div>
        <div v-else ref="trendEl" style="height: 320px"></div>
      </div>
    </div>

    <div class="row" style="align-items: flex-start">
      <div class="card">
        <h3>薄弱知识点标签（点击查看图谱讲解）</h3>
        <div v-if="!data.weakNodes?.length" class="empty">暂无数据</div>
        <template v-else>
          <span
            v-for="n in data.weakNodes"
            :key="n.id"
            class="weak-tag"
            :class="masteryLevel(n.mastery)"
            @click="$router.push('/graph?node=' + n.id)"
          >
            {{ n.name }}
            <em>{{ n.mastery }}%</em>
            <i class="muted">{{ n.subject }}</i>
          </span>
          <div class="muted" style="margin-top: 8px">
            掌握度 = 练习正确率 × 记忆保持系数（随时间衰减，复习可恢复）。颜色：绿≥80 / 黄≥60 / 红&lt;60
          </div>
        </template>
      </div>
      <div class="card">
        <h3>今日复习提醒（艾宾浩斯曲线）</h3>
        <div v-if="!data.reviewDue?.length" class="empty">暂无到期复习任务</div>
        <div v-for="r in data.reviewDue" :key="r.node_id" class="node-card">
          <div class="toolbar" style="margin: 0">
            <span class="name">{{ r.name }}</span>
            <span class="badge">{{ r.subject || '未分类' }}</span>
            <span class="muted">已错 {{ r.wrong }} 次 · 第 {{ r.stage + 1 }} 轮</span>
            <div class="spacer"></div>
            <button class="small primary" :disabled="doing === r.node_id" @click="done(r)">
              <span v-if="doing === r.node_id" class="loading"></span>完成复习
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../api.js';
import WinComboBox from '../winui/components/WinComboBox.vue';
import echarts, { CHART_COLORS, AXIS_STYLE, chartPalette } from '../charts.js';
import { CAUSE_COLORS, masteryLevel, causeColor } from '../util.js';

const data = ref({});
const subject = ref('');
const error = ref('');
const doing = ref(null);
const pageLoading = ref(true);
const radarEl = ref(null);
const causeEl = ref(null);
const weakEl = ref(null);
const trendEl = ref(null);
const trendWindow = ref('');
const trendMetric = ref('pct');
const charts = [];
const subjectOptions = computed(() => [
  { label: '全部科目', value: '' },
  ...((data.value.subjects) || []).map((s) => ({ label: s, value: s }))
]);

const windowOptions = [
  { label: '全部时间', value: '' },
  { label: '近 30 天', value: '30d' },
  { label: '近 90 天', value: '90d' },
  { label: '近 180 天', value: '180d' },
  { label: '近一年', value: '365d' }
];
const trendMetricOptions = [
  { label: '得分率 %', value: 'pct' },
  { label: '年级排名', value: 'grade' },
  { label: '班级排名', value: 'class' }
];

const radarHasData = computed(() => (data.value.radar?.indicators?.length || 0) > 0);
const weakHeight = computed(() => Math.max(220, (data.value.weakNodes?.length || 0) * 34 + 60));

function windowDateRange(window) {
  if (!window) return { dateFrom: null, dateTo: null };
  const days = Number(window.replace('d', ''));
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

async function load() {
  try {
    const { dateFrom, dateTo } = windowDateRange(trendWindow.value);
    data.value = await api.studyOverview(subject.value || undefined, { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined });
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
  renderRadar();
  renderCause();
  renderWeak();
  renderTrend();
}

function renderRadar() {
  if (!radarHasData.value) return;
  const CP = chartPalette();
  const c = chartOf(radarEl);
  c.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: {},
      radar: {
        indicator: data.value.radar.indicators.map((name) => ({ name, max: 100 })),
        splitArea: { areaStyle: { color: ['rgba(79,140,255,0.04)', 'rgba(79,140,255,0.08)'] } },
        axisLine: { lineStyle: { color: CP.axisLine } },
        splitLine: { lineStyle: { color: CP.splitLine } },
        axisName: { color: CP.label, fontSize: 12 }
      },
      series: [
        {
          type: 'radar',
          data: [
            {
              value: data.value.radar.values,
              name: '掌握度',
              areaStyle: { color: 'rgba(239,95,107,0.25)' },
              lineStyle: { color: '#ef5f6b', width: 2 },
              itemStyle: { color: '#ef5f6b' }
            }
          ]
        }
      ]
    },
    true
  );
}

function renderCause() {
  if (!data.value.causeDistribution?.length) return;
  const CP = chartPalette();
  const c = chartOf(causeEl);
  c.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', formatter: '{b}：{c} 道（{d}%）' },
      legend: { bottom: 0, textStyle: { color: CP.axisLabel } },
      series: [
        {
          type: 'pie',
          radius: ['42%', '68%'],
          center: ['50%', '45%'],
          label: { color: CP.label, formatter: '{b}\n{c}道' },
          data: data.value.causeDistribution.map((r) => ({
            name: r.cause,
            value: r.count,
            itemStyle: { color: causeColor(r.cause) }
          }))
        }
      ]
    },
    true
  );
}

function renderWeak() {
  if (!data.value.weakNodes?.length) return;
  const CP = chartPalette();
  const c = chartOf(weakEl);
  const nodes = [...data.value.weakNodes].reverse();
  c.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { formatter: (p) => `${p.name}：掌握度 ${p.value}%` },
      grid: { left: 120, right: 40, top: 10, bottom: 24 },
      xAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', color: CP.axisLabel }, splitLine: AXIS_STYLE.splitLine },
      yAxis: { type: 'category', data: nodes.map((n) => n.name), ...AXIS_STYLE },
      series: [
        {
          type: 'bar',
          data: nodes.map((n) => ({
            value: n.mastery,
            itemStyle: { color: n.mastery >= 80 ? '#27c8a0' : n.mastery >= 60 ? '#f0a938' : '#ef5f6b', borderRadius: [0, 6, 6, 0] }
          })),
          barMaxWidth: 18,
          label: { show: true, position: 'right', formatter: '{c}%', color: CP.label }
        }
      ]
    },
    true
  );
}

function trendValue(t) {
  if (trendMetric.value === 'grade') return t.grade_rank ?? null;
  if (trendMetric.value === 'class') return t.class_rank ?? null;
  return t.pct;
}

function renderTrend() {
  if (!data.value.trend?.length) return;
  const CP = chartPalette();
  const c = chartOf(trendEl);
  const bySubject = new Map();
  for (const t of data.value.trend) {
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject).push(t);
  }
  const isRank = trendMetric.value === 'grade' || trendMetric.value === 'class';
  const xDates = [...new Set(data.value.trend.map((t) => t.exam_date))].sort();
  const series = [...bySubject.entries()].map(([s, list], i) => ({
    name: s,
    type: 'line',
    smooth: true,
    symbolSize: 8,
    connectNulls: false,
    lineStyle: { width: 3, color: CHART_COLORS[i % CHART_COLORS.length] },
    itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] },
    data: list.map((t) => [t.exam_date, trendValue(t)])
  }));

  // 近期平均线：筛选窗口内各科平均值（按当前指标），作为虚线
  const avgSeries = [];
  for (const [s, list] of bySubject.entries()) {
    const vals = list.map(trendValue).filter((v) => v != null);
    if (!vals.length) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    avgSeries.push({
      name: `${s} 近期平均`,
      type: 'line',
      smooth: false,
      symbol: 'none',
      lineStyle: { width: 1.5, type: 'dotted', color: CHART_COLORS[[...bySubject.keys()].indexOf(s) % CHART_COLORS.length] },
      itemStyle: { color: CHART_COLORS[[...bySubject.keys()].indexOf(s) % CHART_COLORS.length] },
      data: xDates.map((d) => [d, Math.round(avg * 10) / 10]),
      tooltip: { show: false }
    });
  }
  series.push(...avgSeries);

  // 目标线：设置页「目标成绩」（得分率按目标分数/满分换算；排名取目标排名）
  const targetSeries = [];
  const targets = data.value.targets || {};
  const addTargetLine = (name, val) => {
    if (val == null || val === '') return;
    targetSeries.push({
      name,
      type: 'line',
      smooth: false,
      symbol: 'none',
      lineStyle: { width: 2, type: 'dashed', color: '#ffd24a' },
      itemStyle: { color: '#ffd24a' },
      data: xDates.map((d) => [d, val]),
      tooltip: { show: false },
      z: 5
    });
  };
  if (!isRank) {
    // 得分率视图：每科目标（若该科在图中出现）→ 目标得分率；否则总分目标得分率
    for (const s of bySubject.keys()) {
      const sub = targets.subjects?.[s];
      if (sub && sub.score != null && sub.total != null && sub.total > 0) {
        addTargetLine(`${s} 目标`, Math.round((sub.score / sub.total) * 1000) / 10);
      }
    }
    const t = targets.total;
    if (t && t.score != null && t.total != null && t.total > 0) {
      addTargetLine('总分目标', Math.round((t.score / t.total) * 1000) / 10);
    }
  } else if (trendMetric.value === 'grade') {
    for (const s of bySubject.keys()) {
      const sub = targets.subjects?.[s];
      if (sub && sub.gradeRank != null) addTargetLine(`${s} 目标排名`, sub.gradeRank);
    }
    if (targets.total?.gradeRank != null) addTargetLine('总分目标排名', targets.total.gradeRank);
  } else {
    for (const s of bySubject.keys()) {
      const sub = targets.subjects?.[s];
      if (sub && sub.classRank != null) addTargetLine(`${s} 目标排名`, sub.classRank);
    }
    if (targets.total?.classRank != null) addTargetLine('总分目标排名', targets.total.classRank);
  }
  series.push(...targetSeries);

  const yAxis = isRank
    ? { type: 'value', inverse: true, minInterval: 1, axisLabel: { color: CP.axisLabel }, splitLine: AXIS_STYLE.splitLine }
    : { type: 'value', max: 100, axisLabel: { formatter: '{value}%', color: CP.axisLabel }, splitLine: AXIS_STYLE.splitLine };
  const tooltipFmt = isRank ? (v) => `第 ${v} 名` : (v) => `${v}%`;
  c.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', valueFormatter: tooltipFmt },
      legend: { textStyle: { color: CP.axisLabel }, top: 0, type: 'scroll' },
      grid: { left: 44, right: 16, top: 34, bottom: 26 },
      xAxis: { type: 'category', ...AXIS_STYLE },
      yAxis,
      series
    },
    true
  );
}

async function done(r) {
  doing.value = r.node_id;
  try {
    await api.completeReview(r.node_id);
    await load();
  } catch (e) {
    error.value = e.message;
  } finally {
    doing.value = null;
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
