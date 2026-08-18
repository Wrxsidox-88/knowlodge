import { createCanvas } from '@napi-rs/canvas';
import * as math from 'mathjs';

const COLORS = ['#4f8cff', '#ef5f6b', '#27c8a0', '#f0a938', '#9d6bff', '#3fc1e0'];
const FONT_MATH = 'STIX Two Math, Cambria Math, Times New Roman, serif';

export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object') throw Object.assign(new Error('图形 spec 为空'), { status: 400 });
  const s = JSON.parse(JSON.stringify(spec));
  if (!s.type) throw Object.assign(new Error('图形 spec 缺少 type（function|geometry）'), { status: 400 });
  if (s.type === 'function') {
    if (typeof s.expr === 'string' && s.expr.trim()) s.curves = [{ expr: s.expr }];
    if (!Array.isArray(s.curves) || !s.curves.length) throw Object.assign(new Error('function 图形需要 expr 或 curves'), { status: 400 });
    s.curves = s.curves.map((c, i) => ({
      expr: String(c.expr ?? c),
      color: c.color || COLORS[i % COLORS.length],
      label: c.label || `y = ${c.expr ?? c}`
    }));
    if (s.xMin == null) s.xMin = -10;
    if (s.xMax == null) s.xMax = 10;
    if (!(s.xMax > s.xMin)) [s.xMin, s.xMax] = [s.xMax, s.xMin];
  } else if (s.type === 'geometry') {
    if (!Array.isArray(s.elements) || !s.elements.length) throw Object.assign(new Error('geometry 图形需要 elements'), { status: 400 });
  } else {
    throw Object.assign(new Error('不支持的图形类型: ' + s.type), { status: 400 });
  }
  return s;
}

function sampleFunction(expr, xMin, xMax, n = 600) {
  let compiled;
  try {
    compiled = math.compile(expr);
  } catch (e) {
    throw Object.assign(new Error(`函数表达式无效 "${expr}": ${e.message}`), { status: 400 });
  }
  const pts = [];
  const step = (xMax - xMin) / n;
  for (let i = 0; i <= n; i++) {
    const x = xMin + i * step;
    let y;
    try {
      y = compiled.evaluate({ x, e: Math.E, pi: Math.PI });
    } catch {
      y = NaN;
    }
    pts.push([x, typeof y === 'number' && Number.isFinite(y) ? y : NaN]);
  }
  return pts;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx];
}

function niceStep(range, target = 8) {
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= raw) return m * pow;
  }
  return 10 * pow;
}

