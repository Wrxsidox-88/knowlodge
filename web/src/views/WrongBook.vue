<template>
  <div>
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>
    <div class="card">
      <div class="toolbar">
        <WinComboBox
          :ItemsSource="subjectFilterOptions"
          DisplayMemberPath="label"
          SelectedValuePath="value"
          v-model:SelectedValue="filter.subject"
          @SelectionChanged="load"
          Width="140" />
        <WinComboBox
          :ItemsSource="causeFilterOptions"
          DisplayMemberPath="label"
          SelectedValuePath="value"
          v-model:SelectedValue="filter.cause"
          @SelectionChanged="load"
          Width="160" />
        <WinComboBox
          :ItemsSource="wrongStatusOptions"
          DisplayMemberPath="label"
          SelectedValuePath="value"
          v-model:SelectedValue="filter.status"
          @SelectionChanged="load"
          Width="140" />
        <WinAutoSuggestBox
          v-model:Text="filter.keyword"
          :ItemsSource="wrongSuggestions"
          PlaceholderText="搜索题干/解析"
          QueryIcon="Find"
          :Width="220"
          @SuggestionChosen="onWrongChosen"
          @QuerySubmitted="load" />
        <button class="small" @click="load">筛选</button>
        <button class="small" @click="openManage">错因标签管理</button>
        <div class="spacer"></div>
        <button class="primary" @click="openCreate">录入错题</button>
      </div>
      <div class="toolbar" style="margin: 0">
        <span class="muted">错因标签：</span>
        <span
          v-for="c in causes"
          :key="c.id"
          class="cause-tag"
          :title="c.description || ''"
          :style="{ background: causeColor(c.name) + '22', color: causeColor(c.name), borderColor: causeColor(c.name) + '66' }"
        >{{ c.name }}<span v-if="c.source === 'ai'" class="muted" style="font-size: 10px">（AI）</span></span>
        <span class="muted" style="margin-left: auto">共 {{ items.length }} 道错题</span>
      </div>
    </div>

    <div v-if="!items.length" class="card empty">暂无错题，点击"录入错题"开始</div>
    <div v-for="w in items" :key="w.id" class="card wrong-card">
      <div class="toolbar" style="margin: 0 0 8px">
        <span class="badge search">{{ w.subject || '未分类' }}</span>
        <span v-if="w.error_cause" class="cause-tag" :style="{ background: causeColor(w.error_cause) + '22', color: causeColor(w.error_cause), borderColor: causeColor(w.error_cause) + '66' }">
          {{ w.error_cause }}
        </span>
        <span v-else class="badge">未标注</span>
        <span v-if="w.exam_title" class="badge">来自：{{ w.exam_title }}</span>
        <span class="badge" :class="w.status">{{ STATUS_TEXT[w.status] || w.status }}</span>
        <div class="spacer"></div>
        <span class="muted">#{{ w.id }} · {{ w.created_at }}</span>
      </div>
      <div class="wrong-q" @click="view(w)">{{ w.question || '（图片错题，待识别）' }}</div>
      <div class="toolbar" style="margin: 8px 0 0">
        <span v-if="w.node_count" class="muted">关联知识点 {{ w.node_count }} 个</span>
        <span v-if="w.image_path" class="muted">含图片</span>
        <div class="spacer"></div>
        <button class="small" @click="view(w)">详情</button>
        <button v-if="w.status !== 'analyzing'" class="small primary" @click="analyze(w)">
          {{ w.status === 'done' ? '重新分析' : 'AI 分析' }}
        </button>
        <button class="small danger" @click="del(w)">删除</button>
      </div>
    </div>

        <Teleport to="body">
