<template>
  <span class="animated-num">{{ display }}</span>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue';

/**
 * 数字滚动动画：数据加载/变化后，数字快速从当前值递增（easeOutCubic）到目标值。
 * 用法：<AnimatedNumber :value="123" :duration="900" />
 */
const props = defineProps({
  value: { type: Number, default: 0 },
  duration: { type: Number, default: 900 }
});

const display = ref(0);
let raf = null;
let from = 0;
let startTime = 0;

function animateTo(target) {
  if (typeof target !== 'number' || Number.isNaN(target)) target = 0;
  from = display.value;
  if (from === target) return;
  cancelAnimationFrame(raf);
  startTime = performance.now();
  const dur = Math.max(0, props.duration);
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / dur);
    // easeOutCubic：快速起步、减速收尾
    const eased = 1 - Math.pow(1 - t, 3);
    display.value = Math.round(from + (target - from) * eased);
    if (t < 1) {
      raf = requestAnimationFrame(step);
    } else {
      display.value = target;
    }
  };
  raf = requestAnimationFrame(step);
}

watch(() => props.value, (v) => animateTo(v), { immediate: true });

onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>