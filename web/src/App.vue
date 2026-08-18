<template>
  <!-- 登录页：独立全屏 UWP 登录界面 -->
  <router-view v-if="$route.path === '/login'" />

  <!-- 主应用：UWP 窗口壳（标题栏 + NavigationView） -->
  <div v-else class="win-shell">
    <WinTitleBar
      class="app-titlebar"
      Title="knowlodge"
      Subtitle="知识图谱智能问答系统"
      PreferredHeightOption="Tall"
      :IsBackButtonVisible="false"
      :IsPaneToggleButtonVisible="false"
      :IconSource="{ Glyph: '\uE8A1' }"
      TitleBarContentHorizontalAlignment="Stretch">
      <template #RightHeader>
        <div class="titlebar-actions">
          <button
            class="tb-action-btn"
            :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
            @click="onToggleTheme">
            <span aria-hidden="true">&#xE706;</span>
            <span class="tb-theme-text">{{ theme === 'dark' ? '浅色' : '深色' }}</span>
          </button>
          <div class="titlebar-user">
            <span class="person-circle">{{ (user?.username || 'admin').charAt(0).toUpperCase() }}</span>
            <span>{{ user?.username || 'admin' }}</span>
            <a href="javascript:void(0)" @click="logout">退出</a>
          </div>
        </div>
      </template>
    </WinTitleBar>

    <div class="win-shell-body">
      <WinNavigationView
        :SelectedItem="selectedItem"
        :MenuItems="navItems"
        :FooterMenuItems="footerItems"
        v-model:IsPaneOpen="isPaneOpen"
        IsPaneToggleButtonVisible="true"
        IsBackButtonVisible="Collapsed"
        PaneTitle="knowlodge"
        :IsSettingsVisible="false"
        @ItemInvoked="onNavInvoked">
        <main class="main">
          <div class="page-title">{{ $route.meta.title }}</div>
          <div class="page-desc">{{ descriptions[$route.path] || '' }}</div>
          <router-view v-slot="{ Component }">
            <component :is="Component" :key="$route.path + '::' + theme" />
          </router-view>
        </main>
      </WinNavigationView>
    </div>
  </div>

  <!-- 全局 WinUI 对话框宿主（替代浏览器 alert/confirm/prompt） -->
  <WinContentDialog
    :IsOpen="dialogState.open"
    :Title="dialogState.title"
    :PrimaryButtonText="dialogState.primary"
    :SecondaryButtonText="dialogState.secondary"
    :CloseButtonText="dialogState.close"
    :DefaultButton="dialogState.defaultButton"
    @PrimaryButtonClick="settleDialog('primary')"
    @SecondaryButtonClick="settleDialog('secondary')"
    @CloseButtonClick="settleDialog('close')">
    <div class="win-dialog-message" :class="{ 'is-danger': dialogState.danger }">{{ dialogState.message }}</div>
    <div v-if="dialogState.kind === 'prompt'" class="win-dialog-input">
      <label v-if="dialogState.inputLabel">{{ dialogState.inputLabel }}</label>
      <input
        ref="promptInputRef"
        v-model="dialogState.inputValue"
        spellcheck="false"
        autocomplete="off"
        @keyup.enter="promptEnter" />
    </div>
  </WinContentDialog>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import WinTitleBar from './winui/components/WinTitleBar.vue';
import WinNavigationView from './winui/components/WinNavigationView.vue';
import WinContentDialog from './winui/components/WinContentDialog.vue';
import { api } from './api.js';
import { theme, toggleTheme } from './theme.js';
import { dialogState, settleDialog } from './dialogs.js';

const route = useRoute();
const router = useRouter();
const isPaneOpen = ref(true);
const promptInputRef = ref(null);

// 输入型对话框打开时自动聚焦输入框
watch(() => dialogState.open, (open) => {
  if (open && dialogState.kind === 'prompt') {
    nextTick(() => promptInputRef.value?.focus());
  }
});

function promptEnter() {
  if (dialogState.open && dialogState.kind === 'prompt') {
    settleDialog('primary');
  }
}

function onToggleTheme() {
  toggleTheme();
}

/* ---- 导航项（WinUI NavigationView MenuItems） ---- */
// Tag 使用路由路径，Icon 为 Segoe MDL2 / Fluent 图标字码
const navItems = [
  { Tag: '/', Icon: '\uE80F', Content: '总览' },
  { Tag: '/qa', Icon: '\uE8AC', Content: 'AI 问答' },
  { Tag: '/lists', Icon: '\uE8D2', Content: '知识清单' },
  { Tag: '/mindmap', Icon: '\uED41', Content: '脑图' },
  { Tag: '/exams', Icon: '\uE734', Content: '考试管理' },
  { Tag: '/wrong', Icon: '\uE73D', Content: '错题本' },
  { Tag: '/study', Icon: '\uE80A', Content: '学情分析' },
  { Tag: '/practice', Icon: '\uE8AB', Content: '练习中心' },
  { Tag: '/report', Icon: '\uE8E4', Content: '学习报告' },
  { Tag: '/materials', Icon: '\uE8B9', Content: '材料管理' },
  { Tag: '/analysis', Icon: '\uE945', Content: '材料分析生成' },
  { Tag: '/settings', Icon: '\uE713', Content: '系统设置' }
];

const user = ref(null);

const selectedItem = computed(() => {
  const item = navItems.find((n) => n.Tag === route.path);
  return item || navItems[0];
});

const footerItems = computed(() => [
  { Tag: 'logout', Content: `退出登录 · ${user.value?.username || 'admin'}` }
]);

const descriptions = {
  '/': '系统概览、数据统计与运行情况',
  '/qa': '智能对话 · 语义检索 · 知识库（图谱）——统一入口，子页签切换',
  '/lists': '知识清单：目录化管理 Markdown 笔记，可选择性允许 AI 编辑',
  '/mindmap': '脑图：自由创建/编辑思维导图，支持 AI 引导生成、引用资料与全屏查看',
  '/exams': '登记考试与练习成绩，支持多科目大型考试与总体分析',
  '/wrong': '错题录入、结构化与错因标签管理',
  '/study': '薄弱点定位：雷达图、错因分布、掌握度与复习提醒',
  '/practice': '针对薄弱考点的变式训练与判定',
  '/report': '考点理解程度与能力提升可视化报告',
  '/materials': '上传与治理学习材料',
  '/analysis': '触发材料分析，构建并完善知识图谱',
  '/settings': '系统参数、AI 模型、倒计时与数据管理'
};

onMounted(async () => {
  // WinTitleBar 会把 document.title 替换为其 Title，这里恢复中文页面标题
  if (document.title === 'knowlodge') {
    document.title = '知识图谱智能问答系统';
  }
  try {
    const data = await api.me();
    user.value = data.user;
  } catch {
    /* 忽略 */
  }
});

function onNavInvoked(args) {
  const item = args && (args.InvokedItemContainer || args.Item);
  if (!item) return;
  const tag = item.Tag;
  if (tag === 'logout') {
    logout();
    return;
  }
  if (tag && tag !== route.path) {
    router.push(tag);
  }
}

function logout() {
  localStorage.removeItem('kl_token');
  router.push('/login');
}
</script>