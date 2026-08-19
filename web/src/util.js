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
  let s = String(text || '');

  const formulas = [];
  const stash = (f, display) => {
    formulas.push({ f, display });
    return `\u0000F${formulas.length - 1}\u0000`;
  };
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => stash(f.trim(), true));
  s = s.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (m, pre, f) => pre + stash(f.trim(), false));

  s = escapeHtml(s);
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="md-code">${code.trim()}</pre>`);

  const lines = s.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) out.push('</ul>');
    if (inOl) out.push('</ol>');
    inUl = inOl = false;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      closeLists();
      out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    if (ul) {
      if (!inUl) {
        closeLists();
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*(\d+)[.、)]\s+(.*)/);
    if (ol) {
      if (!inOl) {
        closeLists();
        out.push('<ol>');
        inOl = true;
      }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    closeLists();
    if (!line.trim()) {
      out.push('');
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeLists();
  let html = out.join('\n');

  html = html.replace(/\u0000F(\d+)\u0000/g, (_, i) => {
    const { f, display } = formulas[Number(i)];
    try {
      return katex.renderToString(f, { ...KATEX_OPTS, displayMode: display });
    } catch {
      return `<code>${f}</code>`;
    }
  });
  return html;
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
