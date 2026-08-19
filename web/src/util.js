import katex from 'katex';
import 'katex/contrib/mhchem';

const KATEX_OPTS = { throwOnError: false, displayMode: false, strict: false };

export function renderMath(text) {
  try {
    return katex.renderToString(String(text), { ...KATEX_OPTS, displayMode: String(text).length > 30 });
  } catch {
    return escapeHtml(String(text));
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderMarkdown(text) {
  const src = String(text || '');
  const formulas = [];
  const stashMath = (f, display) => { formulas.push({ f, display }); return `\u0000F${formulas.length - 1}\u0000`; };

  const inline = (raw) => {
    let s = String(raw || '')
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => stashMath(f.trim(), true))
      .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (m, pre, f) => pre + stashMath(f.trim(), false));
    s = escapeHtml(s);
    s = s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]\n]+)\]\(([^\)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[(\d+)\]/g, '<sup class="cite">[$1]</sup>');
    return s;
  };

  // 1) 先把围栏代码块(含语言标签, 如 ```bash)整体提取为占位符, 使其不参与逐行解析
  const codeBlocks = [];
  const src2 = src.replace(/(^|\n)```[^\n]*\n?([\s\S]*?)\n?```[ \t]*(?=\n|$)/g, (m, preB, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code.replace(/\s+$/, ''));
    return preB + `\u0000C${idx}\u0000`;
  });

  const out = [];
  const listStack = [];            // {type:'ul'|'ol', depth}
  const flushLists = (depth = 0) => {
    while (listStack.length > depth) out.push('</' + listStack.pop().type + '>');
  };
  const pushOpen = (type, depth) => {
    const top = listStack[listStack.length - 1];
    if (top && top.type === type && top.depth === depth) return;
    flushLists(depth);
    listStack.push({ type, depth });
    out.push('<' + type + '>');
  };

  let tableBuf = [];
  let tableSep = false;
  const emitTable = () => {
    if (!tableBuf.length) return;
    let h = '<table><tbody>';
    if (tableSep) {
      const [head, ...body] = tableBuf;
      h = '<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
      body.forEach((r) => { h += '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>'; });
    } else {
      tableBuf.forEach((r) => { h += '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>'; });
    }
    out.push(h + '</tbody></table>');
    tableBuf = [];
    tableSep = false;
  };
  const isTableRow = (line) => line.trim().startsWith('|') || line.includes('|');
  const isTblSep = (line) => /^\s*\|?[\s:|\-]+\|?\s*$/.test(line) && line.includes('-') && !/[A-Za-z0-9\u4e00-\u9fa5]/.test(line);

  let quoteBuf = [];
  const emitQuote = () => {
    if (quoteBuf.length) { out.push('<blockquote>' + quoteBuf.map((q) => inline(q)).join('<br>') + '</blockquote>'); quoteBuf = []; }
  };

  for (const raw of src2.split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) { emitQuote(); flushLists(); emitTable(); out.push(''); continue; }

    // 代码块占位行
    const cbm = /^(\u0000C\d+\u0000)+$/.exec(trimmed);
    if (cbm) {
      emitQuote(); flushLists(); emitTable();
      const idx = Math.min(outputCodeIdx(trimmed, codeBlocks.length), codeBlocks.length - 1);
      out.push(`<pre class="md-code">${escapeHtml(codeBlocks[idx])}</pre>`);
      continue;
    }

    // 表格段
    if (isTableRow(line)) {
      emitQuote(); flushLists();
      if (isTblSep(line)) { tableSep = true; continue; }
      const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      tableBuf = tableBuf.length ? tableBuf.concat([cells]) : [cells];
      continue;
    } else if (tableBuf.length) { emitTable(); }

    // 引用
    if (trimmed.startsWith('>')) { emitTable(); flushLists(); quoteBuf.push(trimmed.replace(/^>\s?/, '')); continue; }
    else if (quoteBuf.length) { emitQuote(); }

    const h = /^(#{1,6})\s+(.*)/.exec(trimmed);
    if (h) { flushLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^([-_*])\1{2,}\s*$/.test(trimmed) && !/[A-Za-z0-9\u4e00-\u9fa5]/.test(trimmed)) { flushLists(); out.push('<hr/>'); continue; }

    const indent = Math.min(3, Math.floor((line.match(/^\s*/)[0].length) / 2));
    const ul = /^\s*[-*+]\s+(.*)/.exec(line);
    const ol = /^\s*(\d+)[.、)]\s+(.*)/.exec(line);
    if (ul) { emitQuote(); emitTable(); pushOpen('ul', indent); out.push(`<li>${inline(ul[1])}</li>`); continue; }
    if (ol) { emitQuote(); emitTable(); pushOpen('ol', indent); out.push(`<li>${inline(ol[2])}</li>`); continue; }

    flushLists(); emitTable(); emitQuote();
    out.push(`<p>${inline(trimmed)}</p>`);
  }
  emitQuote(); flushLists(); emitTable();

  let html = out.join('\n');
  html = html.replace(/\u0000F(\d+)\u0000/g, (_, i) => {
    const { f, display } = formulas[Number(i)];
    try { return katex.renderToString(f, { ...KATEX_OPTS, displayMode: display }); } catch { return `<code>${escapeHtml(f)}</code>`; }
  });
  return html;
}

function outputCodeIdx(token, len) {
  const m = /\u0000C(\d+)\u0000/.exec(token);
  return m ? Number(m[1]) : 0;
}


function inline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, '<sup class="cite">[$1]</sup>');
}

export const STATUS_TEXT = {
  pending: '待分析',
  analyzing: '分析中',
  done: '已完成',
  failed: '失败',
  queued: '排队中',
  running: '运行中'
};

export const CAUSE_COLORS = {
  知识盲区: '#ef5f6b',
  逻辑错误: '#f0a938',
  概念混淆: '#9d6bff',
  粗心: '#3fc1e0',
  方法错误: '#ff8fb1',
  其他: '#7e8cb0',
  未标注: '#7e8cb0'
};

const PALETTE = ['#4f8cff', '#27c8a0', '#f0a938', '#ef5f6b', '#9d6bff', '#3fc1e0', '#ff8fb1', '#a3d977'];

export function causeColor(c) {
  if (CAUSE_COLORS[c]) return CAUSE_COLORS[c];
  let h = 0;
  for (const ch of String(c || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function masteryLevel(v) {
  if (v == null) return 'none';
  if (v >= 80) return 'high';
  if (v >= 60) return 'mid';
  return 'low';
}

export function fmtTime(s) {
  if (!s) return '-';
  return String(s).includes('T') ? new Date(s).toLocaleString() : s.replace('T', ' ');
}

/* 日期/时间字符串 ↔ 本地 Date / {hour, minute} 对象（供 WinUI 日期时间选择控件使用，避免 UTC 时区偏移） */
export function parseLocalDate(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(str));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

export function fmtDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseTimeStr(str) {
  if (!str) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(str));
  if (!m) return null;
  return { hour: Math.min(23, Math.max(0, +m[1])), minute: Math.min(59, Math.max(0, +m[2])) };
}

export function fmtTimeHM(t) {
  if (!t) return '';
  const h = Math.min(23, Math.max(0, Number(t.hour) || 0));
  const m = Math.min(59, Math.max(0, Number(t.minute) || 0));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
