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
          <select v-model="subject" style="width: 130px" @change="load">
            <option value="">全部科目</option>
            <option v-for="s in data.subjects || []" :key="s">{{ s }}</option>
          </select>
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
        <h3>成绩波动趋势（得分率 %）</h3>
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
const charts = [];

const radarHasData = computed(() => (data.value.radar?.indicators?.length || 0) > 0);
const weakHeight = computed(() => Math.max(220, (data.value.weakNodes?.length || 0) * 34 + 60));

async function load() {
  try {
    data.value = await api.studyOverview(subject.value || undefined);
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

function renderTrend() {
  if (!data.value.trend?.length) return;
  const CP = chartPalette();
  const c = chartOf(trendEl);
  const bySubject = new Map();
  for (const t of data.value.trend) {
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject).push(t);
  }
  c.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', valueFormatter: (v) => `${v}%` },
      legend: { textStyle: { color: CP.axisLabel }, top: 0 },
      grid: { left: 44, right: 16, top: 34, bottom: 26 },
      xAxis: { type: 'category', ...AXIS_STYLE },
      yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%', color: CP.axisLabel }, splitLine: AXIS_STYLE.splitLine },
      series: [...bySubject.entries()].map(([s, list], i) => ({
        name: s,
        type: 'line',
        smooth: true,
        symbolSize: 8,
        lineStyle: { width: 3, color: CHART_COLORS[i % CHART_COLORS.length] },
        itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] },
        data: list.map((t) => [t.exam_date, t.pct])
      }))
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
