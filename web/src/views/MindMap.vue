<template>
  <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
  <div v-else class="col-stack">
    <!-- 顶部：脑图列表 -->
    <div class="card">
      <div class="toolbar" style="margin-bottom: 8px">
        <h3 style="margin: 0">脑图</h3>
        <div class="spacer"></div>
        <button class="primary small" @click="createMap">新建脑图</button>
      </div>
      <div v-if="!maps.length" class="empty">暂无脑图。可手动新建，或在下方用 AI 引导生成</div>
      <div
        v-for="m in maps"
        :key="m.id"
        class="node-row"
        :class="{ selected: current?.id === m.id }"
        @click="openMap(m.id)"
      >
        <span class="dot"></span>
        <span>{{ m.name }}</span>
        <span class="muted" style="font-size: 11px; margin-left: 6px">{{ m.nodeCount }} 节点</span>
        <button class="small danger" style="margin-left: auto" title="删除脑图" @click.stop="deleteMap(m)">✕</button>
      </div>
      <div class="muted" style="margin-top: 10px; font-size: 12px; line-height: 1.7">
        · 脑图由用户自由创建与编辑，材料分析不会自动生成<br />
        · 可让 AI 按主题生成，并可引用材料 / 知识点 / 清单<br />
        · 支持全屏放大查看
      </div>
    </div>

    <!-- 下方：编辑器 -->
    <div class="card">
      <template v-if="current">
        <div class="toolbar">
          <input v-model="current.name" placeholder="脑图名称" style="max-width: 200px" />
          <input v-model="current.subject" placeholder="科目（可空）" style="max-width: 120px" />
          <div class="spacer"></div>
          <button class="small" @click="aiModal = true">✨ AI 生成</button>
          <button class="small" @click="toggleFullscreen">{{ isFullscreen ? '退出全屏' : '⛶ 全屏' }}</button>
          <button class="primary small" :disabled="saving" @click="save">
            <span v-if="saving" class="loading"></span>保存
          </button>
        </div>
        <div v-if="error" class="error-box">{{ error }}</div>

        <div class="tabs">
          <button :class="{ active: view === 'chart' }" @click="switchView('chart')">脑图视图</button>
          <button :class="{ active: view === 'outline' }" @click="switchView('outline')">大纲编辑</button>
        </div>

        <div ref="fsHost" class="mm-host">
          <div v-show="view === 'chart'" ref="chartEl" class="mm-chart"></div>

          <div v-if="view === 'outline'" class="mm-outline">
            <OutlineNode :node="tree" :depth="0" :isRoot="true" @pick-ref="openRefPicker" />
            <div class="muted" style="margin-top: 8px; font-size: 12px">
              提示：每行可直接输入文字；「＋子」添加下级分支，「＋同级」添加兄弟分支，「引」为节点关联材料/知识点/清单
            </div>
          </div>
        </div>
      </template>
      <div v-else class="empty">选择或新建一个脑图开始编辑</div>
    </div>

    <!-- AI 生成弹窗 -->
        <Teleport to="body">
<div v-if="aiModal" class="modal-mask" @click.self="aiModal = false">
      <div class="modal">
        <h3>AI 引导生成脑图</h3>
        <label class="field">
          <span>主题 / 要求</span>
          <textarea v-model="aiPrompt" rows="3" placeholder="如：把「牛顿运动定律」整理成复习脑图，突出公式与适用条件"></textarea>
        </label>
        <div class="tabs">
          <button v-for="t in refTabs" :key="t.key" :class="{ active: refTab === t.key }" @click="switchRefTab(t.key)">{{ t.label }}</button>
        </div>
        <div style="max-height: 260px; overflow: auto">
          <div v-if="!refItems.length" class="empty">暂无可引用的数据（可不选，直接让 AI 按主题生成）</div>
          <label v-for="item in refItems" :key="item.type + item.id" class="ref-row">
            <input type="checkbox" :value="item" v-model="aiRefs" />
            <span class="ref-row-title">{{ item.title }}</span>
            <span class="muted">{{ item.sub }}</span>
          </label>
        </div>
        <div class="toolbar" style="margin-top: 12px">
          <span class="muted">已选 {{ aiRefs.length }} 项引用</span>
          <div class="spacer"></div>
          <button @click="aiModal = false">取消</button>
          <button class="primary" :disabled="aiLoading" @click="runAiGenerate">
            <span v-if="aiLoading" class="loading"></span>生成
          </button>
        </div>
      </div>
    </div>
    </Teleport>

    <!-- 引用选择弹窗（为某个节点设置引用） -->
        <Teleport to="body">
