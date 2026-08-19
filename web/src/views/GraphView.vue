<template>
  <div>
    <div class="card">
      <div class="toolbar">
        <WinComboBox
          :ItemsSource="subjectFilterOptions"
          DisplayMemberPath="label"
          SelectedValuePath="value"
          v-model:SelectedValue="filter.subject"
          Width="150" />
        <input v-model="filter.keyword" placeholder="按知识点名称/描述筛选" style="width: 220px" @keyup.enter="reload" />
        <button class="primary small" @click="focusNode = null; reload()">查询</button>
        <button class="small" @click="reset">重置</button>
        <div class="spacer"></div>
        <button class="small" @click="openCreateNode">＋ 知识点</button>
        <button class="small" :disabled="!detail" @click="openCreateSubGraph">＋ 子知识网</button>
        <button class="small" @click="toggleFullscreen">{{ isFullscreen ? '退出全屏' : '⛶ 全屏' }}</button>
        <span class="muted">{{ graph.nodes.length }}/{{ graph.nodeTotal ?? graph.nodes.length }} 节点 · {{ graph.edges.length }}/{{ graph.edgeTotal ?? graph.edges.length }} 关系</span>
      </div>
      <div class="tabs" style="margin: 0">
        <button :class="{ active: mode === 'graph' }" @click="mode = 'graph'">图谱视图</button>
        <button :class="{ active: mode === 'tree' }" @click="mode = 'tree'">学习树视图</button>
        <button :class="{ active: mode === 'markdown' }" @click="mode = 'markdown'">Markdown 结构</button>
      </div>
    </div>

    <div v-if="error" class="error-box">{{ error }}</div>

    <div v-if="mode === 'markdown'" class="card">
      <div class="toolbar">
        <h3 style="margin: 0">知识图谱结构（Markdown）</h3>
        <div class="spacer"></div>
        <button class="small" @click="copyMd">复制</button>
      </div>
      <pre class="md-text">{{ markdown }}</pre>
    </div>

    <template v-else>
      <div class="row" style="align-items: flex-start">
        <div ref="fsHost" class="card fs-host" style="flex: 3">
          <div v-if="!graph.nodes.length" class="empty">图谱为空，请先分析材料，或点击"＋ 知识点"手动创建</div>
          <div v-show="mode === 'graph' && graph.nodes.length" ref="chartEl" class="graph-wrap"></div>

          <div v-if="mode === 'tree' && graph.nodes.length" class="tree-wrap">
            <div v-for="branch in treeData" :key="branch.subject" class="tree-section">
              <details open>
                <summary>
                  <span class="badge">{{ branch.subject }}</span>
                  <span class="muted" style="margin-left: 8px">{{ subjectCount(branch) }} 个知识点</span>
                </summary>
                <details v-for="g in groupsOf(branch)" :key="g.id" open class="tree-group">
                  <summary>
                    <strong>{{ g.name }}</strong>
                    <span class="muted" style="margin-left: 6px">（{{ g.nodes.length }} 个知识点）</span>
                    <button class="small danger" style="margin-left: 8px" @click.stop="removeSubGraph(g)">删除子网</button>
                  </summary>
                  <div
                    v-for="n in g.nodes"
                    :key="n.id"
                    class="node-row"
                    :class="{ selected: selectedId === n.id }"
                    @click="selectNode(n.id)"
                  >
                    <span class="dot"></span>
                    <span>{{ n.name }}</span>
                    <span v-if="n.category" class="muted" style="font-size: 12px">（{{ n.category }}）</span>
                    <span v-if="n.degree" class="muted" style="font-size: 12px; margin-left: auto">{{ n.degree }} 关联</span>
                  </div>
                </details>
                <details v-if="branch.loose.length" class="tree-group">
                  <summary>
                    <strong>未分组知识点</strong>
                    <span class="muted" style="margin-left: 6px">（{{ branch.loose.length }}）</span>
                  </summary>
                  <div
                    v-for="n in branch.loose"
                    :key="n.id"
                    class="node-row"
                    :class="{ selected: selectedId === n.id }"
                    @click="selectNode(n.id)"
                  >
                    <span class="dot"></span>
                    <span>{{ n.name }}</span>
                    <span v-if="n.category" class="muted" style="font-size: 12px">（{{ n.category }}）</span>
                    <span v-if="n.degree" class="muted" style="font-size: 12px; margin-left: auto">{{ n.degree }} 关联</span>
                  </div>
                </details>
              </details>
            </div>
          </div>

          <div v-if="graph.nodes.length && (graph.nodeTotal ?? 0) > graph.nodes.length && !focusNode" class="toolbar" style="justify-content: center">
            <button class="small" :disabled="loadingMore" @click="loadMore">
              <span v-if="loadingMore" class="loading"></span>加载更多（还有 {{ (graph.nodeTotal ?? 0) - graph.nodes.length }} 个节点）
            </button>
          </div>
        </div>

        <div class="card" style="flex: 1.4; min-width: 300px">
          <template v-if="detail">
            <div class="toolbar" style="margin-bottom: 4px">
              <h3 style="margin: 0">{{ detail.node.name }}</h3>
              <div class="spacer"></div>
              <button v-if="!editMode" class="small" @click="startEdit">编辑</button>
              <button class="small danger" @click="removeNode">删除</button>
            </div>

            <template v-if="editMode">
              <label class="field"><span>名称</span><input v-model="editForm.name" /></label>
              <div class="row">
                <label class="field"><span>科目</span><input v-model="editForm.subject" placeholder="如：数学" /></label>
                <label class="field"><span>分类</span><input v-model="editForm.category" placeholder="概念/方法/公式…" /></label>
              </div>
              <label class="field"><span>分册</span><input v-model="editForm.volume" placeholder="如：必修一" /></label>
              <label class="field"><span>讲解/描述</span><textarea v-model="editForm.description" rows="3"></textarea></label>
              <div class="toolbar">
                <button class="primary small" :disabled="savingNode" @click="saveEdit">
                  <span v-if="savingNode" class="loading"></span>保存修改
                </button>
                <button class="small" @click="editMode = false">取消</button>
              </div>
            </template>

            <template v-else>
              <div class="kv">
                <span class="k">科目</span><span>{{ detail.node.subject || '-' }}</span>
                <span class="k">分类</span><span>{{ detail.node.category || '-' }}</span>
                <span class="k">分册</span><span>{{ detail.node.volume || '-' }}</span>
              </div>

              <div class="toolbar" style="margin-bottom: 6px">
                <button class="small primary" :disabled="explainLoading" @click="explain(false)">
                  <span v-if="explainLoading" class="loading"></span>{{ detail.node.description ? '查看/生成讲解' : 'AI 讲解' }}
                </button>
                <button v-if="detail.node.description" class="small" :disabled="explainLoading" @click="explain(true)">
                  重新生成
                </button>
                <span v-if="explainSource === 'ai'" class="badge search">AI 生成</span>
                <span v-else-if="explainSource === 'stored'" class="badge done">已存档讲解</span>
                <span v-else-if="explainSource === 'none'" class="badge pending">暂无讲解</span>
              </div>
              <div
                v-if="explainText"
                class="md-body"
                style="background: var(--panel-2); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px"
                v-html="md(explainText)"
              ></div>
              <p v-else-if="detail.node.description" class="muted" style="line-height: 1.7; margin-bottom: 10px" v-html="md(detail.node.description)"></p>
              <p v-else class="muted" style="margin-bottom: 10px">该知识点暂无讲解，可点击上方按钮由 AI 生成。</p>
            </template>

            <div class="toolbar">
              <button class="small primary" @click="expand(detail.node.id)">展开邻域</button>
              <span class="muted">关系 {{ detail.edges.length }} 条</span>
            </div>
            <div v-for="e in detail.edges" :key="e.id" class="node-row" style="cursor: pointer">
              <span @click="jump(e.other?.id)">
                <span class="muted">{{ e.direction === 'out' ? '→' : '←' }}</span>
                <strong>{{ e.relation }}</strong>
                {{ e.other?.name }}
              </span>
              <button class="small danger" style="margin-left: auto" title="删除该关系" @click.stop="removeEdge(e)">✕</button>
            </div>

            <div class="toolbar" style="margin-top: 8px">
              <WinComboBox
                :ItemsSource="edgeTargetOptions"
                DisplayMemberPath="label"
                SelectedValuePath="value"
                v-model:SelectedValue="newEdge.targetId"
                PlaceholderText="选择目标知识点…" />
              <input v-model="newEdge.relation" placeholder="关系，如：包含" style="width: 110px" />
              <button class="small primary" :disabled="!newEdge.targetId" @click="addEdge">＋ 关系</button>
            </div>

            <h3 style="margin-top: 12px">所属子知识网</h3>
            <div v-if="!detail.subGraphs.length" class="muted">-</div>
            <div v-for="s in detail.subGraphs" :key="s.id" class="toolbar" style="margin: 2px 0">
              <span class="chip" style="margin: 0">{{ s.name }}</span>
              <button class="small" title="将该知识点移出此子网" @click="leaveSubGraph(s)">移出</button>
            </div>

            <h3 style="margin-top: 12px">来源材料（出处）</h3>
            <div v-if="!detail.materials.length" class="muted">-</div>
            <div v-for="m in detail.materials" :key="m.id">
              <router-link :to="`/materials?focus=${m.id}`">《{{ m.title }}》</router-link>
              <span class="badge" :class="m.status" style="margin-left: 6px">{{ m.status }}</span>
            </div>
          </template>
          <template v-else>
            <h3>节点详情</h3>
            <div class="empty">点击图中节点或学习树条目：查看/编辑、关系与出处</div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import * as echarts from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api } from '../api.js';
