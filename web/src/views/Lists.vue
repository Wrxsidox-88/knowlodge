<template>
  <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
  <div v-else class="col-stack">
    <div class="card">
      <div class="toolbar" style="margin-bottom: 8px">
        <h3 style="margin: 0">知识清单</h3>
        <div class="spacer"></div>
        <button class="small" @click="createFolder(null)">新建目录</button>
        <button class="small primary" @click="createNote(null)">新建清单</button>
      </div>
      <div v-if="!tree.length" class="empty">暂无清单，点击"新建清单"开始</div>
      <WinTreeView
        v-else
        v-model:ItemsSource="tree"
        SelectionMode="Single"
        style="max-height: 400px; overflow: auto"
        @ItemInvoked="onTreeInvoked">
        <template #item="{ item }">
          <div style="display: flex; align-items: center; gap: 6px; min-width: 0">
            <span class="tree-icon" :class="item.kind === 'folder' ? 'folder' : 'file'" aria-hidden="true"></span>
            <WinTextBlock class="tree-node-name" :Text="item.name" />
            <span v-if="item.ai_editable" class="badge done" style="font-size: 10px; flex-shrink: 0">AI</span>
            <span class="row-actions" style="margin-left: auto; flex-shrink: 0" @click.stop>
              <button v-if="item.kind === 'folder'" class="row-action" type="button" @click.stop="createNote(item.id)" title="在此目录下新建清单">＋清单</button>
              <button v-if="item.kind === 'folder'" class="row-action" type="button" @click.stop="createFolder(item.id)" title="在此目录下新建子目录">＋目录</button>
              <button class="row-action danger" type="button" @click.stop="removeNode(item)" :title="item.kind === 'folder' ? '删除目录（含其下全部内容）' : '删除清单'">✕</button>
            </span>
          </div>
        </template>
      </WinTreeView>
      <div class="muted" style="margin-top: 10px; font-size: 12px; line-height: 1.7">
        · 目录可展开/折叠；悬停节点显示「＋清单/＋目录/✕」操作（点击不会误触展开）<br />
        · 节点左侧图标或文字可选中清单；点击目录图标三角展开/折叠<br />
        · 内容为 Markdown，支持公式渲染；顶部按钮可新建根目录/根清单<br />
        · 开启"允许 AI 编辑"后，AI 在对话/分析中可修改该清单
        · AI 分析时按需创建清单：见系统设置开关{{ aiAutocreate ? '（已开启）' : '（已关闭）' }}
      </div>
    </div>

    <div class="card">
      <template v-if="current">
        <div class="toolbar">
          <input v-model="form.name" style="max-width: 240px" placeholder="名称" />
          <span class="inline-toggle">
            <span class="inline-toggle-label">允许 AI 编辑</span>
            <WinToggleSwitch :IsOn="form.aiEditable" @update:IsOn="form.aiEditable = $event" />
          </span>
          <div class="spacer"></div>
          <button class="small danger" @click="remove">删除</button>
          <button class="primary small" :disabled="saving" @click="save">
            <span v-if="saving" class="loading"></span>保存
          </button>
        </div>
        <label class="field">
          <span>描述（辅助 AI 理解本清单用途，进行编辑/总结）</span>
          <input v-model="form.description" placeholder="如：物理力学公式汇总，供 AI 复习总结时更新" />
        </label>
        <div class="tabs">
          <button :class="{ active: view === 'edit' }" @click="view = 'edit'">编辑</button>
          <button :class="{ active: view === 'preview' }" @click="view = 'preview'">预览</button>
        </div>
        <textarea
          v-if="view === 'edit'"
          v-model="form.content"
          rows="18"
          style="font-family: Consolas, monospace; font-size: 13px"
          placeholder="Markdown 内容，公式用 $...$ / $$...$$ / $\ce{...}$"
        ></textarea>
        <div v-else class="md-body" style="min-height: 360px; border: 1px solid var(--border); border-radius: 8px; padding: 14px" v-html="md(form.content || '（空清单）')"></div>
      </template>
      <div v-else class="empty">选择上方清单查看/编辑</div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import WinToggleSwitch from '../winui/components/WinToggleSwitch.vue';
