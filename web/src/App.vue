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
          <div ref="accountUserRef" class="titlebar-user" title="账户" @click="toggleAccount">
            <span class="person-circle">{{ (user?.username || 'admin').charAt(0).toUpperCase() }}</span>
            <span>{{ user?.username || 'admin' }}</span>
            <span class="tb-user-chevron" aria-hidden="true">&#xE70D;</span>
          </div>
        </div>
      </template>
    </WinTitleBar>

    <!-- 顶部账户卡片：点击右上角账户弹出（头像/角色 + 快捷跳转设置/退出） -->
    <WinMenuFlyout
      :Open="accountOpen"
      :AnchorRect="accountAnchor"
      Placement="BottomEdgeAlignedRight"
      @Close="accountOpen = false">
      <div class="account-flyout">
        <div class="af-head">
          <span class="person-circle af-avatar">{{ (user?.username || 'admin').charAt(0).toUpperCase() }}</span>
          <div class="af-meta">
            <div class="af-name">{{ user?.username || 'admin' }}</div>
            <div class="af-role">{{ user?.role === 'admin' ? '管理员' : '用户' }} · 本地账户</div>
          </div>
        </div>
        <div class="af-actions">
          <button class="small" @click="goAccount">账户设置</button>
          <button class="small danger" @click="logout">退出登录</button>
        </div>
      </div>
    </WinMenuFlyout>

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
            <Transition :name="pageTransitionClass" mode="out-in">
              <component :is="Component" :key="$route.path + '::' + theme" />
            </Transition>
          </router-view>
          <!-- 底部白色补偿块：抵消屏幕底部高度判断误差导致的遮挡 -->
          <div class="content-bottom-space" aria-hidden="true"></div>
        </main>
      </WinNavigationView>
    </div>

    <!-- 开发者选项浮动面板：全局持久（切换页面不消失），仅登录后显示 -->
    <DevPanel />
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
import WinMenuFlyout from './winui/components/WinMenuFlyout.vue';
import { api } from './api.js';
import { theme, toggleTheme } from './theme.js';
import { pageTransition } from './platform.js';
import { dialogState, settleDialog } from './dialogs.js';
import { devState } from './devState.js';
import DevPanel from './components/DevPanel.vue';

const route = useRoute();
const router = useRouter();
const isPaneOpen = ref(true);
const promptInputRef = ref(null);

// 页面切换动画类名：suppress（无动画）时为空字符串，其余对应 page-{mode} CSS 过渡
const pageTransitionClass = computed(() =>
  pageTransition.value === 'suppress' ? '' : `page-${pageTransition.value}`
);

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

// 顶部账户卡片
const accountUserRef = ref(null);
const accountOpen = ref(false);
const accountAnchor = ref(null);

function toggleAccount() {
  const el = accountUserRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  accountAnchor.value = {
    left: r.right - 240,
    right: r.right,
    top: r.bottom + 4,
    bottom: r.bottom + 4,
    width: 240,
    height: 0
  };
  accountOpen.value = !accountOpen.value;
}

function goAccount() {
  accountOpen.value = false;
  router.push('/settings');
}