<div v-if="refPicker" class="modal-mask" @click.self="refPicker = null">
      <div class="modal">
        <h3>为节点「{{ refPicker.text }}」添加引用</h3>
        <div class="tabs">
          <button v-for="t in refTabs" :key="t.key" :class="{ active: pickTab === t.key }" @click="switchPickTab(t.key)">{{ t.label }}</button>
        </div>
        <div style="max-height: 320px; overflow: auto">
          <div v-if="!pickItems.length" class="empty">暂无可引用的数据</div>
          <div v-for="item in pickItems" :key="item.type + item.id" class="ref-row" style="cursor: pointer" @click="confirmPick(item)">
            <span class="ref-row-title">{{ item.title }}</span>
            <span class="muted">{{ item.sub }}</span>
          </div>
        </div>
        <div class="toolbar" style="margin-top: 12px">
          <button v-if="refPicker.ref" class="small danger" @click="clearPick">清除已有引用</button>
          <div class="spacer"></div>
          <button @click="refPicker = null">关闭</button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, h, defineComponent, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts/core';
import { TreeChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { api } from '../api.js';
import { chartPalette } from '../charts.js';
import { winConfirm, winAlert, winPrompt } from '../dialogs.js';

echarts.use([TreeChart, TooltipComponent, CanvasRenderer]);

const maps = ref([]);
const current = ref(null);
const tree = ref({ text: '中心主题', children: [] });
const view = ref('chart');
const saving = ref(false);
const error = ref('');
const chartEl = ref(null);
const fsHost = ref(null);
const isFullscreen = ref(false);
const pageLoading = ref(true);
let chart = null;
let uid = 1;

// ---------- 树节点工具 ----------
function withIds(node) {
  if (!node || typeof node !== 'object') return { _uid: uid++, text: '中心主题', children: [] };
  return {
    _uid: uid++,
    text: node.text || '',
    note: node.note || '',
    ref: node.ref || null,
    children: (node.children || []).map(withIds)
  };
}

function stripIds(node) {
  const out = { text: node.text || '' };
  if (node.note) out.note = node.note;
  if (node.ref) out.ref = node.ref;
  if (node.children?.length) out.children = node.children.map(stripIds);
  return out;
}

function countNodes(node) {
  return 1 + (node.children || []).reduce((s, c) => s + countNodes(c), 0);
}

// ---------- 列表 ----------
async function loadList() {
  maps.value = (await api.listMindMaps()).items;
}

async function createMap() {
  const name = await winPrompt({ title: '新建脑图', message: '请输入脑图名称', inputLabel: '脑图名称', defaultValue: '新脑图' });
  if (!name?.trim()) return;
  try {
    const mm = await api.createMindMap({ name: name.trim() });
    await loadList();
    await openMap(mm.id);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function openMap(id) {
  try {
    const mm = await api.getMindMap(id);
    current.value = mm;
    tree.value = withIds(mm.content);
    error.value = '';
    await nextTick();
    if (view.value === 'chart') renderChart();
  } catch (e) {
    error.value = e.message;
  }
}

async function deleteMap(m) {
  if (!(await winConfirm({ title: '删除确认', message: `删除脑图「${m.name}」？`, danger: true }))) return;
  await api.deleteMindMap(m.id);
  if (current.value?.id === m.id) {
    current.value = null;
    tree.value = { text: '中心主题', children: [] };
  }
  await loadList();
}

async function save() {
  if (!current.value) return;
  saving.value = true;
  error.value = '';
  try {
    current.value = await api.updateMindMap(current.value.id, {
      name: current.value.name,
      subject: current.value.subject || null,
      content: stripIds(tree.value)
    });
    await loadList();
    winAlert({ title: '提示', message: '已保存' });
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

// ---------- 图表渲染 ----------
function toEcharts(node) {
  return {
    name: node.text,
    value: node.note || undefined,
    refLabel: node.ref ? `[${REF_LABELS[node.ref.type] || node.ref.type}] ${node.ref.title || '#' + node.ref.id}` : '',
    children: (node.children || []).map(toEcharts)
  };
}

const REF_LABELS = { material: '材料', node: '知识点', list: '清单', wrong: '错题' };

function renderChart() {
  if (!chartEl.value) return;
  if (!chart) chart = echarts.init(chartEl.value);
  const CP = chartPalette();
  chart.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: {
        formatter: (p) => {
          const d = p.data || {};
          let html = `<b>${d.name}</b>`;
          if (d.refLabel) html += `<br/>引用：${d.refLabel}`;
          if (d.value) html += `<br/>备注：${d.value}`;
          return html;
        }
      },
      series: [
        {
          type: 'tree',
          data: [toEcharts(tree.value)],
          orient: 'LR',
          roam: true,
          initialTreeDepth: 4,
          symbol: 'circle',
          symbolSize: 10,
          itemStyle: { color: '#4f8cff' },
          lineStyle: { color: CP.edgeLine, width: 1.4, curveness: 0.5 },
          label: {
            position: 'right',
            verticalAlign: 'middle',
            color: CP.nodeLabel,
            fontSize: 12,
            backgroundColor: CP.tooltipBg,
            borderColor: CP.tooltipBorder,
            borderWidth: 1,
            borderRadius: 4,
            padding: [3, 6]
          },
          leaves: {
            label: { position: 'right', verticalAlign: 'middle', color: CP.tooltipText }
          },
          expandAndCollapse: true,
          animationDuration: 300
        }
      ]
    },
    true
  );
  chart.resize();
}

function switchView(v) {
  view.value = v;
  nextTick(() => {
    if (v === 'chart') renderChart();
  });
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
    /* 忽略 */
  }
}

function onFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement);
  nextTick(() => chart?.resize());
}

