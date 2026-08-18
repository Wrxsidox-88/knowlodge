<template>
  <div class="chat-page">
    <aside class="chat-side glass">
      <button class="primary new-chat" @click="newConversation">新的对话</button>
      <div class="conv-list">
        <div
          v-for="c in conversations"
          :key="c.id"
          class="conv-item"
          :class="{ active: c.id === currentId }"
          @click="select(c.id)"
          @dblclick="rename(c)"
        >
          <span class="conv-title">{{ c.title }}</span>
          <button class="conv-del" title="删除对话" @click.stop="del(c)">×</button>
        </div>
        <div v-if="!conversations.length" class="muted" style="padding: 14px; font-size: 12px">
          暂无对话，点击上方按钮开始
        </div>
      </div>
      <div class="muted chat-side-foot">全能学习助手：可绘图 / 生成文档 / 调用系统数据；敏感操作需你授权</div>
    </aside>

    <section class="chat-main glass">
      <div ref="scrollEl" class="chat-scroll">
        <div v-if="!currentId && !messages.length" class="chat-empty">
          <div class="chat-hello">你好，我是你的全能学习助手</div>
          <div class="muted">学科问答 · 绘制函数与几何图形 · 生成 Word 文档 · 调用你的学情数据 · 公式自动渲染</div>
          <div class="suggests">
            <span v-for="s in suggestions" :key="s" class="chip" @click="quickAsk(s)">{{ s }}</span>
          </div>
        </div>

        <template v-for="m in messages" :key="m.id || m._k">
          <div v-if="m.role === 'user'" class="msg-user">
            <div class="bubble-user">{{ m.content }}</div>
          </div>
          <div v-else-if="m.role === 'note'" class="msg-note">
            <span>{{ m.content }}</span>
          </div>
          <div v-else class="msg-ai">
            <div class="ai-avatar">AI</div>
            <div class="ai-body">
              <div class="md-body" v-html="md(parsedOf(m).answerText)"></div>
              <div v-if="m._streaming" class="muted" style="font-size: 12px">
                <span class="typing"><i></i><i></i><i></i></span> 正在流式输出…
              </div>

              <FigureBlock v-for="(f, i) in parsedOf(m).figures" :key="'f' + i" :specText="f" />
              <ToolCallCard
                v-for="(t, i) in parsedOf(m).tools"
                :key="'t' + i"
                :call="t"
                :index="i"
                :messageId="m.id || null"
                :savedState="(m.meta && m.meta.toolCalls ? m.meta.toolCalls : {})[i] || null"
                :convId="currentId"
                @guide="onToolGuide"
              />

              <div v-if="parsedOf(m).personalTip" class="tip-box" v-html="md('**学情提示**：' + parsedOf(m).personalTip)"></div>

              <details v-if="parsedOf(m).relatedTree" class="ctx-box">
                <summary>关联知识点（树状）</summary>
                <div v-for="branch in parsedOf(m).relatedTree.children" :key="branch.label" class="tree-node">
                  <span class="badge">{{ branch.label }}</span>
                  <div v-for="n in branch.children" :key="n.nodeId" class="chip" @click="$router.push('/qa?tab=graph&node=' + n.nodeId)">
                    {{ n.label }}<span v-if="n.category" class="muted">（{{ n.category }}）</span>
                  </div>
                </div>
              </details>

              <details v-if="parsedOf(m).citations?.length" class="ctx-box">
                <summary>引用材料与出处（{{ parsedOf(m).citations.length }}）</summary>
                <div v-for="c in parsedOf(m).citations" :key="c.index" class="cite-item">
                  <div class="toolbar" style="margin: 0 0 4px">
                    <sup class="cite">[{{ c.index }}]</sup>
                    <strong style="font-size: 12.5px">{{ c.source }}</strong>
                    <div class="spacer"></div>
                    <span class="score-bar"><div :style="{ width: Math.round((c.score || 0) * 100) + '%' }"></div></span>
                    <span class="muted">{{ Math.round((c.score || 0) * 100) }}%</span>
                  </div>
                  <div class="muted" style="font-size: 12px; line-height: 1.6">{{ c.snippet }}...</div>
                  <router-link :to="`/materials?focus=${c.materialId}`" style="font-size: 12px">查看材料 →</router-link>
                </div>
              </details>
            </div>
          </div>
        </template>

        <div v-if="loading && !streamingMsg" class="msg-ai">
          <div class="ai-avatar">AI</div>
          <div class="ai-body">
            <span class="typing"><i></i><i></i><i></i></span>
            <span class="muted" style="margin-left: 8px">正在检索知识库与学情数据…</span>
          </div>
        </div>
      </div>

      <div class="chat-input-wrap">
        <div v-if="pendingRefs.length" class="refs-bar">
          <span v-for="(r, i) in pendingRefs" :key="i" class="chip ref-chip" :title="REF_LABELS[r.type]">
            {{ REF_LABELS[r.type] }}：{{ r.title }}
            <button class="ref-x" @click="pendingRefs.splice(i, 1)">×</button>
          </span>
        </div>
        <div class="chat-input">
          <button class="glass-btn" title="引用系统数据" @click="openRefs">引用</button>
          <select v-model="selectedModel" class="model-select" title="切换模型（自动获取自 API 的 /models）">
            <option value="">默认模型{{ modelConfigured ? `（${modelConfigured}）` : '' }}</option>
            <option v-for="mo in modelOptions" :key="mo" :value="mo">{{ mo }}</option>
          </select>
          <textarea
            v-model="input"
            rows="1"
            placeholder="输入问题，Enter 发送，Shift+Enter 换行；可让 AI 画图、生成文档"
            @keydown.enter="onEnter"
            @input="autoGrow"
          ></textarea>
          <button class="send-btn" :disabled="loading || !input.trim()" @click="send">发送</button>
        </div>
        <div class="muted" style="text-align: center; font-size: 11px; margin-top: 6px">
          绘图由系统精确渲染（AI 只提供数据）；工具类操作需授权后执行
        </div>
      </div>
    </section>

    <div v-if="refsModal" class="modal-mask" @click.self="refsModal = false">
      <div class="modal">
        <h3>引用系统数据（作为本次提问的上下文）</h3>
        <div class="tabs">
          <button v-for="t in refTabs" :key="t.key" :class="{ active: refTab === t.key }" @click="switchRefTab(t.key)">{{ t.label }}</button>
        </div>
        <div style="max-height: 380px; overflow: auto">
          <div v-if="!refItems.length" class="empty">暂无可引用的数据</div>
          <label v-for="item in refItems" :key="item.id" class="ref-row">
            <input type="checkbox" :value="item" v-model="refChecked" />
            <span class="ref-row-title">{{ item.title }}</span>
            <span class="muted">{{ item.sub }}</span>
          </label>
        </div>
        <div class="toolbar" style="margin-top: 12px">
          <span class="muted">已选 {{ refChecked.length }} 项</span>
          <div class="spacer"></div>
          <button @click="refsModal = false">取消</button>
          <button class="primary" :disabled="!refChecked.length" @click="confirmRefs">添加引用</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, sendMessageStream } from '../../api.js';