<div v-if="creating" class="modal-mask" @click.self="creating = false">
      <div class="modal">
        <h3>录入错题</h3>
        <div v-if="createError" class="error-box">{{ createError }}</div>
        <div class="tabs">
          <button :class="{ active: ctab === 'text' }" @click="ctab = 'text'">文本录入</button>
          <button :class="{ active: ctab === 'photo' }" @click="ctab = 'photo'">拍照/图片</button>
        </div>
        <label class="field"><span>科目</span>
          <WinComboBox
            :ItemsSource="wrongSubjectOptions"
            DisplayMemberPath="label"
            SelectedValuePath="value"
            v-model:SelectedValue="cform.subject"
            PlaceholderText="未知" />
        </label>
        <label class="field"><span>关联考试</span>
          <WinComboBox
            :ItemsSource="examOptions"
            DisplayMemberPath="label"
            SelectedValuePath="value"
            v-model:SelectedValue="cform.examId"
            PlaceholderText="无" />
        </label>
        <template v-if="ctab === 'text'">
          <label class="field"><span>题干 *</span><textarea v-model="cform.question" rows="4" placeholder="粘贴或输入题目内容"></textarea></label>
          <label class="field"><span>选项</span><input v-model="cform.options" placeholder="A. xxx B. xxx ...（选填）" /></label>
          <label class="field"><span>我的作答</span><input v-model="cform.userAnswer" /></label>
          <label class="field"><span>正确答案</span><input v-model="cform.correctAnswer" /></label>
        </template>
        <template v-else>
          <label class="field"><span>错题照片（png/jpg，AI 识别题干）</span>
            <input type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp" @change="onPhoto" />
          </label>
          <label class="field"><span>补充说明（选填）</span><input v-model="cform.question" placeholder="如：第3题选择题" /></label>
        </template>
        <label class="field"><span>自我评估：错因</span>
          <WinComboBox
            :ItemsSource="causeOptions"
            DisplayMemberPath="label"
            SelectedValuePath="value"
            v-model:SelectedValue="cform.errorCause"
            PlaceholderText="由 AI 判断" />
        </label>
        <label class="field"><span>错因补充</span><input v-model="cform.causeNote" placeholder="选填" /></label>
        <label v-if="cform.errorCause === '__new__'" class="field">
          <span>新标签名（保存后自动加入标签库，AI 分析时也能复用）</span>
          <input v-model="cform.newCauseName" placeholder="如：题意理解偏差" />
        </label>
        <label class="field"><span>分析引导词（可选，指导 AI 如何分析）</span>
          <input v-model="cform.guide" placeholder="如：重点分析受力分析步骤" />
        </label>
        <div class="toolbar">
          <button class="primary" :disabled="cSaving" @click="submitCreate"><span v-if="cSaving" class="loading"></span>保存</button>
          <button @click="creating = false">取消</button>
          <span class="muted">保存后按设置自动进入 AI 结构化分析，并关联知识点、更新掌握度</span>
        </div>
      </div>
    </div>
    </Teleport>

        <Teleport to="body">
<div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <h3>错题 #{{ detail.id }} <span class="badge search" style="margin-left: 6px">{{ detail.subject || '未分类' }}</span></h3>
        <div class="toolbar" style="margin-bottom: 8px">
          <span v-if="detail.error_cause" class="cause-tag" :style="{ background: causeColor(detail.error_cause) + '22', color: causeColor(detail.error_cause), borderColor: causeColor(detail.error_cause) + '66' }">{{ detail.error_cause }}</span>
          <span v-if="detail.cause_note" class="muted">{{ detail.cause_note }}</span>
          <div class="spacer"></div>
          <button v-if="detail.status !== 'analyzing'" class="small primary" @click="analyze(detail)">
            {{ detail.status === 'done' ? '重新分析' : 'AI 分析' }}
          </button>
        </div>
        <img v-if="detail.imageDataUrl" :src="detail.imageDataUrl" style="max-width: 100%; border-radius: 8px; background: #fff; margin-bottom: 10px" />
        <h3>题干</h3>
        <pre class="md-text">{{ detail.question }}</pre>
        <div class="kv" v-if="detail.options || detail.correct_answer || detail.user_answer" style="margin-top: 10px">
          <template v-if="detail.options"><span class="k">选项</span><span>{{ detail.options }}</span></template>
          <template v-if="detail.correct_answer"><span class="k">正确答案</span><span style="color: var(--accent-2)">{{ detail.correct_answer }}</span></template>
          <template v-if="detail.user_answer"><span class="k">我的作答</span><span style="color: var(--danger)">{{ detail.user_answer }}</span></template>
        </div>
        <template v-if="detail.analysis">
          <h3>AI 解析</h3>
          <div class="md-body" style="margin-bottom: 10px" v-html="md(detail.analysis)"></div>
        </template>
        <template v-if="detail.nodes?.length">
          <h3>关联知识点（点击跳转图谱）</h3>
          <div v-for="n in detail.nodes" :key="n.id" class="chip" @click="$router.push('/graph?node=' + n.id)">
            {{ n.name }}
            <span v-if="n.wrong != null" class="muted" style="margin-left: 4px">掌握度 {{ nodeMastery(n) }}%</span>
          </div>
        </template>
        <div class="toolbar" style="margin-top: 14px">
          <label class="field" style="margin: 0; flex: 1">
            <span>手动修改错因标签（也可输入自定义新标签，自动入库）</span>
            <input v-model="editCause" list="cause-options" placeholder="选择或输入新标签" />
            <datalist id="cause-options">
              <option v-for="c in causes" :key="c.id" :value="c.name">{{ c.description }}</option>
            </datalist>
          </label>
          <button class="small" style="align-self: flex-end" @click="saveCause">保存标签</button>
          <div class="spacer"></div>
          <button @click="closeDetail">关闭</button>
        </div>
      </div>
    </div>
    </Teleport>

        <Teleport to="body">
