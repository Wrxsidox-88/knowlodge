<template>
  <!-- 开发者模式已开启：全局固定浮动面板（持久于所有页面） -->
  <div v-if="devState.enabled" id="dev-options" class="dev-float">
    <WinExpander class="settings-expander" Header="开发者选项" HeaderIcon="&#xE71D;" v-model:IsExpanded="expandOpen">
      <div class="dev-actions">
        <div class="dev-row">
          <div>
            <div class="dev-title">查看详细日志</div>
            <div class="muted" style="font-size: 12px">AI 分析、流式对话等详细运行日志；弹窗查看并每 5 秒自动刷新</div>
          </div>
          <button @click="openLogs">打开日志</button>
        </div>
        <div class="dev-row">
          <div>
            <div class="dev-title">清空系统数据</div>
            <div class="muted" style="font-size: 12px">删除全部材料、知识图谱、错题、考试、倒计时等数据；需二次确认并输入密码</div>
          </div>
          <button class="danger" @click="openClear">清空数据</button>
        </div>
      </div>
      <div class="toolbar" style="margin-top: 12px">
        <span class="muted" style="font-size: 12px">关闭后页面将自动刷新回到普通模式。</span>
        <div class="spacer"></div>
        <button @click="closeDev">关闭开发者模式</button>
      </div>
    </WinExpander>
  </div>

  <!-- 详细日志弹窗：每 5 秒自动刷新 -->
  <Teleport to="body">
    <div v-if="logModal" class="modal-mask">
      <div class="modal log-modal">
        <h3>详细日志<span class="muted" style="font-size: 12px"> 每 5 秒自动刷新{{ logEntries.length ? ' · ' + logEntries.length + ' 条' : '' }}</span></h3>
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px">
          <button :disabled="logBusy" @click="refreshLogs">{{ logBusy ? '刷新中…' : '立即刷新' }}</button>
          <span v-if="logLastRefreshed" class="muted" style="font-size: 12px">更新于 {{ logLastRefreshed }}</span>
          <div class="spacer"></div>
          <button @click="closeLogs">关闭</button>
        </div>
        <pre class="log-box log-box-live">{{ logText }}</pre>
      </div>
    </div>
  </Teleport>

  <!-- 清空系统数据：二次提示后输入密码确认 -->
  <Teleport to="body">
    <div v-if="clearModal" class="modal-mask">
      <div class="modal" style="width: min(420px, 92vw)">
        <h3>清空系统数据</h3>
        <p class="muted" style="font-size: 13px; line-height: 1.7; margin-bottom: 12px">
          将删除<strong>全部</strong>材料、知识图谱、错题、考试、练习、倒计时、知识清单、脑图与聊天记录，<strong>不可恢复</strong>。请再次输入密码确认：
        </p>
        <label class="field">
          <span>密码</span>
          <div class="pw-row">
            <WinPasswordBox v-model:Password="clearPw" :PasswordRevealMode="clearPwShow ? 'Visible' : 'Hidden'" PlaceholderText="输入当前账户密码" :Width="'100%'" />
            <WinCheckBox v-model:IsChecked="clearPwShow" Content="显示密码" />
          </div>
        </label>
        <div v-if="clearErr" class="error-box" style="margin: 0 0 10px">{{ clearErr }}</div>
        <div style="display: flex; justify-content: flex-end; gap: 10px">
          <button @click="clearModal = false">取消</button>
          <button class="danger" :disabled="clearBusy" @click="confirmClear">
            <span v-if="clearBusy" class="loading"></span>确认清空
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import WinExpander from '../winui/components/WinExpander.vue';
import WinPasswordBox from '../winui/components/WinPasswordBox.vue';
import WinCheckBox from '../winui/components/WinCheckBox.vue';
import { api } from '../api.js';
import { devState } from '../devState.js';
import { winConfirm, winAlert } from '../dialogs.js';

const expandOpen = ref(true);

// ---- 详细日志 ----
const logModal = ref(false);
const logEntries = ref([]);
const logBusy = ref(false);
const logLastRefreshed = ref('');
let logTimer = null;

const logText = computed(() =>
  logEntries.value
    .slice()
    .reverse()
    .map((l) => {
      const t = (l.time || '').slice(11, 19);
      const extra = l.extra !== undefined ? `\n    详情: ${JSON.stringify(l.extra)}` : '';
      return `[${t}] [${l.level}] ${l.msg}${extra}`;
    })
    .join('\n')
);

async function refreshLogs() {
  if (logBusy.value) return;
  logBusy.value = true;
  try {
    const d = await api.getLogs();
    logEntries.value = (d.logs || []).slice(-200);
    logLastRefreshed.value = new Date().toLocaleTimeString();
  } catch {
    /* 拉取失败静默 */
  } finally {
    logBusy.value = false;
  }
}

function openLogs() {
  logModal.value = true;
  refreshLogs();
  clearInterval(logTimer);
  logTimer = setInterval(refreshLogs, 5000);
}

function closeLogs() {
  logModal.value = false;
  clearInterval(logTimer);
  logTimer = null;
}

// ---- 清空系统数据 ----
const clearModal = ref(false);
const clearPw = ref('');
const clearPwShow = ref(false);
const clearBusy = ref(false);
const clearErr = ref('');

function openClear() {
  winConfirm({
    title: '清空系统数据',
    message: '确定要清空全部数据吗？此操作不可恢复。'
  }).then((ok) => {
    if (!ok) return;
    clearPw.value = '';
    clearErr.value = '';
    clearModal.value = true;
  });
}

async function confirmClear() {
  clearErr.value = '';
  if (!clearPw.value) {
    clearErr.value = '请输入密码';
    return;
  }
  clearBusy.value = true;
  try {
    await api.devClearData(clearPw.value);
    clearModal.value = false;
    winAlert({ title: '已完成', message: '已清空系统数据，即将刷新页面。' }).then(() => location.reload());
  } catch (e) {
    clearErr.value = e.message || '清空失败';
  } finally {
    clearBusy.value = false;
  }
}

// ---- 关闭开发者模式 ----
async function closeDev() {
  try {
    await api.devDisable();
  } catch {
    /* 即使失败也回到普通模式 */
  }
  devState.enabled = false;
  location.reload();
}

onUnmounted(() => {
  clearInterval(logTimer);
});
</script>
