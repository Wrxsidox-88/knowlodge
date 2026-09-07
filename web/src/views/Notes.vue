<template>
  <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载笔记…</div>
  <div v-else class="col-stack">
    <div class="card">
      <div class="toolbar" style="margin-bottom: 8px">
        <h3 style="margin: 0">学习笔记</h3>
        <span class="muted" style="font-size: 12px">拍照上传自动 OCR 转写，AI 按科学笔记方法重整，可并入知识图谱</span>
        <div class="spacer"></div>
        <button class="small" @click="openText">自由录入</button>
        <button class="small primary" @click="openPhoto">拍照上传</button>
      </div>
      <div class="muted" style="font-size: 12px; line-height: 1.7; margin-bottom: 10px">
        · 笔记方法：<b>思维导图</b>（层级知识树）/ <b>康奈尔笔记</b>（线索-正文-总结）/ <b>结构大纲</b> / <b>闪卡</b>（问答自测）<br />
        · 录入时选择「并入知识图谱」可把笔记中的知识点自动挂到图谱上；思维导图笔记还能一键存为脑图
      </div>

      <div v-if="!items.length" class="empty">还没有笔记，点上方「自由录入」或「拍照上传」开始</div>
      <div v-for="n in items" :key="n.id" class="node-card">
        <div class="toolbar" style="margin: 0">
          <span class="name">{{ n.title || '未命名笔记' }}</span>
          <span class="badge" :class="n.status === 'done' ? 'done' : n.status === 'failed' ? 'failed' : ''">
            {{ statusLabel(n.status) }}
          </span>
          <span class="badge">{{ n.methodLabel }}</span>
          <span v-if="n.subject" class="badge">{{ n.subject }}</span>
          <span v-if="n.graph_merged" class="badge done" title="笔记知识点已并入知识图谱">图谱</span>
          <span class="muted" style="font-size: 12px">{{ (n.created_at || '').slice(0, 16) }}</span>
          <div class="spacer"></div>
          <button class="small" @click="toggle(n.id)">{{ expanded === n.id ? '收起' : '查看' }}</button>
          <button class="small" @click="openReanalyze(n)">重新整理</button>
          <button v-if="n.note_method === 'mindmap'" class="small" @click="toMindmap(n)">存为脑图</button>
          <button class="small danger" @click="remove(n)">删除</button>
        </div>

        <div v-if="expanded === n.id" style="margin-top: 10px">
          <div v-if="detail?.imageDataUrl" style="margin-bottom: 10px">
            <img :src="detail.imageDataUrl" style="max-width: 320px; max-height: 260px; border-radius: 8px; border: 1px solid var(--border)" />
          </div>
          <div v-if="detail?.structure" class="note-structure">
            <!-- 思维导图 -->
            <template v-if="detail.note_method === 'mindmap'">
              <div class="mindmap-root">{{ detail.structure.root?.text || detail.structure.title }}</div>
              <ul class="mm-level">
                <li v-for="c in detail.structure.root?.children || []" :key="c.text">
                  <b>{{ c.text }}</b>
                  <span v-if="c.note" class="muted"> — {{ c.note }}</span>
                  <ul><li v-for="g in c.children || []" :key="g.text">{{ g.text }}</li></ul>
                </li>
              </ul>
            </template>
            <!-- 康奈尔 -->
            <template v-else-if="detail.note_method === 'cornell'">
              <div class="cornell-grid">
                <div class="cornell-cue"><b>线索栏</b><div v-for="(c, i) in detail.structure.cue || []" :key="i" class="cue-item">{{ c }}</div></div>
                <div class="cornell-notes"><b>正文</b><div class="md" v-html="renderMd(detail.structure.notes || '')"></div></div>
              </div>
              <div class="cornell-summary"><b>总结</b><span>{{ detail.structure.summary }}</span></div>
            </template>
            <!-- 结构大纲 -->
            <template v-else-if="detail.note_method === 'outline'">
              <div v-for="(s, i) in detail.structure.sections || []" :key="i" class="outline-sec">
                <div class="outline-h">▸ {{ s.heading }}</div>
                <div v-for="(p, j) in s.points || []" :key="j" class="outline-p">· {{ p }}</div>
                <template v-for="(sub, k) in s.children || []" :key="k">
                  <div class="outline-h sub">▸ {{ sub.heading }}</div>
                  <div v-for="(p, j2) in sub.points || []" :key="j2" class="outline-p">· {{ p }}</div>
                </template>
              </div>
            </template>
            <!-- 闪卡 -->
            <template v-else-if="detail.note_method === 'flashcards'">
              <div class="fc-grid">
                <div v-for="(c, i) in detail.structure.cards || []" :key="i" class="fc-card" @click="c._flip = !c._flip">
                  <template v-if="!c._flip"><span class="fc-tag">问</span>{{ c.front }}</template>
                  <template v-else><span class="fc-tag ans">答</span>{{ c.back }}</template>
                </div>
              </div>
              <div class="muted" style="font-size: 12px; margin-top: 6px">点击卡片翻转查看答案</div>
            </template>
          </div>
          <div v-if="detail?.raw_text" class="muted" style="font-size: 12px; margin-top: 10px; white-space: pre-wrap; max-height: 140px; overflow: auto; border-top: 1px dashed var(--border); padding-top: 8px">
            原始内容：{{ detail.raw_text }}
          </div>
        </div>
      </div>
    </div>

    <!-- 自由录入弹窗 -->
    <Teleport to="body">
      <div v-if="showTextDialog" class="modal-mask" @click.self="showTextDialog = false">
        <div class="modal">
          <h3>自由录入笔记</h3>
          <label class="field"><span>标题（选填）</span><input v-model="form.title" placeholder="如：二次函数图像性质" /></label>
          <div class="field"><span>科目（选填，AI 可自动识别）</span>
            <WinComboBox
              :ItemsSource="subjectOptions"
              DisplayMemberPath="label"
              SelectedValuePath="value"
              v-model:SelectedValue="form.subject"
              PlaceholderText="自动识别" />
          </div>
          <div class="field"><span>笔记方法</span>
            <WinComboBox
              :ItemsSource="methodOptions"
              DisplayMemberPath="label"
              SelectedValuePath="value"
              v-model:SelectedValue="form.noteMethod" />
          </div>
          <label class="field"><span>笔记内容 *</span><textarea v-model="form.content" rows="9" placeholder="把课堂笔记、摘抄、想法随意粘贴进来，AI 会帮你重整为结构化笔记…"></textarea></label>
          <label class="field"><span>整理引导（选填）</span><input v-model="form.guide" placeholder="如：重点突出易错点" /></label>
          <div class="settings-toggle-row">
            <div class="settings-toggle-text">
              <span class="settings-toggle-title">并入知识图谱</span>
              <span class="settings-toggle-desc">把笔记中的知识点按层级自动挂载到知识图谱</span>
            </div>
            <WinToggleSwitch :IsOn="form.mergeGraph" @update:IsOn="form.mergeGraph = $event" />
          </div>
          <div class="toolbar" style="margin-top: 14px">
            <button class="primary" :disabled="saving" @click="saveText"><span v-if="saving" class="loading"></span>保存并整理</button>
            <button @click="showTextDialog = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 拍照上传弹窗 -->
    <Teleport to="body">
      <div v-if="showPhotoDialog" class="modal-mask" @click.self="showPhotoDialog = false">
        <div class="modal">
          <h3>拍照上传笔记</h3>
          <label class="field"><span>笔记照片（png/jpg，视觉模型自动转写文字与公式）</span>
            <input type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp" @change="onPickPhoto" />
          </label>
          <div v-if="photoPreview" style="margin-bottom: 10px">
            <img :src="photoPreview" style="max-width: 100%; max-height: 220px; border-radius: 8px; border: 1px solid var(--border)" />
          </div>
          <div class="field"><span>科目（选填，AI 可自动识别）</span>
            <WinComboBox
              :ItemsSource="subjectOptions"
              DisplayMemberPath="label"
              SelectedValuePath="value"
              v-model:SelectedValue="photoForm.subject"
              PlaceholderText="自动识别" />
          </div>
          <div class="field"><span>笔记方法</span>
            <WinComboBox
              :ItemsSource="methodOptions"
              DisplayMemberPath="label"
              SelectedValuePath="value"
              v-model:SelectedValue="photoForm.noteMethod" />
          </div>
          <div class="settings-toggle-row">
            <div class="settings-toggle-text">
              <span class="settings-toggle-title">并入知识图谱</span>
              <span class="settings-toggle-desc">把笔记中的知识点按层级自动挂载到知识图谱</span>
            </div>
            <WinToggleSwitch :IsOn="photoForm.mergeGraph" @update:IsOn="photoForm.mergeGraph = $event" />
          </div>
          <div class="toolbar" style="margin-top: 14px">
            <button class="primary" :disabled="saving || !photoFile" @click="savePhoto"><span v-if="saving" class="loading"></span>上传并整理</button>
            <button @click="showPhotoDialog = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 重新整理弹窗 -->
    <Teleport to="body">
      <div v-if="showReDialog" class="modal-mask" @click.self="showReDialog = false">
        <div class="modal">
          <h3>重新整理笔记</h3>
          <div class="field"><span>笔记方法</span>
            <WinComboBox
              :ItemsSource="methodOptions"
              DisplayMemberPath="label"
              SelectedValuePath="value"
              v-model:SelectedValue="reForm.noteMethod" />
          </div>
          <label class="field"><span>整理引导（选填）</span><input v-model="reForm.guide" placeholder="如：按考试题型组织" /></label>
          <div class="settings-toggle-row">
            <div class="settings-toggle-text">
              <span class="settings-toggle-title">并入知识图谱</span>
              <span class="settings-toggle-desc">把笔记中的知识点按层级自动挂载到知识图谱</span>
            </div>
            <WinToggleSwitch :IsOn="reForm.mergeGraph" @update:IsOn="reForm.mergeGraph = $event" />
          </div>
          <div class="toolbar" style="margin-top: 14px">
            <button class="primary" :disabled="saving" @click="doReanalyze"><span v-if="saving" class="loading"></span>开始整理</button>
            <button @click="showReDialog = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import WinComboBox from '../winui/components/WinComboBox.vue';