import WinTreeView from '../winui/components/WinTreeView.vue';
import WinTextBlock from '../winui/components/WinTextBlock.vue';
import { api } from '../api.js';
import { renderMarkdown } from '../util.js';
import { winConfirm, winAlert, winPrompt } from '../dialogs.js';

const md = renderMarkdown;
const tree = ref([]);
const selectedId = ref(null);
const current = ref(null);
const view = ref('edit');
const saving = ref(false);
const aiAutocreate = ref(false);
const pageLoading = ref(true);
const form = reactive({ name: '', description: '', content: '', aiEditable: false });

// WinTreeView 节点被点击：目录由组件自行展开/折叠，仅清单（笔记）载入编辑
function onTreeInvoked({ InvokedItem: n }) {
  if (!n || n.kind !== 'note') return;
  select(n);
}

async function load() {
  const r = await api.listsTree();
  tree.value = r.items;
  aiAutocreate.value = r.aiAutocreate;
}

async function select(n) {
  if (n.kind === 'folder') {
    selectedId.value = null;
    current.value = null;
    return;
  }
  selectedId.value = n.id;
  current.value = await api.getList(n.id);
  Object.assign(form, {
    name: current.value.name,
    description: current.value.description || '',
    content: current.value.content || '',
    aiEditable: Boolean(current.value.ai_editable)
  });
}

// parentId 为 null 时建在根目录；否则直接建在指定目录下（无需手动输入路径）
async function createFolder(parentId) {
  const where = parentId ? `目录「${findName(tree.value, parentId) || parentId}」下` : '根目录';
  const name = await winPrompt({ title: '新建目录', message: `新建目录（${where}），请输入目录名`, inputLabel: '目录名' });
  if (!name?.trim()) return;
  try {
    await api.createList({ kind: 'folder', name: name.trim(), parentId });
    await load();
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function createNote(parentId) {
  const where = parentId ? `目录「${findName(tree.value, parentId) || parentId}」下` : '根目录';
  const name = await winPrompt({ title: '新建清单', message: `新建清单（${where}），请输入名称`, inputLabel: '清单名称' });
  if (!name?.trim()) return;
  try {
    const row = await api.createList({ kind: 'note', name: name.trim(), parentId });
    await load();
    await select(row);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

function findName(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n.name;
    const hit = findName(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

async function removeNode(n) {
  const isFolder = n.kind === 'folder';
  const tip = isFolder
    ? `删除目录「${n.name}」？其下全部子目录与清单将一并删除。`
    : `删除清单「${n.name}」？`;
  if (!(await winConfirm({ title: '删除确认', message: tip, danger: true }))) return;
  try {
    await api.deleteList(n.id);
    if (current.value?.id === n.id) {
      current.value = null;
      selectedId.value = null;
    }
    await load();
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function save() {
  saving.value = true;
  try {
    await api.updateList(current.value.id, form);
    await load();
    winAlert({ title: '提示', message: '已保存' });
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!(await winConfirm({ title: '删除确认', message: `删除清单《${current.value.name}》？`, danger: true }))) return;
  await api.deleteList(current.value.id);
  current.value = null;
  selectedId.value = null;
  await load();
}

onMounted(async () => {
  try {
    await load();
  } finally {
    pageLoading.value = false;
  }
});
</script>

<style scoped>
.tree-node-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 与参考页同款：专用字体图标（Segoe MDL2 字码），文件夹 \E8B7 / 文档 \E8A5 */
.tree-icon {
  width: 20px;
  font-size: 16px;
  flex-shrink: 0;
  font-family: 'WinUIOnWebIcons', 'Segoe MDL2 Assets', 'Segoe UI', sans-serif;
}
.tree-icon.folder::before {
  content: '\E8B7';
}
.tree-icon.file::before {
  content: '\E8A5';
}

/* 树行内操作按钮：悬停显示，点击不冒泡（不影响展开/选中） */
.row-actions {
  display: none;
  white-space: nowrap;
}
.win-tree-view .tree-item:hover .row-actions {
  display: inline-flex;
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
