import { ref } from 'vue';

// 主题状态：dark / light，持久化到 localStorage('kl_theme')
// WinUI 主题通过 <html class="theme-light|theme-dark"> 切换（WinUIonWeb 约定），
// 同时保留 data-theme 属性便于旧代码/第三方读取。
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('kl_theme') : null;
export const theme = ref(stored === 'light' ? 'light' : 'dark');

export function isDark() {
  return theme.value !== 'light';
}

export function applyTheme() {
  const html = document.documentElement;
  html.classList.remove('theme-light', 'theme-dark');
  html.classList.add(theme.value === 'light' ? 'theme-light' : 'theme-dark');
  html.setAttribute('data-theme', theme.value);
  // 同步 meta theme-color（真 UWP 应用中标题栏颜色随主题变化）
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', theme.value === 'light' ? '#F3F3F3' : '#202020');
}

export function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('kl_theme', theme.value);
  } catch {
    /* 忽略存储失败 */
  }
  applyTheme();
}