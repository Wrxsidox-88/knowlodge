import { reactive } from 'vue';

/**
 * 全局开发者模式状态。
 * 在 Settings.vue 中激活 / 关闭，在 App.vue 中渲染浮动面板。
 */
export const devState = reactive({
  enabled: false
});