import { renderMarkdown } from '../util.js';
import { chartPalette } from '../charts.js';
import { winConfirm, winAlert, winPrompt } from '../dialogs.js';
import WinComboBox from '../winui/components/WinComboBox.vue';

echarts.use([GraphChart, TooltipComponent, LegendComponent, CanvasRenderer]);

const route = useRoute();
const md = renderMarkdown;
const graph = ref({ nodes: [], edges: [], subGraphs: [], subjects: [], nodeTotal: 0, edgeTotal: 0 });
const subjects = computed(() => graph.value.subjects || []);
const subjectFilterOptions = computed(() => [
  { label: '全部科目', value: '' },
  ...subjects.value.map((s) => ({ label: s, value: s }))
]);
const edgeTargetOptions = computed(() => [
  { label: '选择目标知识点…', value: '' },
  ...edgeTargets.value.map((n) => ({ label: `${n.name}（${n.subject || '未分类'}）`, value: n.id }))
]);
const filter = reactive({ subject: '', keyword: '' });
const focusNode = ref(route.query.node ? Number(route.query.node) : null);
const mode = ref('graph');
const detail = ref(null);
const selectedId = ref(null);
const error = ref('');
const chartEl = ref(null);
const fsHost = ref(null);
const isFullscreen = ref(false);
const explainText = ref('');
const explainSource = ref('');
const explainLoading = ref(false);
const editMode = ref(false);
const editForm = reactive({ name: '', subject: '', category: '', volume: '', description: '' });
const savingNode = ref(false);
const newEdge = reactive({ targetId: '', relation: '' });
const loadingMore = ref(false);
const pageLimit = ref(300);
let chart = null;