function fmt(v) {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

export function buildScene(rawSpec) {
  const spec = normalizeSpec(rawSpec);
  const cmds = [];
  let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
  const touch = (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xLo = Math.min(xLo, x); xHi = Math.max(xHi, x);
      yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
    }
  };
  const sampled = [];

  if (spec.type === 'function') {
    const allY = [];
    for (const curve of spec.curves) {
      const pts = sampleFunction(curve.expr, spec.xMin, spec.xMax);
      sampled.push({ curve, pts });
      for (const [x, y] of pts) if (Number.isFinite(y)) allY.push(y);
    }
    allY.sort((a, b) => a - b);
    let lo = quantile(allY, 0.02), hi = quantile(allY, 0.98);
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    const padY = (hi - lo) * 0.12;
    xLo = spec.xMin; xHi = spec.xMax; yLo = lo - padY; yHi = hi + padY;
  } else {
    for (const el of spec.elements) collectElement(el, touch);
    for (const el of spec.elements) {
      if (el.kind === 'line') {
        const [x1, y1] = el.from, [x2, y2] = el.to;
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const ext = Math.max(xHi - xLo, yHi - yLo, 4);
        touch(x1 - (dx / len) * ext, y1 - (dy / len) * ext);
        touch(x2 + (dx / len) * ext, y2 + (dy / len) * ext);
      }
    }
    if (!(xHi > xLo)) { xLo -= 1; xHi += 1; }
    if (!(yHi > yLo)) { yLo -= 1; yHi += 1; }
    const padX = (xHi - xLo) * 0.15, padY = (yHi - yLo) * 0.15;
    xLo -= padX; xHi += padX; yLo -= padY; yHi += padY;
  }

  const W = 760, H = 520, ML = 46, MR = 20, MT = spec.title ? 40 : 18, MB = 34;
  const sx = (W - ML - MR) / (xHi - xLo);
  const sy = (H - MT - MB) / (yHi - yLo);
  const scale = Math.min(sx, sy);
  const effW = (xHi - xLo) * scale, effH = (yHi - yLo) * scale;
  const ox = ML + ((W - ML - MR) - effW) / 2;
  const oy = MT + ((H - MT - MB) - effH) / 2;
  const px = (x) => ox + (x - xLo) * scale;
  const py = (y) => H - MB - (y - yLo) * scale;

  // 网格与坐标轴
  const stepX = niceStep(xHi - xLo), stepY = niceStep(yHi - yLo);
  for (let gx = Math.ceil(xLo / stepX) * stepX; gx <= xHi; gx += stepX) {
    cmds.push({ t: 'line', x1: px(gx), y1: py(yLo), x2: px(gx), y2: py(yHi), color: '#232c42', width: 1 });
    cmds.push({ t: 'text', x: px(gx), y: H - MB + 16, text: fmt(gx), size: 11, color: '#8ea0c0', anchor: 'middle' });
  }
  for (let gy = Math.ceil(yLo / stepY) * stepY; gy <= yHi; gy += stepY) {
    cmds.push({ t: 'line', x1: px(xLo), y1: py(gy), x2: px(xHi), y2: py(gy), color: '#232c42', width: 1 });
    cmds.push({ t: 'text', x: ML - 8, y: py(gy) + 4, text: fmt(gy), size: 11, color: '#8ea0c0', anchor: 'end' });
  }
  if (yLo < 0 && yHi > 0) cmds.push({ t: 'line', x1: px(xLo), y1: py(0), x2: px(xHi), y2: py(0), color: '#67748f', width: 1.6 });
  if (xLo < 0 && xHi > 0) cmds.push({ t: 'line', x1: px(0), y1: py(yLo), x2: px(0), y2: py(yHi), color: '#67748f', width: 1.6 });

  if (spec.type === 'function') {
    sampled.forEach(({ curve, pts }) => {
      let seg = [];
      const flush = () => {
        if (seg.length > 1) cmds.push({ t: 'polyline', pts: seg, color: curve.color, width: 2.4 });
        seg = [];
      };
      for (const [x, y] of pts) {
        if (!Number.isFinite(y) || y < yLo - (yHi - yLo) || y > yHi + (yHi - yLo)) { flush(); continue; }
        seg.push([px(x), py(y)]);
      }
      flush();
    });
    spec.curves.forEach((c, i) => {
      cmds.push({ t: 'text', x: W - MR - 6, y: MT + 18 + i * 20, text: c.label, size: 14, color: c.color, anchor: 'end', italic: true });
    });
  } else {
    for (const el of spec.elements) drawElement(el, cmds, px, py, spec);
  }

  if (spec.title) cmds.push({ t: 'text', x: W / 2, y: 22, text: spec.title, size: 17, color: '#e7ecf7', anchor: 'middle' });
  return { cmds, width: W, height: H };
}

function collectElement(el, touch) {
  switch (el.kind) {
    case 'polygon':
    case 'points':
      (el.points || []).forEach(([x, y]) => touch(x, y));
      break;
    case 'segment':
    case 'line':
      touch(el.from?.[0], el.from?.[1]);
      touch(el.to?.[0], el.to?.[1]);
      break;
    case 'circle':
      touch(el.center?.[0] - el.r, el.center?.[1] - el.r);
      touch(el.center?.[0] + el.r, el.center?.[1] + el.r);
      break;
    case 'point':
      touch(el.at?.[0], el.at?.[1]);
      break;
    case 'angle':
    case 'rightAngle':
      touch(el.vertex?.[0], el.vertex?.[1]);
      break;
    case 'text':
      touch(el.at?.[0], el.at?.[1]);
      break;
    default:
      break;
  }
}

function angleOf(from, to) {
  return Math.atan2(to[1] - from[1], to[0] - from[0]);
}

