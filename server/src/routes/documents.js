import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType } from 'docx';
import { db } from '../db.js';
import { DOCUMENT_DIR, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { renderFigure } from '../services/figures.js';

export const documentsRouter = Router();

const HEADING = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };

async function buildDocx({ name, blocks, source = '用户/AI 生成' }) {
  const children = [
    new Paragraph({
      children: [new TextRun({ text: name, bold: true, size: 40 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 }
    }),
    new Paragraph({
      children: [new TextRun({ text: `生成时间：${new Date().toLocaleString()} · ${source}`, color: '888888', size: 18 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    })
  ];
  for (const block of blocks || []) {
    if (block.type === 'heading') {
      children.push(new Paragraph({ text: String(block.text || ''), heading: HEADING[block.level] || HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }));
    } else if (block.type === 'text') {
      for (const line of String(block.text || '').split(/\n+/)) {
        if (!line.trim()) continue;
        children.push(new Paragraph({ children: [new TextRun({ text: line, size: 24 })], spacing: { after: 120 } }));
      }
    } else if (block.type === 'figure') {
      const { png } = renderFigure(block.spec, 'png');
      children.push(
        new Paragraph({
          children: [new ImageRun({ data: png, transformation: { width: 560, height: Math.round((560 * 520) / 760) }, type: 'png' })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 60 }
        })
      );
      if (block.caption) {
        children.push(new Paragraph({
          children: [new TextRun({ text: String(block.caption), italics: true, color: '666666', size: 20 })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 240 }
        }));
      }
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function generateDocument({ name, blocks, source }) {
  const cleanName = String(name || '未命名文档').trim().slice(0, 60);
  const buf = await buildDocx({ name: cleanName, blocks, source });
  const info = db.prepare('INSERT INTO documents (name, file_path, meta) VALUES (?, ?, ?)')
    .run(cleanName, '', JSON.stringify({ blocks: blocks?.length || 0, source }));
  const id = Number(info.lastInsertRowid);
  const fileName = `${id}-${cleanName.replace(/[\\/:*?"<>|]/g, '_')}.docx`;
  const filePath = path.join(DOCUMENT_DIR, fileName);
  fs.writeFileSync(filePath, buf);
  db.prepare('UPDATE documents SET file_path = ? WHERE id = ?').run(`documents/${fileName}`, id);
  logger.info(`Word 文档生成: #${id} ${fileName}`);
  return { id, fileName, downloadUrl: `/api/documents/${id}/download` };
}

documentsRouter.post('/generate', async (req, res, next) => {
  try {
    const { name, blocks } = req.body || {};
    if (!Array.isArray(blocks) || !blocks.length) return res.status(400).json({ error: 'blocks 不能为空' });
    res.status(201).json(await generateDocument({ name, blocks, source: 'web 生成' }));
  } catch (e) {
    next(e);
  }
});

documentsRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM documents ORDER BY id DESC LIMIT 100').all();
  res.json({
    items: rows.map((r) => ({ ...r, downloadUrl: `/api/documents/${r.id}/download`, meta: tryJSON(r.meta) }))
  });
});

documentsRouter.get('/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '文档不存在' });
  const fullPath = path.join(DATA_DIR, row.file_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '文件缺失' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.name)}.docx"`);
  res.end(fs.readFileSync(fullPath));
});

documentsRouter.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '文档不存在' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
  fs.rmSync(path.join(DATA_DIR, row.file_path), { force: true });
  res.json({ ok: true });
});

function tryJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
