<template>
  <div class="page-reserve">
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div v-if="countdowns.length" class="carousel card glass" style="padding: 14px 18px; margin-bottom: 16px">
      <div class="toolbar" style="margin: 0">
        <span class="badge search">倒计时</span>
        <div class="spacer"></div>
        <span class="muted">共 {{ countdowns.length }} 个 · 管理请前往系统设置</span>
      </div>
      <div class="carousel-body">
        <Transition name="cd-slide" mode="out-in">
          <div :key="cdIndex" class="carousel-slide">
            <strong style="font-size: 15px">{{ countdowns[cdIndex].title }}</strong>
            <span class="cd-time">{{ cdText }}</span>
          </div>
        </Transition>
        <WinPipsPager
          class="carousel-pips"
          v-model:SelectedPageIndex="cdIndex"
          :NumberOfPages="countdowns.length"
          HorizontalAlignment="Center" />
      </div>
    </div>

    <!-- AI 加油站：WinInfoBar（长短消息、可关闭、可含操作按钮）。
         关闭后本次会话保持关闭（切换页面回来不再显示），刷新页面重新显示 -->
    <WinInfoBar
      class="encourage-infobar"
      v-model:IsOpen="gasOpen"
      Severity="Success"
      :Title="encourageTitle"
      :Message="encourageText || '每一次弄懂错题，都是知识网络亮起的一格。'"
      IsClosable="True">
      <template #ActionButton>
        <WinButton
          :IsEnabled="!encourageLoading"
          @Click="refreshEncourage"
          v-bind="{ 'tooltipservice.tooltip': '换一句鼓励语' }">
          <WinTextBlock :Text="encourageLoading ? '刷新中…' : '刷新'" />
        </WinButton>
      </template>
    </WinInfoBar>

    <div class="toolbar">
      <div class="spacer"></div>
      <button class="small" @click="load">刷新</button>
    </div>

    <div class="grid-stats">
      <div class="stat"><div class="num"><AnimatedNumber :value="c.materials" /></div><div class="label">学习材料</div></div>
      <div class="stat orange"><div class="num"><AnimatedNumber :value="c.pendingMaterials" /></div><div class="label">待分析材料</div></div>
      <div class="stat"><div class="num"><AnimatedNumber :value="c.nodes" /></div><div class="label">知识点节点</div></div>
      <div class="stat green"><div class="num"><AnimatedNumber :value="c.edges" /></div><div class="label">关系边</div></div>
      <div class="stat green"><div class="num"><AnimatedNumber :value="c.subGraphs" /></div><div class="label">子知识网</div></div>
      <div class="stat orange"><div class="num"><AnimatedNumber :value="study.reviewDueCount ?? 0" /></div><div class="label">待复习（记忆曲线）</div></div>
      <div class="stat"><div class="num"><AnimatedNumber :value="study.wrongTotal ?? 0" /></div><div class="label">错题总数</div></div>
    </div>

    <div class="row" style="align-items: stretch">
      <div class="card" style="flex: 2">
        <div class="toolbar" style="margin-bottom: 4px">
          <h3 style="margin: 0">学情概览</h3>
          <div class="spacer"></div>
          <router-link to="/study">进入学情分析 →</router-link>
        </div>
        <div v-if="!study.subjectAverages?.length && !study.causeDistribution?.length" class="empty" style="padding: 18px 0">
          录入考试与错题后，这里将展示各科掌握度与错因分布
        </div>
        <div class="row" v-else style="align-items: flex-start">
          <div style="flex: 1.2">
            <div class="muted" style="margin-bottom: 6px">各科平均掌握度</div>
            <div v-for="s in study.subjectAverages || []" :key="s.subject" class="mastery-bar-row">
              <span style="width: 44px">{{ s.subject }}</span>
              <span class="bar"><div :style="{ width: s.mastery + '%', background: barColor(s.mastery) }"></div></span>
              <span style="width: 40px; text-align: right" :style="{ color: barColor(s.mastery) }">{{ s.mastery }}%</span>
            </div>
            <div class="muted" style="margin-top: 10px">
              练习正确率：<strong>{{ study.practiceStats?.rate != null ? study.practiceStats.rate + '%' : '-' }}</strong>
               · 待复习：<strong style="color: var(--warn)">{{ study.reviewDueCount || 0 }}</strong> 个知识点
            </div>
          </div>
          <div style="flex: 1">
            <div class="muted" style="margin-bottom: 6px">错因标签</div>
            <span
              v-for="cd in study.causeDistribution || []"
              :key="cd.cause"
              class="cause-tag"
              :style="{ background: causeColor(cd.cause) + '22', color: causeColor(cd.cause), borderColor: causeColor(cd.cause) + '66' }"
            >
              {{ cd.cause }} × {{ cd.count }}
            </span>
            <div v-if="!study.causeDistribution?.length" class="muted">暂无错因数据</div>
            <div class="muted" style="margin-top: 12px">
              薄弱知识点：
              <span v-for="n in (study.weakNodes || []).slice(0, 3)" :key="n.id" class="chip" @click="$router.push('/qa?tab=graph&node=' + n.id)">
                {{ n.name }} {{ n.mastery }}%
              </span>
              <span v-if="!study.weakNodes?.length">-</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="row">
      <div class="card">
        <h3>最近分析任务</h3>
        <div v-if="!data.recentJobs?.length" class="empty">暂无分析任务</div>
        <table v-else>
          <tr v-for="j in data.recentJobs" :key="j.id">
            <td>#{{ j.id }}</td>
            <td>{{ j.title }}</td>
            <td><span class="badge" :class="j.status">{{ STATUS_TEXT[j.status] || j.status }}</span></td>
            <td class="muted">
              <span class="job-ring-inline">
                <WinProgressRing
                  IsIndeterminate="False"
                  :Value="Math.max(0, Math.min(100, Number(j.progress) || 0))"
                  Width="18"
                  Height="18" />
                {{ Math.round(Number(j.progress) || 0) }}% {{ j.step }}
              </span>
            </td>
          </tr>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import WinProgressRing from '../winui/components/WinProgressRing.vue';