<div v-if="manageCauses" class="modal-mask" @click.self="manageCauses = false">
      <div class="modal">
        <h3>错因标签管理</h3>
        <div class="muted" style="margin-bottom: 10px">
          AI 自动分析错题时，会先读取这些标签及其说明：可选择已有标签，也可自行创建新标签。你也可以随时手动总结新标签。
        </div>
        <div v-for="c in causes" :key="c.id" class="node-card">
          <div class="toolbar" style="margin: 0 0 6px">
            <span class="cause-tag" :style="{ background: causeColor(c.name) + '22', color: causeColor(c.name), borderColor: causeColor(c.name) + '66' }">{{ c.name }}</span>
            <span class="badge" :class="c.source === 'ai' ? 'search' : 'done'">{{ c.source === 'ai' ? 'AI 创建' : '用户创建' }}</span>
            <div class="spacer"></div>
            <button class="small danger" @click="delCause(c)">删除</button>
          </div>
          <div style="display: block">
            <input v-model="c.name" placeholder="标签名" style="max-width: 320px; margin-bottom: 6px" />
            <input v-model="c.description" placeholder="标签说明（AI 分析时参考）" />
            <div style="margin-top: 6px"><button class="small" @click="saveCauseTag(c)">保存</button></div>
          </div>
        </div>
        <div class="card" style="margin: 12px 0 0">
          <h3>新建标签</h3>
          <div style="display: block">
            <input v-model="newCause.name" placeholder="标签名，如：题意理解偏差" style="max-width: 320px; margin-bottom: 6px" />
            <input v-model="newCause.description" placeholder="说明（推荐填写，供 AI 理解）" />
            <div style="margin-top: 6px"><button class="primary small" @click="addCause">添加</button></div>
          </div>
        </div>
        <div style="text-align: right; margin-top: 12px"><button @click="manageCauses = false">关闭</button></div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import WinComboBox from '../winui/components/WinComboBox.vue';
import WinAutoSuggestBox from '../winui/components/WinAutoSuggestBox.vue';
import { api } from '../api.js';
import { STATUS_TEXT, causeColor, masteryLevel, renderMarkdown } from '../util.js';
import { winConfirm, winAlert, winPrompt } from '../dialogs.js';

const md = renderMarkdown;
const subjects = ['数学', '物理', '化学', '生物', '语文', '英语', '历史', '地理', '政治', '其他'];
const causes = ref([]);
const items = ref([]);
const exams = ref([]);
const detail = ref(null);
const editCause = ref('');
const creating = ref(false);
const ctab = ref('text');
const createError = ref('');
const cSaving = ref(false);
const photo = ref(null);
const filter = reactive({ subject: '', cause: '', status: '', keyword: '' });

// 错题搜索建议：基于已加载题干的文本，随输入实时过滤
const wrongSuggestions = computed(() => {
  const q = (filter.keyword || '').trim();
  return items.value
    .map((w) => w.question)
    .filter((t) => t && (!q || t.includes(q)))
    .slice(0, 8);
});

function onWrongChosen({ SelectedItem }) {
  if (!SelectedItem) return;
  filter.keyword = SelectedItem;
  load();
}
const cform = reactive({ subject: '', examId: '', question: '', options: '', userAnswer: '', correctAnswer: '', errorCause: '', causeNote: '', guide: '' });
const manageCauses = ref(false);
const newCause = reactive({ name: '', description: '' });
const pageLoading = ref(true);

const subjectFilterOptions = computed(() => [
  { label: '全部科目', value: '' },
  ...subjects.map((s) => ({ label: s, value: s }))
]);
const causeFilterOptions = computed(() => [
  { label: '全部错因', value: '' },
  ...causes.value.map((c) => ({ label: c.name, value: c.name }))
]);
const causeOptions = computed(() => [
  { label: '由 AI 判断', value: '' },
  ...causes.value.map((c) => ({ label: c.name, value: c.name })),
  { label: '＋ 新建标签…', value: '__new__' }
]);
const wrongSubjectOptions = computed(() => [
  { label: '未知', value: '' },
  ...subjects.map((s) => ({ label: s, value: s }))
]);
const examOptions = computed(() => [
  { label: '无', value: '' },
  ...exams.value.map((e) => ({ label: `#${e.id} ${e.subject} ${e.exam_date}`, value: String(e.id) }))
]);
const wrongStatusOptions = [
  { label: '全部状态', value: '' },
  { label: '待分析', value: 'pending' },
  { label: '分析中', value: 'analyzing' },
  { label: '已分析', value: 'done' },
  { label: '失败', value: 'failed' }
];

