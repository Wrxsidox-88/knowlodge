import { createApp } from 'vue';
import 'katex/dist/katex.min.css';
import App from './App.vue';
import { router } from './router.js';
import { applyTheme } from './theme.js';
// WinUIonWeb 全局样式：WinUI/Fluent 主题令牌与动画
import './winui/styles/theme.css';
import './winui/styles/animations.css';
import './style.css';
// 图标字体（与 @font-face 同一源文件，Vite 内容寻址保证同一产物、零重复下载）
import iconsFontUrl from './winui/assets/Fonts/SEGOEICONS.TTF?url';
import { bootReady } from './bootState.js';
import { bootRequestStarted } from './api.js';

applyTheme();
createApp(App).use(router).mount('#app');

// 全屏"正在加载"提示（index.html 首屏层）：
// 页面从一开始就在下层持续加载渲染；提示层保留到【首屏页面关键数据】与【图标字体】都就绪才淡出移除。
// 任一视图数据请求完成会触发 bootReady；字体本地预加载；5s 绝对兜底防止异常场景滞留。
const hideBoot = () => {
  const boot = document.getElementById('kl-boot');
  if (!boot) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 350);
};

const preloadIcons = async () => {
  try {
    const font = new FontFace('WinUIOnWebIcons', `url(${iconsFontUrl})`);
    await font.load();
    document.fonts.add(font);
  } catch {
    /* 字体注册失败不影响主流程（按需加载兜底） */
  }
};

const finishBoot = () => requestAnimationFrame(hideBoot);
const bootTimeout = new Promise((resolve) => setTimeout(resolve, 5000));
// 看门狗：仅当页面"确实未发起任何数据请求"时（登录页/语义检索等无首屏请求）才兜底就绪；
// 已有数据请求在途的页面由拦截器在首个请求返回时置就绪，避免过早隐藏加载层。
setTimeout(() => {
  if (!bootRequestStarted()) markBootReady();
}, 1800);
Promise.race([Promise.all([bootReady, preloadIcons()]), bootTimeout]).then(finishBoot);