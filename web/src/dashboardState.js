// 首页 AI 加油站（WinInfoBar）的关闭状态持久化。
// 存放于模块级：仅刷新页面会重置（关闭后刷新重新显示）；
// 切换路由组件重建后仍保持关闭（关闭后切换页面再回来不重新显示）。
import { ref } from 'vue';

export const aiGasClosed = ref(false);