const CAT_COLORS = ['#4f8cff', '#27c8a0', '#f0a938', '#ef5f6b', '#9d6bff', '#3fc1e0', '#ff8fb1', '#a3d977'];

const treeData = computed(() => {
  const nodes = graph.value.nodes || [];
  const sgs = graph.value.subGraphs || [];
  const bySubject = new Map();
  for (const n of nodes) {
    const s = n.subject || '未分类';
    if (!bySubject.has(s)) bySubject.set(s, { subject: s, groups: new Map(), loose: [] });
  }
  const placed = new Set();
  for (const sg of sgs) {
    for (const nid of sg.node_ids || []) {
      const n = nodes.find((x) => x.id === nid);
      if (!n) continue;
      placed.add(nid);
      const entry = bySubject.get(n.subject || '未分类');
      if (!entry.groups.has(sg.id)) entry.groups.set(sg.id, { id: sg.id, name: sg.name, nodes: [] });
      entry.groups.get(sg.id).nodes.push(n);
    }
  }
  for (const n of nodes) {
    if (!placed.has(n.id)) bySubject.get(n.subject || '未分类').loose.push(n);
  }
  return [...bySubject.values()];
});

const edgeTargets = computed(() =>
  (graph.value.nodes || []).filter((n) => n.id !== detail.value?.node?.id)
);