import { renderMarkdown } from '../../util.js';
import { winConfirm, winPrompt } from '../../dialogs.js';
import FigureBlock from './FigureBlock.vue';
import ToolCallCard from './ToolCallCard.vue';

const md = renderMarkdown;
const route = useRoute();
const router = useRouter();

const REF_LABELS = { material: '材料', wrong: '错题', exam: '考试', list: '清单', node: '知识点' };
const conversations = ref([]);
const currentId = ref(null);
const messages = ref([]);
const input = ref('');
const loading = ref(false);
const streamingMsg = ref(null);
const scrollEl = ref(null);
const selectedModel = ref('');
const modelOptions = ref([]);
const modelConfigured = ref('');
const pendingRefs = ref([]);
const refsModal = ref(false);
const refTab = ref('material');
const refItems = ref([]);
const refChecked = ref([]);
let seq = 0;

const refTabs = [
  { key: 'material', label: '学习材料' },
  { key: 'wrong', label: '错题' },
  { key: 'exam', label: '考试' },
  { key: 'list', label: '知识清单' },
  { key: 'node', label: '知识点' }
];

const suggestions = [
  '画出函数 y = sin(x)·x 的图像',
  '画一个直角三角形并标注边长，帮我讲解勾股定理',
  '把我最近错题整理成 Word 复习文档',
  '我的物理最近有进步吗？接下来怎么复习？'
];

