import { createApp } from 'vue';
import 'katex/dist/katex.min.css';
import App from './App.vue';
import { router } from './router.js';
import { applyTheme } from './theme.js';
// WinUIonWeb 全局样式：WinUI/Fluent 主题令牌与动画
import './winui/styles/theme.css';
import './winui/styles/animations.css';
import './style.css';

applyTheme();
createApp(App).use(router).mount('#app');