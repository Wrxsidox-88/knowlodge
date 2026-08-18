import { Router } from 'express';
import { renderFigure } from '../services/figures.js';

export const figuresRouter = Router();

figuresRouter.post('/render', (req, res, next) => {
  try {
    const { spec, format } = req.body || {};
    const out = renderFigure(spec, format === 'png' ? 'png' : 'svg');
    if (format === 'png') {
      return res.json({ png: out.png.toString('base64'), width: out.width, height: out.height });
    }
    res.json({ svg: out.svg, width: out.width, height: out.height });
  } catch (e) {
    next(e);
  }
});

figuresRouter.post('/png', (req, res, next) => {
  try {
    const { png } = renderFigure(req.body?.spec, 'png');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="figure.png"');
    res.end(png);
  } catch (e) {
    next(e);
  }
});