import WinToggleSwitch from '../winui/components/WinToggleSwitch.vue';

const items = ref([]);
const detail = ref(null);
const expanded = ref(null);
const pageLoading = ref(true);
const saving = ref(false);
const showTextDialog = ref(false);
const showPhotoDialog = ref(false);
const showReDialog = ref(false);
const photoFile = ref(null);
const photoPreview = ref('');
const subjects = ['数学', '物理', '化学', '生物', '语文', '英语', '历史', '地理', '政治'];
const subjectOptions = [
  { label: '自动识别', value: '' },
  ...subjects.map((s) => ({ label: s, value: s }))
];
const methodOptions = [
  { value: 'mindmap', label: '思维导图' },
  { value: 'cornell', label: '康奈尔笔记' },
  { value: 'outline', label: '结构大纲' },
  { value: 'flashcards', label: '闪卡' }
];
const form = ref({ title: '', subject: '', content: '', noteMethod: 'mindmap', guide: '', mergeGraph: false });
const photoForm = ref({ subject: '', noteMethod: 'mindmap', mergeGraph: false });
const reForm = ref({ id: null, noteMethod: 'mindmap', guide: '', mergeGraph: false });

function statusLabel(s) {
  return { pending: '待整理', analyzing: '整理中', done: '已整理', failed: '整理失败' }[s] || s;
}