function parseAssistantContent(raw, streaming = false) {
  let obj = null;
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    /* 纯文本消息 */
  }
  const hasObj = obj && typeof obj === 'object' && typeof obj.answer === 'string';
  let answerRaw = hasObj ? obj.answer : String(raw);
  // 流式输出中：隐藏尚未闭合的代码块（figure/tool），避免半截 JSON 闪烁
  if (streaming) {
    const fenceCount = (answerRaw.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) answerRaw = answerRaw.slice(0, answerRaw.lastIndexOf('```'));
  }
  const figures = [...answerRaw.matchAll(/```figure\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  const tools = [...answerRaw.matchAll(/```tool\s*([\s\S]*?)```/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1].trim());
      } catch {
        return null;
      }
    })
    .filter((t) => t && t.tool);
  const answerText = answerRaw.replace(/```figure\s*[\s\S]*?```/g, '').replace(/```tool\s*[\s\S]*?```/g, '').trim();
  return {
    answerText,
    figures,
    tools,
    citations: hasObj ? obj.citations : null,
    relatedTree: hasObj ? obj.relatedTree : null,
    personalTip: hasObj ? obj.personalTip : null
  };
}

function parsedOf(m) {
  if (m.role !== 'assistant') return {};
  if (!m._parsed || m._streaming) m._parsed = parseAssistantContent(m.content, Boolean(m._streaming));
  return m._parsed;
}

async function loadConversations() {
  conversations.value = (await api.listConversations()).items;
}

async function loadModels() {
  try {
    const r = await api.models();
    modelOptions.value = r.items || [];
    modelConfigured.value = r.configured || '';
  } catch {
    modelOptions.value = [];
  }
}

async function newConversation() {
  const { id } = await api.createConversation();
  await loadConversations();
  currentId.value = id;
  messages.value = [];
  router.replace({ query: { ...route.query, conv: id } });
}

async function select(id) {
  if (loading.value) return;
  currentId.value = id;
  const data = await api.getMessages(id);
  messages.value = data.items.map((m) => ({ ...m }));
  scrollBottom();
}

async function rename(c) {
  const t = await winPrompt({ title: '重命名对话', message: '请输入新的对话名称', inputLabel: '对话名称', defaultValue: c.title });
  if (t?.trim()) {
    api.renameConversation(c.id, t.trim()).then(loadConversations);
  }
}

async function del(c) {
  if (!(await winConfirm({ title: '删除确认', message: `删除对话「${c.title}」？`, danger: true }))) return;
  await api.deleteConversation(c.id);
  if (currentId.value === c.id) {
    currentId.value = null;
    messages.value = [];
  }
  await loadConversations();
}

async function send() {
  const q = input.value.trim();
  if (!q || loading.value) return;
  input.value = '';
  loading.value = true;
  const refs = pendingRefs.value.map((r) => ({ type: r.type, id: r.id }));
  pendingRefs.value = [];
  messages.value.push({ _k: 'u' + ++seq, role: 'user', content: q });
  scrollBottom();
  try {
    let convId = currentId.value;
    if (!convId) {
      const created = await api.createConversation();
      convId = created.id;
      currentId.value = created.id;
    }

    // 流式消息占位：content 为 result 结构，_streaming 标记逐字渲染
    const msg = { _k: 'a' + ++seq, role: 'assistant', _streaming: true, content: { answer: '' } };
    messages.value.push(msg);
    streamingMsg.value = msg;
    scrollBottom();

    await new Promise((resolve) => {
      sendMessageStream(convId, q, selectedModel.value || undefined, refs.length ? refs : undefined, {
        onMeta: (meta) => {
          msg.content = { ...msg.content, citations: meta.citations, relatedTree: meta.relatedTree, personalTip: meta.personalTip, question: meta.question };
          scrollBottom();
        },
        onToken: (delta, full) => {
          msg.content = { ...msg.content, answer: full };
          scrollBottom();
        },
        onDone: (evt) => {
          msg.content = evt.result;
          msg.id = evt.messageId;
          msg._streaming = false;
          msg._parsed = null;
          streamingMsg.value = null;
          resolve();
        },
        onError: (message) => {
          msg._streaming = false;
          msg.content = msg.content?.answer
            ? { answer: `${msg.content.answer}\n\n（流式中断：${message}）` }
            : { answer: `回答失败：${message}` };
          streamingMsg.value = null;
          resolve();
        }
      });
    });
    await loadConversations();
  } catch (e) {
    messages.value.push({ _k: 'e' + ++seq, role: 'assistant', content: `回答失败：${e.message}` });
  } finally {
    loading.value = false;
    streamingMsg.value = null;
    scrollBottom();
  }
}

function quickAsk(s) {
  input.value = s;
  send();
}

function onToolGuide(guideText) {
  const q = guideText
    ? `我拒绝了刚才的工具调用。调整要求：${guideText}`
    : '我拒绝了刚才的工具调用，请换个方案。';
  input.value = q;
  send();
}

function onEnter(e) {
  if (!e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function autoGrow(e) {
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function scrollBottom() {
  requestAnimationFrame(() => {
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  });
}

async function openRefs() {
  refsModal.value = true;
  refChecked.value = [];
  await switchRefTab(refTab.value);
}

async function switchRefTab(key) {
  refTab.value = key;
  refChecked.value = [];
  refItems.value = [];
  try {
    if (key === 'material') {
      refItems.value = (await api.listMaterials({})).items.map((m) => ({
        type: 'material', id: m.id, title: `《${m.title}》`, sub: `${m.subject || '未分类'} · ${m.status}`
      }));
    } else if (key === 'wrong') {
      refItems.value = (await api.listWrong({})).items.map((w) => ({
        type: 'wrong', id: w.id, title: `#${w.id} ${String(w.question).slice(0, 40)}`, sub: `${w.subject || '未分类'} · ${w.error_cause || '未标注'}`
      }));
    } else if (key === 'exam') {
      refItems.value = (await api.listExams({})).items.map((e) => ({
        type: 'exam', id: e.id, title: `${e.subject} ${e.exam_date} ${e.score}/${e.total_score}`, sub: e.event_title || e.title || ''
      }));
    } else if (key === 'list') {
      const tree = (await api.listsTree()).items;
      const flat = [];
      const walk = (nodes) => {
        for (const n of nodes) {
          if (n.kind === 'note') flat.push({ type: 'list', id: n.id, title: `《${n.name}》`, sub: n.description || '' });
          walk(n.children || []);
        }
      };
      walk(tree);
      refItems.value = flat;
    } else if (key === 'node') {
      const g = await api.graph({ limit: 500 });
      refItems.value = (g.nodes || []).map((n) => ({
        type: 'node', id: n.id, title: `《${n.name}》`, sub: `${n.subject || '未分类'} · ${n.category || ''}`
      }));
    }
  } catch {
    refItems.value = [];
  }
}

function confirmRefs() {
  for (const item of refChecked.value) {
    if (!pendingRefs.value.some((r) => r.type === item.type && r.id === item.id)) {
      pendingRefs.value.push(item);
    }
  }
  refsModal.value = false;
}

onMounted(async () => {
  await Promise.all([loadConversations(), loadModels()]);
  if (route.query.q) {
    input.value = route.query.q;
    send();
  } else if (conversations.value.length) {
    await select(conversations.value[0].id);
  }
});
</script>