// ---------- 大纲编辑（递归组件） ----------
const OutlineNode = defineComponent({
  name: 'OutlineNode',
  props: { node: Object, depth: Number, isRoot: Boolean },
  emits: ['pickRef'],
  setup(props, { emit }) {
    const open = ref(true);
    const showNote = ref(Boolean(props.node.note));
    const addChild = () => {
      if (!props.node.children) props.node.children = [];
      props.node.children.push({ _uid: uid++, text: '新分支', children: [] });
      open.value = true;
    };
    return () => {
      const n = props.node;
      const liveKids = (n.children || []).filter((c) => !c._remove);
      const hasKids = liveKids.length > 0;
      const head = h('div', { class: 'mm-row', style: { marginLeft: props.depth * 20 + 'px' } }, [
        h('span', {
          class: 'mm-toggle',
          onClick: () => { open.value = !open.value; }
        }, hasKids ? (open.value ? '▾' : '▸') : '·'),
        h('input', {
          class: 'mm-input',
          value: n.text,
          placeholder: '输入节点文字',
          onInput: (e) => { n.text = e.target.value; }
        }),
        n.ref
          ? h('span', { class: 'badge search', style: 'font-size: 10px; cursor: pointer', title: '点击更换引用', onClick: () => emit('pickRef', n) },
              `${REF_LABELS[n.ref.type] || n.ref.type}：${n.ref.title || '#' + n.ref.id}`)
          : null,
        h('span', { class: 'mm-ops' }, [
          h('button', { class: 'row-action', title: '添加子节点', onClick: addChild }, '＋子'),
          props.isRoot ? null : h('button', {
            class: 'row-action',
            title: '添加引用',
            onClick: () => emit('pickRef', n)
          }, '引'),
          props.isRoot ? null : h('button', {
            class: 'row-action',
            title: '备注',
            onClick: () => { showNote.value = !showNote.value; }
          }, '注'),
          props.isRoot ? null : h('button', {
            class: 'row-action danger',
            title: '删除节点',
            onClick: () => { n._remove = true; }
          }, '✕')
        ])
      ]);
      const noteRow = showNote.value
        ? h('div', { style: { marginLeft: props.depth * 20 + 24 + 'px' } }, [
            h('textarea', {
              class: 'mm-note',
              rows: 2,
              value: n.note || '',
              placeholder: '节点备注（可选）',
              onInput: (e) => { n.note = e.target.value; }
            })
          ])
        : null;
      const kids = liveKids.length && open.value
        ? liveKids.map((c) => h(OutlineNode, { node: c, depth: props.depth + 1, isRoot: false, onPickRef: (x) => emit('pickRef', x) }))
        : [];
      return h('div', [head, noteRow, ...kids]);
    };
  }
});

