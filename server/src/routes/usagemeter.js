import { Router } from 'express';
import { setEnv } from '../config.js';
import { meterStats, grantAdd, grantReset } from '../services/meter.js';

export const usagemeterRouter = Router();

// Token 计量状态：总量 / 今日 / 周期 / 趋势 / 性能 / 限额 / 临时增加
usagemeterRouter.get('/status', (req, res) => {
  res.json(meterStats());
});

// 更新计量配置（开关 / 周期 / 限额数值与单位 / 趋势窗口）
usagemeterRouter.post('/config', (req, res) => {
  const { enabled, period, value, unit, windowDays } = req.body || {};
  const updates = {};
  if (enabled === true || enabled === 'on') updates.METERCALC_ENABLED = 'on';
  else if (enabled === false || enabled === 'off') updates.METERCALC_ENABLED = 'off';
  if (period === 'month' || period === 'week') updates.METERCALC_PERIOD = period;
  if (value !== undefined && Number.isFinite(Number(value))) updates.METERCALC_VALUE = String(Math.max(0, Number(value)));
  if (['M', 'B', 'T'].includes(unit)) updates.METERCALC_UNIT = unit;
  if (windowDays !== undefined && Number.isFinite(Number(windowDays))) {
    updates.METERCALC_WINDOW = String(Math.max(1, Math.min(365, Math.floor(Number(windowDays)))));
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: '没有可保存的计量配置' });
  setEnv(updates);
  res.json({ ok: true, ...meterStats() });
});

// 临时增加额度（不设限额时提高可用量可使用）
usagemeterRouter.post('/grant', (req, res) => {
  const { value, unit } = req.body || {};
  try {
    const grantTokens = grantAdd(value, unit);
    res.json({ ok: true, grantTokens });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 临时重置（取消所有临时增加额度）
usagemeterRouter.post('/reset', (req, res) => {
  res.json({ ok: true, grantTokens: grantReset() });
});
