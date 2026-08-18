import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export const TEXT_EXTS = ['.txt', '.md', '.markdown', '.csv', '.json'];
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

const IMAGE_CONTENT_TYPE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

export function detectKind(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return null;
}

export async function parseFile(filePath, fileName) {
  const kind = detectKind(fileName);
  if (!kind) throw Object.assign(new Error(`不支持的文件类型: ${fileName}`), { status: 400 });
  switch (kind) {
    case 'docx':
      return parseDocx(filePath);
    case 'pdf':
      return parsePdf(filePath);
    case 'image':
      return parseImage(filePath);
    default: {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.trim()) throw Object.assign(new Error('文件内容为空'), { status: 400 });
      return { content, images: [] };
    }
  }
}

function parseImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  const base = path.basename(filePath, ext);
  return {
    content: `[图片1]`,
    images: [
      {
        buffer,
        ext,
        contentType: IMAGE_CONTENT_TYPE[ext] || 'application/octet-stream',
        placeholder: '[图片1]',
        note: `整份材料即图片文件 ${base}${ext}`
      }
    ]
  };
}

async function parseDocx(filePath) {
  const buffer = fs.readFileSync(filePath);
  const images = [];
  const result = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.imgElement((image) =>
      image.read('base64').then((b64) => {
        const ext = extFromContentType(image.contentType);
        images.push({
          buffer: Buffer.from(b64, 'base64'),
          ext,
          contentType: image.contentType || IMAGE_CONTENT_TYPE[ext] || 'image/png',
          placeholder: `[图片${images.length + 1}]`
        });
        return { src: `@@IMG${images.length - 1}@@` };
      })
    )
  });
  const content = htmlToText(result.value);
  if (!content.trim() && !images.length) {
    throw Object.assign(new Error('docx 内容为空'), { status: 400 });
  }
  return { content, images };
}

async function parsePdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText();
    let content = String(textResult.text || '').trim();

    const images = [];
    try {
      const imgResult = await parser.getImage({ imageThreshold: 50 });
      for (const page of imgResult.pages || []) {
        for (const img of page.images || []) {
          if (!img.data || img.data.length === 0) continue;
          images.push({
            buffer: Buffer.from(img.data),
            ext: '.png',
            contentType: 'image/png',
            placeholder: `[图片${images.length + 1}]`,
            note: `来自 PDF 第 ${page.pageNumber} 页的内嵌图像（${img.width}x${img.height}）`
          });
        }
      }
    } catch (e) {
      /* 内嵌图像提取失败不影响文本解析 */
    }

    if (content.replace(/\s/g, '').length < 20 && images.length === 0) {
      try {
        const shot = await parser.getScreenshot({ first: 6, scale: 1.3, imageDataUrl: false });
        for (const page of shot.pages || []) {
          if (!page.data || page.data.length === 0) continue;
          images.push({
            buffer: Buffer.from(page.data),
            ext: '.png',
            contentType: 'image/png',
            placeholder: `[图片${images.length + 1}]`,
            note: `PDF 第 ${page.pageNumber} 页整页渲染（疑似扫描件，请结合视觉模型分析页面内容）`
          });
        }
      } catch {
        /* 渲染失败则按空内容处理 */
      }
    }

    if (images.length) {
      const appendix = images.map((img) => img.placeholder).join(' ');
      content = content ? `${content}\n\n${appendix}` : appendix;
    }
    if (!content.trim()) {
      throw Object.assign(new Error('PDF 未提取到文本，也未提取到图像'), { status: 400 });
    }
    return { content, images };
  } finally {
    try {
      await parser.destroy();
    } catch {
      /* 忽略销毁异常 */
    }
  }
}

function extFromContentType(contentType) {
  switch (contentType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/bmp':
      return '.bmp';
    default:
      return '.png';
  }
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<img[^>]*src="@@IMG(\d+)@@"[^>]*\/?>/g, (_, n) => `[图片${Number(n) + 1}]`);
  s = s.replace(/<\/(table|ul|ol|blockquote)>/gi, '\n');
  s = s.replace(/<\/(p|h[1-6]|li|tr)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<\/(td|th)>/gi, ' | ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
