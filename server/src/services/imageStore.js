import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_DIR } from '../config.js';
import { db } from '../db.js';

export function storeMaterialImages(materialId, images) {
  if (!images?.length) return 0;
  const dir = path.join(IMAGE_DIR, `m${materialId}`);
  fs.mkdirSync(dir, { recursive: true });
  const insert = db.prepare(
    'INSERT INTO material_images (material_id, file_path, content_type, placeholder, note) VALUES (?, ?, ?, ?, ?)'
  );
  images.forEach((img, i) => {
    const fileName = `${i + 1}${img.ext || '.png'}`;
    fs.writeFileSync(path.join(dir, fileName), img.buffer);
    insert.run(
      materialId,
      `images/m${materialId}/${fileName}`,
      img.contentType || 'image/png',
      img.placeholder || `[图片${i + 1}]`,
      img.note || null
    );
  });
  return images.length;
}

export function listMaterialImageRows(materialId) {
  return db.prepare('SELECT * FROM material_images WHERE material_id = ? ORDER BY id').all(materialId);
}