async function load() {
  try {
    const data = await api.listNotes();
    items.value = data.items || [];
  } finally {
    pageLoading.value = false;
  }
}

async function toggle(id) {
  if (expanded.value === id) {
    expanded.value = null;
    detail.value = null;
    return;
  }
  expanded.value = id;
  detail.value = null;
  detail.value = await api.getNote(id);
}

function openText() {
  form.value = { title: '', subject: '', content: '', noteMethod: 'mindmap', guide: '', mergeGraph: false };
  showTextDialog.value = true;
}

function openPhoto() {
  photoFile.value = null;
  photoPreview.value = '';
  photoForm.value = { subject: '', noteMethod: 'mindmap', mergeGraph: false };
  showPhotoDialog.value = true;
}

function onPickPhoto(e) {
  photoFile.value = e.target.files?.[0] || null;
  photoPreview.value = '';
  if (photoFile.value) {
    const reader = new FileReader();
    reader.onload = () => (photoPreview.value = reader.result);
    reader.readAsDataURL(photoFile.value);
  }
}

async function saveText() {
  if (!form.value.content.trim()) return;
  saving.value = true;
  try {
    const f = form.value;
    await api.createNote({
      title: f.title || undefined,
      subject: f.subject || undefined,
      content: f.content,
      noteMethod: f.noteMethod,
      guide: f.guide || undefined,
      mergeGraph: f.mergeGraph
    });
    showTextDialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

async function savePhoto() {
  if (!photoFile.value) return;
  saving.value = true;
  try {
    const f = photoForm.value;
    const fd = new FormData();
    fd.append('image', photoFile.value);
    if (f.subject) fd.append('subject', f.subject);
    fd.append('noteMethod', f.noteMethod);
    if (f.mergeGraph) fd.append('mergeGraph', '1');
    await api.uploadNote(fd);
    showPhotoDialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

function openReanalyze(n) {
  reForm.value = { id: n.id, noteMethod: n.note_method || 'mindmap', guide: '', mergeGraph: Boolean(n.graph_merged) };
  showReDialog.value = true;
}

async function doReanalyze() {
  saving.value = true;
  try {
    await api.analyzeNote(reForm.value.id, {
      noteMethod: reForm.value.noteMethod,
      guide: reForm.value.guide || '',
      mergeGraph: reForm.value.mergeGraph
    });
    showReDialog.value = false;
    expanded.value = null;
    await load();
  } finally {
    saving.value = false;
  }
}

async function toMindmap(n) {
  await api.noteToMindmap(n.id);
}

async function remove(n) {
  if (!confirm(`删除笔记「${n.title || '未命名'}」？`)) return;
  await api.deleteNote(n.id);
  if (expanded.value === n.id) {
    expanded.value = null;
    detail.value = null;
  }
  await load();
}

function renderMd(text) {
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\n/).map((l) => (l.trim() ? l : '')).join('<br/>');
}

onMounted(load);
</script>

<style scoped>
.node-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.node-card .name { font-weight: 600; }
.badge.failed { background: rgba(239, 95, 107, 0.15); color: #ef5f6b; }
.mindmap-root { font-weight: 700; font-size: 15px; margin-bottom: 6px; }
.mm-level, .mm-level ul { list-style: none; padding-left: 18px; margin: 0; }
.mm-level > li { margin: 4px 0; }
.cornell-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; }
.cornell-cue, .cornell-notes, .cornell-summary { border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
.cue-item { margin: 4px 0; }
.cornell-summary { margin-top: 10px; }
.outline-sec { margin-bottom: 10px; }
.outline-h { font-weight: 600; }
.outline-h.sub { margin-left: 16px; font-weight: 500; }
.outline-p { margin-left: 28px; }
.fc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.fc-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px; min-height: 84px; cursor: pointer; position: relative; }
.fc-tag { position: absolute; top: 6px; right: 8px; font-size: 11px; color: #4f8cff; }
.fc-tag.ans { color: #27c8a0; }
</style>