// ---------- 引用选择 ----------
const refTabs = [
  { key: 'material', label: '学习材料' },
  { key: 'node', label: '知识点' },
  { key: 'list', label: '知识清单' }
];
const refTab = ref('material');
const refItems = ref([]);
const pickTab = ref('material');
const pickItems = ref([]);
const refPicker = ref(null);

async function fetchRefItems(key) {
  try {
    if (key === 'material') {
      return (await api.listMaterials({})).items.map((m) => ({
        type: 'material', id: m.id, title: `《${m.title}》`, sub: `${m.subject || '未分类'} · ${m.status}`
      }));
    }
    if (key === 'node') {
      const g = await api.graph({ limit: 500 });
      return (g.nodes || []).map((n) => ({
        type: 'node', id: n.id, title: `《${n.name}》`, sub: `${n.subject || '未分类'} · ${n.category || ''}`
      }));
    }
    if (key === 'list') {
      const t = (await api.listsTree()).items;
      const flat = [];
      const walk = (nodes) => {
        for (const x of nodes) {
          if (x.kind === 'note') flat.push({ type: 'list', id: x.id, title: `《${x.name}》`, sub: x.description || '' });
          walk(x.children || []);
        }
      };
      walk(t);
      return flat;
    }
  } catch {
    return [];
  }
  return [];
}

async function switchRefTab(key) {
  refTab.value = key;
  refItems.value = await fetchRefItems(key);
}

async function switchPickTab(key) {
  pickTab.value = key;
  pickItems.value = await fetchRefItems(key);
}

function openRefPicker(node) {
  refPicker.value = node;
  switchPickTab(pickTab.value);
}

function confirmPick(item) {
  if (refPicker.value) {
    refPicker.value.ref = { type: item.type, id: item.id, title: item.title };
  }
  refPicker.value = null;
}

function clearPick() {
  if (refPicker.value) refPicker.value.ref = null;
  refPicker.value = null;
}

// ---------- AI 生成 ----------
const aiModal = ref(false);
const aiPrompt = ref('');
const aiRefs = ref([]);
const aiLoading = ref(false);

async function runAiGenerate() {
  aiLoading.value = true;
  error.value = '';
  try {
    const r = await api.aiGenerateMindMap(
      aiPrompt.value.trim() || current.value?.name || '',
      aiRefs.value.map((x) => ({ type: x.type, id: x.id }))
    );
    const hasContent = countNodes(tree.value) > 1;
    if (!hasContent || (await winConfirm({ title: 'AI 生成结果', message: 'AI 已生成脑图结构。替换当前内容？（取消则作为子分支挂到中心主题下）', primary: '替换', secondary: '作为子分支' }))) {
      tree.value = withIds(r.content);
    } else {
      tree.value.children.push(withIds(r.content));
    }
    aiModal.value = false;
    aiRefs.value = [];
    if (view.value === 'chart') await nextTick(renderChart);
  } catch (e) {
    error.value = e.message;
  } finally {
    aiLoading.value = false;
  }
}

window.addEventListener('resize', () => chart?.resize());

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  try {
    await loadList();
    if (maps.value.length) await openMap(maps.value[0].id);
    switchRefTab('material');
  } finally {
    pageLoading.value = false;
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  chart?.dispose();
  chart = null;
});
</script>

<style scoped>
.mm-host {
  border: 1px solid var(--border);
  border-radius: 8px;
  min-height: 480px;
  overflow: auto;
}
.mm-host:fullscreen {
  background: var(--bg, #0a0e17);
  padding: 16px;
}
.mm-chart {
  width: 100%;
  height: 480px;
}
.mm-host:fullscreen .mm-chart {
  height: calc(100vh - 40px);
}
.mm-outline {
  padding: 12px;
}
.mm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.mm-toggle {
  width: 16px;
  color: var(--text-dim);
  cursor: pointer;
  text-align: center;
  flex-shrink: 0;
}
.mm-input {
  flex: 1;
  max-width: 420px;
  padding: 4px 8px;
}
.mm-note {
  width: 100%;
  max-width: 420px;
  font-size: 12px;
  margin: 2px 0 4px;
}
.mm-ops {
  display: none;
  white-space: nowrap;
}
.mm-row:hover .mm-ops {
  display: inline-flex;
  gap: 4px;
}
.row-action {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 6px;
  font-size: 11px;
  padding: 1px 6px;
  cursor: pointer;
}
.row-action:hover {
  color: var(--text);
  border-color: var(--accent);
}
.row-action.danger:hover {
  color: var(--danger);
  border-color: var(--danger);
}
</style>