function drawElement(el, cmds, px, py, spec) {
  const color = el.color || COLORS[0];
  switch (el.kind) {
    case 'polygon': {
      const pts = (el.points || []).map(([x, y]) => [px(x), py(y)]);
      if (pts.length >= 3) {
        cmds.push({ t: 'polygon', pts, color, width: 2.2, fill: el.fill ? color + '22' : 'none' });
        (el.labels || []).forEach((lab, i) => {
          if (!lab || !el.points[i]) return;
          const [x, y] = el.points[i];
          const cx = el.points.reduce((a, p) => a + p[0], 0) / el.points.length;
          const cy = el.points.reduce((a, p) => a + p[1], 0) / el.points.length;
          const offX = x === cx ? 0 : (x > cx ? 14 : -14);
          const offY = y === cy ? -14 : (y > cy ? 18 : -10);
          cmds.push({ t: 'text', x: px(x) + offX, y: py(y) + offY, text: lab, size: 15, color: '#e7ecf7', anchor: 'middle', italic: true });
        });
      }
      break;
    }
    case 'segment':
      cmds.push({ t: 'line', x1: px(el.from[0]), y1: py(el.from[1]), x2: px(el.to[0]), y2: py(el.to[1]), color, width: 2.2, dash: el.dash });
      if (el.label) midpointLabel(el.from, el.to, el.label, cmds, px, py);
      break;
    case 'line': {
      const [x1, y1] = el.from, [x2, y2] = el.to;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ext = 100;
      cmds.push({
        t: 'line',
        x1: px(x1 - (dx / len) * ext), y1: py(y1 - (dy / len) * ext),
        x2: px(x2 + (dx / len) * ext), y2: py(y2 + (dy / len) * ext),
        color, width: 2, dash: el.dash
      });
      break;
    }
    case 'circle': {
      const [cx, cy] = el.center;
      const rPx = Math.abs(px(cx + el.r) - px(cx));
      cmds.push({ t: 'circle', cx: px(cx), cy: py(cy), r: rPx, color, width: 2.2, fill: el.fill ? color + '22' : 'none' });
      if (el.label) cmds.push({ t: 'text', x: px(cx) + 6, y: py(cy) - 6, text: el.label, size: 15, color: '#e7ecf7', anchor: 'start', italic: true });
      break;
    }
    case 'point': {
      cmds.push({ t: 'dot', cx: px(el.at[0]), cy: py(el.at[1]), color });
      if (el.label) cmds.push({ t: 'text', x: px(el.at[0]) + 8, y: py(el.at[1]) - 8, text: el.label, size: 15, color: '#e7ecf7', anchor: 'start', italic: true });
      break;
    }
    case 'angle': {
      const v = el.vertex;
      const a1 = angleOf(v, el.p1), a2 = angleOf(v, el.p2);
      const r = el.radius || 0.6;
      const rPx = Math.abs(px(v[0] + r) - px(v[0]));
      cmds.push({ t: 'arc', cx: px(v[0]), cy: py(v[1]), r: rPx, from: -a1, to: -a2, color: el.color || '#f0a938', width: 1.8 });
      if (el.label) {
        const mid = (a1 + a2) / 2;
        cmds.push({ t: 'text', x: px(v[0] + Math.cos(mid) * (r + 0.5)), y: py(v[1] + Math.sin(mid) * (r + 0.5)), text: el.label, size: 13, color: '#e7ecf7', anchor: 'middle', italic: true });
      }
      break;
    }
    case 'rightAngle': {
      const v = el.vertex;
      const s = el.size || 0.4;
      const u = unit(el.p1, v), w = unit(el.p2, v);
      const p1 = [v[0] + u[0] * s, v[1] + u[1] * s];
      const p2 = [v[0] + u[0] * s + w[0] * s, v[1] + u[1] * s + w[1] * s];
      const p3 = [v[0] + w[0] * s, v[1] + w[1] * s];
      cmds.push({ t: 'polyline', pts: [[px(p1[0]), py(p1[1])], [px(p2[0]), py(p2[1])], [px(p3[0]), py(p3[1])]], color: el.color || '#f0a938', width: 1.8 });
      break;
    }
    case 'text':
      cmds.push({ t: 'text', x: px(el.at[0]), y: py(el.at[1]), text: el.text || '', size: el.size || 14, color: el.color || '#e7ecf7', anchor: el.anchor || 'middle', italic: true });
      break;
    default:
      break;
  }
}

