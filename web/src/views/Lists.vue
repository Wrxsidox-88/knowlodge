<template>
  <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
  <div v-else class="row" style="align-items: flex-start">
    <div class="card" style="max-width: 360px">
      <div class="toolbar" style="margin-bottom: 8px">
        <h3 style="margin: 0">知识清单</h3>
        <div class="spacer"></div>
        <button class="small" @click="createFolder(null)">新建目录</button>
        <button class="small primary" @click="createNote(null)">新建清单</button>
      </div>
      <div v-if="!tree.length" class="empty">暂无清单，点击"新建清单"开始</div>
      <div v-for="n in tree" :key="n.id">
        <ListRow
          :node="n"
          :depth="0"
          :selectedId="selectedId"
          @select="select"
          @refresh="load"
          @create-note="createNote"
          @create-folder="createFolder"
          @remove="removeNode"
        />
      </div>
      <div class="muted" style="margin-top: 10px; font-size: 12px; line-height: 1.7">
        · 内容为 Markdown，支持公式渲染；悬停目录可新建子项或删除<br />
        · 开启"允许 AI 编辑"后，AI 在对话/分析中可修改该清单<br />
        · AI 分析时按需创建清单：见系统设置开关{{ aiAutocreate ? '（已开启）' : '（已关闭）' }}
      </div>
    </div>

    <div class="card" style="flex: 2">
      <template v-if="current">
        <div class="toolbar">
          <input v-model="form.name" style="max-width: 240px" placeholder="名称" />
          <label class="toggle-label">
            <input type="checkbox" v-model="form.aiEditable" />
            允许 AI 编辑
          </label>
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
      <div v-else class="empty">选择左侧清单查看/编辑</div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, h, defineComponent, onMounted } from 'vue';
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

const ListRow = defineComponent({
  name: 'ListRow',
  props: { node: Object, depth: Number, selectedId: Number },
  emits: ['select', 'refresh', 'createNote', 'createFolder', 'remove'],
  setup(props, { emit }) {
    const open = ref(true);
    const action = (label, title, fn, cls = 'row-action') =>
      h('button', {
        class: cls,
        title,
        style: 'margin-left: 4px',
        onClick: (e) => {
          e.stopPropagation();
          fn();
        }
      }, label);
    return () => {
      const n = props.node;
      const isFolder = n.kind === 'folder';
      const row = h(
        'div',
        {
          class: 'node-row list-row' + (props.selectedId === n.id ? ' selected' : ''),
          style: { marginLeft: props.depth * 16 + 'px' },
          onClick: () => emit('select', n)
        },
        [
          isFolder
            ? h('span', { class: 'muted', style: 'cursor:pointer; margin-right: 4px', onClick: (e) => { e.stopPropagation(); open.value = !open.value; } }, open.value ? '▾' : '▸')
            : h('span', { class: 'dot' }),
          h('span', n.name),
          n.aiEditable ? h('span', { class: 'badge done', style: 'margin-left: 6px; font-size: 10px' }, 'AI') : null,
          h('span', { class: 'row-actions', style: 'margin-left: auto' }, [
            ...(isFolder
              ? [
                  action('＋文档', '在此目录下新建清单', () => emit('createNote', n.id)),
                  action('＋目录', '在此目录下新建子目录', () => emit('createFolder', n.id))
                ]
              : []),
            action('✕', isFolder ? '删除目录（含其下全部内容）' : '删除清单', () => emit('remove', n), 'row-action danger')
          ])
        ]
      );
      const children = isFolder && open.value
        ? (n.children || []).map((c) => h(ListRow, {
            node: c,
            depth: props.depth + 1,
            selectedId: props.selectedId,
            onSelect: (x) => emit('select', x),
            onRefresh: () => emit('refresh'),
            onCreateNote: (id) => emit('createNote', id),
            onCreateFolder: (id) => emit('createFolder', id),
            onRemove: (x) => emit('remove', x)
          }))
        : [];
      return h('div', [row, ...children]);
    };
  }
});

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
.list-row {
  display: flex;
  align-items: center;
}
.row-actions {
  display: none;
  white-space: nowrap;
}
.list-row:hover .row-actions {
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