/* ---- 导航项（WinUI NavigationView MenuItems） ---- */
// Tag 使用路由路径，Icon 为 Segoe MDL2 / Fluent 图标字码；
// children 子菜单：展开态为可折叠分组，收起态点击图标弹出子菜单
const navItems = [
  { Tag: '/', Icon: '\uE80F', Content: '总览' },
  {
    Tag: 'kb',
    Icon: '\uE8AC',
    Content: '知识库',
    SelectsOnInvoked: false,
    children: [
      { Tag: '/qa', Icon: '\uE8AC', Content: '智能问答' },
      { Tag: '/semantic', Icon: '\uE721', Content: '语义检索' },
      { Tag: '/graph', Icon: '\uE8A5', Content: '知识图谱' },
      { Tag: '/lists', Icon: '\uE8D2', Content: '知识清单' },
      { Tag: '/mindmap', Icon: '\uED41', Content: '脑图' }
    ]
  },
  {
    Tag: 'sh',
    Icon: '\uE80A',
    Content: '学情中心',
    SelectsOnInvoked: false,
    children: [
      { Tag: '/exams', Icon: '\uE734', Content: '考试管理' },
      { Tag: '/wrong', Icon: '\uE73D', Content: '错题本' },
      { Tag: '/study', Icon: '\uE80A', Content: '学情分析' },
      { Tag: '/practice', Icon: '\uE8AB', Content: '练习中心' },
      { Tag: '/report', Icon: '\uE8E4', Content: '学习报告' }
    ]
  },
  {
    Tag: 'mat',
    Icon: '\uE8B9',
    Content: '材料',
    SelectsOnInvoked: false,
    children: [
      { Tag: '/materials', Icon: '\uE8B9', Content: '材料管理' },
      { Tag: '/analysis', Icon: '\uE945', Content: '分析生成' }
    ]
  },
  { Tag: '/settings', Icon: '\uE713', Content: '系统设置' }
];

const user = ref(null);

const findNavItem = (items, path) => {
  for (const n of items) {
    if (n.Tag === path) return n;
    if (n.children) {
      const hit = n.children.find((c) => c.Tag === path);
      if (hit) return hit;
    }
  }
  return null;
};

const selectedItem = computed(() => {
  const kb = navItems.find((n) => n.Tag === 'kb');
  // 知识库页内页签：精确高亮对应子菜单项
  if (route.path === '/qa' && kb?.children) {
    if (route.query.tab === 'semantic' || route.query.tab === 'graph' || route.query.tab === 'lists' || route.query.tab === 'mindmap') {
      return kb.children.find((c) => c.Tag === `/${route.query.tab}`) || kb.children[0];
    }
    return kb.children[0];
  }
  const mat = navItems.find((n) => n.Tag === 'mat');
  // 材料页内页签：精确高亮对应子菜单项
  if (route.path === '/materials' && mat?.children) {
    if (route.query.tab === 'analysis') {
      return mat.children.find((c) => c.Tag === '/analysis') || mat.children[0];
    }
    return mat.children[0];
  }
  const sh = navItems.find((n) => n.Tag === 'sh');
  // 学情中心页内页签：精确高亮对应子菜单项
  if (route.path === '/studyhub' && sh?.children) {
    const t = ['wrong', 'study', 'practice', 'report'].includes(route.query.tab) ? route.query.tab : 'exams';
    return sh.children.find((c) => c.Tag === `/${t}`) || sh.children[0];
  }
  return findNavItem(navItems, route.path) || navItems[0];
});

const footerItems = computed(() => [
  { Tag: 'logout', Content: `退出登录 · ${user.value?.username || 'admin'}` }
]);

const descriptions = {
  '/': '系统概览、数据统计与运行情况',
  '/qa': '知识库统一入口：智能对话 · 语义检索 · 知识图谱 · 知识清单 · 脑图，子页签切换',
  '/semantic': '语义检索：基于向量模型的语义级检索',
  '/lists': '知识清单：目录化管理 Markdown 笔记，可选择性允许 AI 编辑',
  '/mindmap': '脑图：自由创建/编辑思维导图，支持 AI 引导生成、引用资料与全屏查看',
  '/studyhub': '学情中心统一入口：考试管理 · 错题本 · 学情分析 · 练习中心 · 学习报告，子页签切换',
  '/materials': '材料统一入口：上传与治理学习材料，触发分析并构建知识图谱（子页签切换）',
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
  // 同步开发者模式状态（服务端持久化），使浮动面板在刷新/切页后依然可见
  try {
    const d = await api.devStatus();
    devState.enabled = !!d.enabled;
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
  // 分组头（如“知识库”“材料”“学情中心”）仅用于展开子菜单，不导航
  if (tag === 'kb' || tag === 'mat' || tag === 'sh') return;
  if (tag && tag !== route.path) {
    router.push(tag);
  }
}

function logout() {
  localStorage.removeItem('kl_token');
  router.push('/login');
}
</script>