function unit(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

function midpointLabel(a, b, label, cmds, px, py) {
  cmds.push({ t: 'text', x: (px(a[0]) + px(b[0])) / 2, y: (py(a[1]) + py(b[1])) / 2 - 8, text: label, size: 14, color: '#e7ecf7', anchor: 'middle', italic: true });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sceneToSVG(scene, { background = '#0e1320' } = {}) {
  const { cmds, width, height } = scene;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_MATH}">`];
  parts.push(`<rect width="${width}" height="${height}" fill="${background}"/>`);
  for (const c of cmds) {
    switch (c.t) {
      case 'line':
        parts.push(`<line x1="${r2(c.x1)}" y1="${r2(c.y1)}" x2="${r2(c.x2)}" y2="${r2(c.y2)}" stroke="${c.color}" stroke-width="${c.width}"${c.dash ? ` stroke-dasharray="6 5"` : ''}/>`);
        break;
      case 'polyline':
        parts.push(`<polyline points="${c.pts.map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ')}" fill="none" stroke="${c.color}" stroke-width="${c.width}" stroke-linejoin="round"/>`);
        break;
      case 'polygon':
        parts.push(`<polygon points="${c.pts.map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ')}" fill="${c.fill === 'none' ? 'none' : c.fill}" stroke="${c.color}" stroke-width="${c.width}" stroke-linejoin="round"/>`);
        break;
      case 'circle':
        parts.push(`<circle cx="${r2(c.cx)}" cy="${r2(c.cy)}" r="${r2(c.r)}" fill="${c.fill === 'none' ? 'none' : c.fill}" stroke="${c.color}" stroke-width="${c.width}"/>`);
        break;
      case 'dot':
        parts.push(`<circle cx="${r2(c.cx)}" cy="${r2(c.cy)}" r="3.4" fill="${c.color}"/>`);
        break;
      case 'arc': {
        const large = Math.abs(c.to - c.from) > Math.PI ? 1 : 0;
        const x1 = c.cx + c.r * Math.cos(c.from), y1 = c.cy + c.r * Math.sin(c.from);
        const x2 = c.cx + c.r * Math.cos(c.to), y2 = c.cy + c.r * Math.sin(c.to);
        const sweep = c.to > c.from ? 1 : 0;
        parts.push(`<path d="M ${r2(x1)} ${r2(y1)} A ${r2(c.r)} ${r2(c.r)} 0 ${large} ${sweep} ${r2(x2)} ${r2(y2)}" fill="none" stroke="${c.color}" stroke-width="${c.width}"/>`);
        break;
      }
      case 'text':
        parts.push(`<text x="${r2(c.x)}" y="${r2(c.y)}" font-size="${c.size}" fill="${c.color}" text-anchor="${c.anchor || 'middle'}"${c.italic ? ' font-style="italic"' : ''}>${esc(c.text)}</text>`);
        break;
      default:
        break;
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

export function sceneToPNG(scene, { background = '#0e1320', scale = 2 } = {}) {
  const { cmds, width, height } = scene;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  for (const c of cmds) {
    switch (c.t) {
      case 'line':
        ctx.strokeStyle = c.color;
        ctx.lineWidth = c.width;
        ctx.setLineDash(c.dash ? [6, 5] : []);
        ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke();
        ctx.setLineDash([]);
        break;
      case 'polyline':
        ctx.strokeStyle = c.color;
        ctx.lineWidth = c.width;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        c.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
        break;
      case 'polygon':
        ctx.strokeStyle = c.color;
        ctx.lineWidth = c.width;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        c.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
        if (c.fill !== 'none') { ctx.fillStyle = c.fill; ctx.fill(); }
        ctx.stroke();
        break;
      case 'circle':
        ctx.strokeStyle = c.color;
        ctx.lineWidth = c.width;
        ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
        if (c.fill !== 'none') { ctx.fillStyle = c.fill; ctx.fill(); }
        ctx.stroke();
        break;
      case 'dot':
        ctx.fillStyle = c.color;
        ctx.beginPath(); ctx.arc(c.cx, c.cy, 3.4, 0, Math.PI * 2); ctx.fill();
        break;
      case 'arc': {
        ctx.strokeStyle = c.color;
        ctx.lineWidth = c.width;
        ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r, c.from, c.to, c.to < c.from); ctx.stroke();
        break;
      }
      case 'text':
        ctx.fillStyle = c.color;
        ctx.font = `${c.italic ? 'italic ' : ''}${c.size}px ${FONT_MATH}`;
        ctx.textAlign = c.anchor === 'end' ? 'right' : c.anchor === 'start' ? 'left' : 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(c.text, c.x, c.y - c.size / 3);
        break;
      default:
        break;
    }
  }
  return canvas.toBuffer('image/png');
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

export function renderFigure(spec, format = 'svg') {
  const scene = buildScene(spec);
  if (format === 'png') {
    return { png: sceneToPNG(scene), width: scene.width, height: scene.height };
  }
  return { svg: sceneToSVG(scene), width: scene.width, height: scene.height };
}

export const FIGURE_TOOL_DOC = `当用户需要函数图像或几何图形时，你可以绘图：在回答中输出 \`\`\`figure 代码块，内容为 JSON。你只提供数据，系统会精确绘制并自动渲染（禁止用字符画或HTML模拟）。
格式一（函数图像）：{"type":"function","expr":"sin(x)*x","xMin":-6.28,"xMax":6.28,"title":"y = x·sin(x)"}；多条曲线用 "curves":[{"expr":"x^2"},{"expr":"2x+1"}]。表达式支持 + - * / ^ sqrt() sin() cos() tan() log() abs() e pi。
格式二（几何图形）：{"type":"geometry","title":"...","elements":[
 {"kind":"polygon","points":[[0,0],[4,0],[4,3]],"labels":["A","B","C"],"fill":true},
 {"kind":"circle","center":[1,2],"r":2,"label":"O"},
 {"kind":"segment","from":[0,0],"to":[4,3],"label":"a","dash":false},
 {"kind":"line","from":[0,0],"to":[1,1]},
 {"kind":"point","at":[2,1],"label":"P"},
 {"kind":"angle","vertex":[0,0],"p1":[4,0],"p2":[4,3],"label":"θ"},
 {"kind":"rightAngle","vertex":[4,0],"p1":[0,0],"p2":[4,3]},
 {"kind":"text","at":[1,1],"text":"说明文字"}]}
坐标使用数学坐标系（y 向上）。图形必须准确反映题目数值。`;