function causeNameOf(c) {
  return typeof c === 'string' ? c : c?.name || '';
}

function causeColor2(c) {
  return causeColor(causeNameOf(c));
}
function nodeMastery(n) {
  const total = (n.correct || 0) + (n.wrong || 0);
  return total ? Math.round(((n.correct || 0) / total) * 100) : 0;
}

async function loadCauses() {
  try {
    causes.value = (await api.wrongCauses()).items;
  } catch {
    causes.value = [];
  }
}

async function load() {
  items.value = (await api.listWrong({
    subject: filter.subject || undefined,
    cause: filter.cause || undefined,
    status: filter.status || undefined,
    keyword: filter.keyword || undefined
  })).items;
}

async function openCreate() {
  creating.value = true;
  createError.value = '';
  exams.value = (await api.listExams({})).items;
  await loadCauses();
}

function openManage() {
  manageCauses.value = true;
  loadCauses();
}

async function addCause() {
  if (!newCause.name?.trim()) {
    winAlert({ title: '提示', message: '请输入标签名' });
    return;
  }
  try {
    await api.createCause({ name: newCause.name.trim(), description: newCause.description.trim() });
    newCause.name = '';
    newCause.description = '';
    await loadCauses();
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function saveCauseTag(c) {
  try {
    await api.updateCause(c.id, { name: c.name, description: c.description });
    await loadCauses();
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function delCause(c) {
  if (!(await winConfirm({ title: '删除确认', message: `删除错因标签「${c.name}」？已有错题上的该标签文字不会被清除。`, danger: true }))) return;
  try {
    const r = await api.deleteCause(c.id);
    if (r.referencedByWrong > 0) winAlert({ title: '提示', message: `标签已删除，但仍有 ${r.referencedByWrong} 道错题使用该标签文字` });
    await loadCauses();
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

function onPhoto(e) {
  photo.value = e.target.files[0] || null;
}

async function submitCreate() {
  createError.value = '';
  cSaving.value = true;
  try {
    if (ctab.value === 'photo') {
      if (!photo.value) throw new Error('请选择错题照片');
      const fd = new FormData();
      fd.append('image', photo.value);
      if (cform.subject) fd.append('subject', cform.subject);
      if (cform.question) fd.append('question', cform.question);
      if (cform.examId) fd.append('examId', cform.examId);
      if (cform.guide) fd.append('guide', cform.guide);
      await api.uploadWrong(fd);
    } else {
      let cause = cform.errorCause;
      if (cause === '__new__') {
        if (!cform.newCauseName?.trim()) throw new Error('请输入新错因标签名');
        cause = cform.newCauseName.trim();
      }
      await api.createWrong({
        subject: cform.subject || undefined,
        question: cform.question,
        options: cform.options || undefined,
        correctAnswer: cform.correctAnswer || undefined,
        userAnswer: cform.userAnswer || undefined,
        errorCause: cause || undefined,
        causeNote: cform.causeNote || undefined,
        examId: cform.examId || undefined,
        guide: cform.guide || undefined
      });
    }
    creating.value = false;
    Object.assign(cform, { question: '', options: '', userAnswer: '', correctAnswer: '', causeNote: '', guide: '', newCauseName: '' });
    photo.value = null;
    await Promise.all([load(), loadCauses()]);
  } catch (e) {
    createError.value = e.message;
  } finally {
    cSaving.value = false;
  }
}

async function view(w) {
  detail.value = await api.getWrong(w.id);
  editCause.value = detail.value.error_cause || '';
  await loadCauses();
}

function closeDetail() {
  detail.value = null;
}

async function analyze(w) {
  try {
    const guide = await winPrompt({ title: '错题分析', message: '分析引导词（可留空）', inputLabel: '引导词', defaultValue: '' }) || '';
    await api.analyzeWrong(w.id, guide);
    await load();
    if (detail.value?.id === w.id) await view(w);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function saveCause() {
  await api.updateWrong(detail.value.id, { errorCause: editCause.value });
  await view(detail.value);
  await load();
}

async function del(w) {
  if (!(await winConfirm({ title: '删除确认', message: `删除错题 #${w.id}？`, danger: true }))) return;
  await api.deleteWrong(w.id);
  if (detail.value?.id === w.id) detail.value = null;
  await load();
}

onMounted(() => {
  Promise.all([load(), loadCauses()])
    .catch(() => {})
    .finally(() => {
      pageLoading.value = false;
    });
});
</script>
