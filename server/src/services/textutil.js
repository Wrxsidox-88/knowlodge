export function splitChunks(text, { maxLen = 400, minLen = 40 } = {}) {
  const blocks = String(text)
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks = [];
  let buf = '';
  const flush = () => {
    if (buf.trim().length >= minLen) chunks.push(buf.trim());
    else if (buf.trim() && chunks.length === 0) chunks.push(buf.trim());
    buf = '';
  };
  for (const block of blocks) {
    if (block.length > maxLen) {
      flush();
      for (let i = 0; i < block.length; i += maxLen) {
        chunks.push(block.slice(i, i + maxLen));
      }
    } else if (buf.length + block.length + 1 > maxLen) {
      flush();
      buf = block;
    } else {
      buf = buf ? `${buf}\n${block}` : block;
    }
  }
  flush();
  return chunks;
}

const STOPWORDS = new Set([
  '我们', '你们', '他们', '它们', '这个', '那个', '一个', '可以', '如果', '因为', '所以',
  '但是', '然后', '没有', '不是', '就是', '以及', '或者', '对于', '关于', '通过', '进行',
  '需要', '应该', '可能', '已经', '一种', '如下', '例如', '其中', '并且', '还是', '虽然',
  'the', 'a', 'an', 'is', 'are', 'of', 'to', 'and', 'or', 'in', 'on', 'for', 'with'
]);

export function extractKeywords(text, topN = 12) {
  const counts = new Map();
  const runs = String(text).match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of runs) {
    const maxLen = Math.min(6, run.length);
    for (let len = 2; len <= maxLen; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const w = run.slice(i, i + len);
        if (STOPWORDS.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
  }
  const en = String(text).match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || [];
  for (const w of en) {
    if (STOPWORDS.has(w.toLowerCase())) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const candidates = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length);
  const kept = [];
  for (const [w, c] of candidates) {
    if (kept.some((k) => k.word.includes(w))) continue;
    kept.push({ word: w, count: c });
    if (kept.length >= topN * 2) break;
  }
  return kept
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((k) => k.word);
}

export function tokenizeQuery(query) {
  const tokens = new Set();
  const cleaned = String(query).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ');
  for (const part of cleaned.split(/\s+/).filter(Boolean)) {
    tokens.add(part);
    const runs = part.match(/[\u4e00-\u9fa5]{3,}/g) || [];
    for (const run of runs) {
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i + len <= run.length; i += 2) {
          tokens.add(run.slice(i, i + len));
        }
      }
    }
  }
  return [...tokens].slice(0, 16);
}

export function sentencesOf(text) {
  return String(text)
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}