import WinPipsPager from '../winui/components/WinPipsPager.vue';
import WinInfoBar from '../winui/components/WinInfoBar.vue';
import WinButton from '../winui/components/WinButton.vue';
import WinTextBlock from '../winui/components/WinTextBlock.vue';
import { api } from '../api.js';
import { STATUS_TEXT, causeColor } from '../util.js';
import AnimatedNumber from '../components/AnimatedNumber.vue';
import { aiGasClosed } from '../dashboardState.js';

const data = ref({});
const study = ref({});
const countdowns = ref([]);
const cdIndex = ref(0);
// 每秒刷新的基准时间：倒计时由前端基于 target_time 实时递减，不再依赖后端轮询
const now = ref(Date.now());
const encourageText = ref('');
const encourageSource = ref('');
const encourageLoading = ref(false);
const pageLoading = ref(true);
let timer = null;
let cdTimer = null;
let tickTimer = null;

function barColor(v) {
  return v >= 80 ? '#27c8a0' : v >= 60 ? '#f0a938' : '#ef5f6b';
}

const c = computed(() => data.value.counts || {});
// AI 加油站（InfoBar）开关：桥接模块级关闭状态。
// 关闭 → 模块状态置位（切换页面回来不再显示）；刷新页面 → 模块重置 → 重新显示
const gasOpen = computed({
  get: () => !aiGasClosed.value,
  set: (v) => {
    if (!v) aiGasClosed.value = true;
  }
});
const encourageTitle = computed(() => {
  const base = 'AI 加油站';
  if (encourageSource.value === 'ai') return `${base} · AI 生成`;
  if (encourageSource.value) return `${base} · 离线模板`;
  return base;
});
const cdText = computed(() => {
  const item = countdowns.value[cdIndex.value];
  if (!item) return '';
  // 基于后端下发的目标时间 target_time，由前端每秒实时计算剩余时间
  const ms = new Date(item.target_time).getTime() - now.value;
  if (ms <= 0) return '已到时间';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return days > 0 ? `还剩 ${days} 天 ${hours} 小时 ${mins} 分 ${secs} 秒` : `还剩 ${hours} 小时 ${mins} 分 ${secs} 秒`;
});

async function load() {
  try {
    data.value = await api.monitor();
  } catch {
    /* 后端未启动时静默 */
  }
  try {
    study.value = await api.studyOverview();
  } catch {
    /* 忽略 */
  }
}

async function loadCountdowns() {
  try {
    countdowns.value = (await api.listCountdowns()).items;
    if (cdIndex.value >= countdowns.value.length) cdIndex.value = 0;
  } catch {
    /* 忽略 */
  }
}

async function loadEncourage() {
  encourageLoading.value = true;
  try {
    const r = await api.encourage();
    encourageText.value = r.text;
    encourageSource.value = r.source;
  } catch {
    encourageText.value = '';
  } finally {
    encourageLoading.value = false;
  }
}

async function refreshEncourage() {
  encourageLoading.value = true;
  try {
    const r = await api.encourageRefresh();
    encourageText.value = r.text;
    encourageSource.value = r.source;
  } catch {
    encourageText.value = '';
  } finally {
    encourageLoading.value = false;
  }
}

onMounted(() => {
  Promise.all([load(), loadCountdowns()]).finally(() => {
    pageLoading.value = false;
  });
  loadEncourage();
  timer = setInterval(load, 8000);
  cdTimer = setInterval(() => {
    // 轮播：多个倒计时之间切换展示（5 秒一个）
    if (countdowns.value.length) cdIndex.value = (cdIndex.value + 1) % countdowns.value.length;
  }, 5000);
  // 前端每秒驱动倒计时文本实时更新
  tickTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  clearInterval(timer);
  clearInterval(cdTimer);
  clearInterval(tickTimer);
});
</script>
