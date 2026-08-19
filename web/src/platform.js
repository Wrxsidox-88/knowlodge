// 页面平台偏好：页面切换动画模式（Windows 设置 > 外观与动画，与参考页 8 种一致）。
// 持久化到 localStorage('kl_page_transition')。
import { ref } from 'vue';

export const MODES = [
  { value: 'default', label: '默认' },
  { value: 'entrance', label: '进入' },
  { value: 'drillin', label: '钻取' },
  { value: 'suppress', label: '无动画' },
  { value: 'slide-right', label: '滑动（从右）' },
  { value: 'slide-left', label: '滑动（从左）' },
  { value: 'common', label: '通用' },
  { value: 'continuum', label: '连续' }
];

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('kl_page_transition') : null;
const valid = MODES.some((m) => m.value === stored);
export const pageTransition = ref(valid ? stored : 'slide-right');

export const pageTransitionIndex = ref(Math.max(0, MODES.findIndex((m) => m.value === pageTransition.value)));

export function setPageTransition(mode) {
  const idx = MODES.findIndex((m) => m.value === mode);
  if (idx < 0) return;
  pageTransition.value = mode;
  pageTransitionIndex.value = idx;
  try {
    localStorage.setItem('kl_page_transition', mode);
  } catch {
    /* 忽略存储失败 */
  }
}