function groupsOf(branch) {
  return [...branch.groups.values()];
}

function subjectCount(branch) {
  let c = branch.loose.length;
  for (const g of branch.groups.values()) c += g.nodes.length;
  return c;
}

async function load() {
  error.value = '';
  try {
    const params = { limit: pageLimit.value };
    if (filter.subject) params.subject = filter.subject;
    if (filter.keyword) params.keyword = filter.keyword;
    if (focusNode.value) {
      params.nodeId = focusNode.value;
      params.depth = 2;
    }
    graph.value = await api.graph(params);
    await nextTick();
    if (mode.value === 'graph') renderChart();
  } catch (e) {
    error.value = e.message;
  }
}

function reload() {
  pageLimit.value = 300;
  load();
}

async function loadMore() {
  loadingMore.value = true;
  pageLimit.value += 300;
  await load();
  loadingMore.value = false;
}

function reset() {
  filter.subject = '';
  filter.keyword = '';
  focusNode.value = null;
  detail.value = null;
  selectedId.value = null;
  explainText.value = '';
  explainSource.value = '';
  editMode.value = false;
  pageLimit.value = 300;
  load();
}

function renderChart() {
  if (!chartEl.value || !graph.value.nodes.length) return;
  if (!chart) {
    chart = echarts.init(chartEl.value);
    chart.on('click', (ev) => {
      if (ev.dataType === 'node') selectNode(ev.data.id);
    });
  }
  const CP = chartPalette();
  const subjectList = [...new Set(graph.value.nodes.map((n) => n.subject || '未分类'))];
  const catIndex = new Map(subjectList.map((s, i) => [s, i]));
  chart.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: {
        formatter: (p) =>
          p.dataType === 'node'
            ? `<b>${p.data.name}</b><br/>科目：${p.data.subject || '未分类'}<br/>度：${p.data.degree}`
            : `${p.data.relation}`
      },
      legend: { data: subjectList, textStyle: { color: CP.axisLabel }, top: 8 },
      series: [
        {
          type: 'graph',
          layout: 'force',
          roam: true,
          draggable: true,
          label: { show: true, color: CP.nodeLabel, fontSize: 11 },
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 7,
          lineStyle: { color: CP.edgeLine, width: 1.2, curveness: 0.08 },
          force: { repulsion: 320, edgeLength: [70, 160], gravity: 0.08 },
          categories: subjectList.map((s, i) => ({
            name: s,
            itemStyle: { color: CAT_COLORS[i % CAT_COLORS.length] }
          })),
          data: graph.value.nodes.map((n) => ({
            id: String(n.id),
            name: n.name,
            subject: n.subject,
            degree: n.degree,
            category: catIndex.get(n.subject || '未分类'),
            symbolSize: Math.min(14 + n.degree * 4, 42),
            itemStyle: focusNode.value === n.id ? { borderColor: CP.focusBorder, borderWidth: 3 } : undefined
          })),
          edges: graph.value.edges.map((e) => ({
            source: String(e.source_id),
            target: String(e.target_id),
            relation: e.relation,
            label: { show: graph.value.edges.length <= 30, formatter: e.relation, color: CP.edgeLabel }
          }))
        }
      ]
    },
    true
  );
  chart.resize();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (fsHost.value?.requestFullscreen) {
      await fsHost.value.requestFullscreen();
    } else {
      winAlert({ title: '提示', message: '当前浏览器不支持全屏' });
    }
  } catch {
    /* 忽略全屏权限异常 */
  }
}

function onFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement);
  nextTick(() => chart?.resize());
}

async function selectNode(id) {
  selectedId.value = Number(id);
  editMode.value = false;
  try {
    detail.value = await api.nodeDetail(id);
    explainText.value = '';
    explainSource.value = detail.value.node.description ? 'stored' : '';
    newEdge.targetId = '';
    newEdge.relation = '';
  } catch (e) {
    error.value = e.message;
  }
}

function startEdit() {
  const n = detail.value.node;
  Object.assign(editForm, {
    name: n.name || '',
    subject: n.subject || '',
    category: n.category || '',
    volume: n.volume || '',
    description: n.description || ''
  });
  editMode.value = true;
}

async function saveEdit() {
  if (!detail.value) return;
  savingNode.value = true;
  error.value = '';
  try {
    await api.updateNode(detail.value.node.id, {
      name: editForm.name,
      subject: editForm.subject || null,
      category: editForm.category || null,
      volume: editForm.volume || null,
      description: editForm.description || null
    });
    editMode.value = false;
    await load();
    await selectNode(detail.value.node.id);
  } catch (e) {
    error.value = e.message;
  } finally {
    savingNode.value = false;
  }
}

async function openCreateNode() {
  const name = await winPrompt({ title: '新建知识点', message: '请输入新知识点名称', inputLabel: '名称' });
  if (!name?.trim()) return;
  const subject = await winPrompt({ title: '新建知识点', message: '科目（可留空）', inputLabel: '科目', defaultValue: filter.subject || '' }) || '';
  const category = await winPrompt({ title: '新建知识点', message: '分类（概念/方法/规律/公式/定理/题型/总结，可留空）', inputLabel: '分类', defaultValue: '概念' }) || '';
  const description = await winPrompt({ title: '新建知识点', message: '简要描述（可留空）', inputLabel: '描述' }) || '';
  try {
    const node = await api.createNode({
      name: name.trim(),
      subject: subject.trim() || null,
      category: category.trim() || null,
      description: description.trim() || null
    });
    await load();
    await selectNode(node.id);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function removeNode() {
  if (!detail.value) return;
  const n = detail.value.node;
  if (!(await winConfirm({ title: '删除确认', message: `删除知识点「${n.name}」？其关联关系将一并删除。`, danger: true }))) return;
  try {
    await api.deleteNode(n.id);
    detail.value = null;
    selectedId.value = null;
    await load();
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function addEdge() {
  if (!detail.value || !newEdge.targetId) return;
  try {
    await api.createEdge({
      sourceId: detail.value.node.id,
      targetId: Number(newEdge.targetId),
      relation: newEdge.relation.trim() || '相关'
    });
    newEdge.targetId = '';
    newEdge.relation = '';
    await load();
    await selectNode(detail.value.node.id);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function removeEdge(e) {
  if (!(await winConfirm({ title: '删除确认', message: `删除关系「${e.relation}」？`, danger: true }))) return;
  try {
    await api.deleteEdge(e.id);
    await load();
    if (detail.value) await selectNode(detail.value.node.id);
  } catch (err) {
    winAlert({ title: '操作失败', message: err.message });
  }
}

async function openCreateSubGraph() {
  const name = await winPrompt({ title: '新建子知识网', message: '子知识网名称（按题目或主题命名）', inputLabel: '名称' });
  if (!name?.trim()) return;
  const description = await winPrompt({ title: '新建子知识网', message: '简述（可留空）', inputLabel: '简述' }) || '';
  try {
    await api.createSubGraph({
      name: name.trim(),
      description: description.trim() || null,
      nodeIds: detail.value ? [detail.value.node.id] : []
    });
    await load();
    if (detail.value) await selectNode(detail.value.node.id);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function removeSubGraph(g) {
  if (!(await winConfirm({ title: '删除确认', message: `删除子知识网「${g.name}」？（不影响知识点本身）`, danger: true }))) return;
  try {
    await api.deleteSubGraph(g.id);
    await load();
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function leaveSubGraph(s) {
  if (!detail.value) return;
  try {
    await api.updateSubGraphNodes(s.id, { remove: [detail.value.node.id] });
    await load();
    await selectNode(detail.value.node.id);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function explain(force) {
  if (!detail.value) return;
  explainLoading.value = true;
  error.value = '';
  try {
    const data = await api.nodeExplain(detail.value.node.id, force);
    explainText.value = data.description || '';
    explainSource.value = data.source;
    if (data.source === 'ai' && data.description) {
      detail.value = { ...detail.value, node: { ...detail.value.node, description: data.description } };
    }
    if (data.note && data.source === 'none') error.value = data.note;
  } catch (e) {
    error.value = e.message;
  } finally {
    explainLoading.value = false;
  }
}

function expand(id) {
  focusNode.value = id;
  load();
}

function jump(id) {
  if (!id) return;
  focusNode.value = id;
  detail.value = null;
  load();
  nextTick(() => selectNode(id));
}

const markdown = computed(() => {
  const lines = ['# 知识图谱结构', '', `> 节点 ${graph.value.nodes.length} 个，关系 ${graph.value.edges.length} 条`, ''];
  for (const branch of treeData.value) {
    lines.push(`## ${branch.subject}`);
    for (const g of groupsOf(branch)) {
      lines.push(`### ${g.name}`);
      for (const n of g.nodes) lines.push(...nodeLines(n));
    }
    if (branch.loose.length) {
      lines.push('### 未分组知识点');
      for (const n of branch.loose) lines.push(...nodeLines(n));
    }
    lines.push('');
  }
  return lines.join('\n');
});

function nodeLines(n) {
  const outs = graph.value.edges
    .filter((e) => e.source_id === n.id)
    .map((e) => `${e.relation} → ${graph.value.nodes.find((x) => x.id === e.target_id)?.name || e.target_id}`);
  const lines = [`- **${n.name}**${n.category ? `（${n.category}）` : ''}`];
  if (n.description) lines.push(`  - ${n.description}`);
  for (const o of outs) lines.push(`  - ${o}`);
  return lines;
}

async function copyMd() {
  try {
    await navigator.clipboard.writeText(markdown.value);
    winAlert({ title: '提示', message: '已复制到剪贴板' });
  } catch {
    /* 某些浏览器需要安全上下文 */
  }
}

watch(mode, async (v) => {
  if (v === 'graph') {
    await nextTick();
    if (chart) chart.resize();
    else renderChart();
  }
});

window.addEventListener('resize', () => chart?.resize());

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  load().then(() => {
    if (focusNode.value) selectNode(focusNode.value);
  });
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  chart?.dispose();
  chart = null;
});
</script>

<style scoped>
.fs-host:fullscreen {
  background: var(--bg, #0a0e17);
  padding: 16px;
  overflow: auto;
}
.fs-host:fullscreen .graph-wrap {
  height: calc(100vh - 60px);
}
</style>
