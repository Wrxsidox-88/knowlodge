import * as echarts from 'echarts/core';
import { RadarChart, LineChart, BarChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { theme } from './theme.js';

echarts.use([
  RadarChart,
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer
]);

export default echarts;

export const CHART_COLORS = ['#4CC2FF', '#6CCB5F', '#FCE100', '#FF99A4', '#C7C5FF', '#48B2FF', '#FF8C4B', '#9DD5A0'];

// 图表配色随主题切换（深色/浅色）。图表在主题切换时会随页面重建，读取当时取值。
const CHART_PALETTES = {
  dark: {
    axisLine: 'rgba(255,255,255,0.18)',
    axisLabel: 'rgba(255,255,255,0.60)',
    splitLine: 'rgba(255,255,255,0.09)',
    label: 'rgba(255,255,255,0.82)',
    nodeLabel: '#FFFFFF',
    edgeLine: 'rgba(255,255,255,0.22)',
    edgeLabel: 'rgba(255,255,255,0.55)',
    focusBorder: '#FFFFFF',
    tooltipBg: '#2C2C2C',
    tooltipBorder: 'rgba(255,255,255,0.12)',
    tooltipText: 'rgba(255,255,255,0.90)'
  },
  light: {
    axisLine: 'rgba(0,0,0,0.16)',
    axisLabel: 'rgba(0,0,0,0.55)',
    splitLine: 'rgba(0,0,0,0.07)',
    label: 'rgba(0,0,0,0.80)',
    nodeLabel: 'rgba(0,0,0,0.89)',
    edgeLine: 'rgba(0,0,0,0.18)',
    edgeLabel: 'rgba(0,0,0,0.50)',
    focusBorder: '#0067C0',
    tooltipBg: '#FFFFFF',
    tooltipBorder: 'rgba(0,0,0,0.10)',
    tooltipText: 'rgba(0,0,0,0.85)'
  }
};

export function chartPalette() {
  return CHART_PALETTES[theme.value] || CHART_PALETTES.dark;
}

// 兼容旧用法：AXIS_STYLE.splitLine / AXIS_STYLE.axisLabel / AXIS_STYLE.axisLine（取值时按当前主题计算）
export const AXIS_STYLE = {
  get axisLine() {
    return { lineStyle: { color: chartPalette().axisLine } };
  },
  get axisLabel() {
    return { color: chartPalette().axisLabel };
  },
  get splitLine() {
    return { lineStyle: { color: chartPalette().splitLine } };
  }
};
