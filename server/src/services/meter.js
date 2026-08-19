import { db } from '../db.js';
import { getEnv, setEnv } from '../config.js';

// Token 用量计量：记录每笔 AI 调用的 token 消耗与耗时，供设置页弹窗查看趋势/总量/性能/限额。
// 开关关闭时不记录、不拦截；开启时按周期限额拦截超额调用。

export const METER_UNITS = { M: 1e6, B: 1e9, T: 1e12 };

export function meterEnabled() {
  return getEnv('METERCALC_ENABLED', 'off').toLowerCase() === 'on';
}

export function meterConfig() {
  return {
    enabled: meterEnabled(),
    period: getEnv('METERCALC_PERIOD', 'month'), // month | week
    value: Math.max(0, Number(getEnv('METERCALC_VALUE', '0')) || 0), // 限额数值
    unit: ['M', 'B', 'T'].includes(getEnv('METERCALC_UNIT', 'M')) ? getEnv('METERCALC_UNIT', 'M') : 'M',
    windowDays: Math.max(1, Math.min(365, Number(getEnv('METERCALC_WINDOW', '30')) || 30)),
    grantTokens: Math.max(0, Number(getEnv('METERCALC_GRANT', '0')) || 0) // 临时增加的额度（tokens）
  };
}

function limitTokens() {
  const c = meterConfig();
  return Math.round(c.value * (METER_UNITS[c.unit] || 1e6));
}

// 当前周期（month=自然月，week=近 7 天）累计消耗 tokens
function cycleTotal(period) {
  const startSql = period === 'week'
    ? "datetime('now', '-6 days')"
    : "datetime('now', 'start of month')";
  const row = db.prepare(
    `SELECT COALESCE(SUM(in_tokens + out_tokens), 0) AS t FROM token_usage WHERE ts >= ${startSql}`
  ).get();
  return Number(row?.t || 0);
}

// 记录一笔用量。scope: chat | vision | embed
export function recordUsage(scope, model, inTokens, outTokens, ms, real = false) {
  if (!meterEnabled()) return;
  try {
    db.prepare(
      'INSERT INTO token_usage (scope, model, in_tokens, out_tokens, ms, estimate) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(scope, String(model || '-').slice(0, 40) || '-', inTokens || 0, outTokens || 0, ms || 0, real ? 0 : 1);
  } catch {
    /* 计量失败不影响 AI 主流程 */
  }
}

// 限额拦截：开启且设置了限额且累计超过（限额 + 临时增加）时抛错，阻止 AI 调用
export function assertQuota() {
  const c = meterConfig();
  if (!c.enabled || c.value <= 0) return;
  const total = cycleTotal(c.period);
  if (total >= limitTokens() + c.grantTokens) {
    throw new Error(`AI 用量已达本${c.period === 'week' ? '周' : '月'}限额（${c.value}${c.unit}）${c.grantTokens ? `，已含临时增加 ${c.grantTokens} token` : ''}，请在设置中临时增加或重置后重试`);
  }
}

// 临时增加额度（value 数量 + 单位），累计入 grantTokens（tokens）
export function grantAdd(value, unit) {
  const c = meterConfig();
  const add = Math.round(Number(value) * (METER_UNITS[unit] || 1e6));
  if (!Number.isFinite(add) || add <= 0) throw new Error('临时增加额度无效');
  setEnv({ METERCALC_GRANT: String(c.grantTokens + add) });
  return c.grantTokens + add;
}

export function grantReset() {
  setEnv({ METERCALC_GRANT: '0' });
  return 0;
}

export function meterStats() {
  const c = meterConfig();
  const one = (sql, ...args) => {
    const r = db.prepare(sql).get(...args);
    return r;
  };
  const allTot = Number(one('SELECT COALESCE(SUM(in_tokens + out_tokens),0) t FROM token_usage')?.t || 0);
  const today = Number(one("SELECT COALESCE(SUM(in_tokens + out_tokens),0) t FROM token_usage WHERE date(ts)=date('now')")?.t || 0);
  const cycle = cycleTotal(c.period);
  const trendRows = db.prepare(
    `SELECT date(ts) d, COALESCE(SUM(in_tokens + out_tokens),0) t FROM token_usage
     WHERE date(ts) >= date('now', ?) GROUP BY date(ts) ORDER BY date(ts)`
  ).all(`-${c.windowDays - 1} days`);
  const perf = one('SELECT COUNT(*) c, ROUND(AVG(ms),1) avgMs, ROUND(COALESCE(SUM(ms),0),0) totalMs FROM token_usage');
  const byScopeRows = db.prepare('SELECT scope, COALESCE(SUM(in_tokens + out_tokens),0) t FROM token_usage GROUP BY scope').all();
  const byScope = {};
  for (const r of byScopeRows) byScope[r.scope] = Number(r.t || 0);
  return {
    enabled: c.enabled,
    config: {
      period: c.period,
      value: c.value,
      unit: c.unit,
      windowDays: c.windowDays,
      limitTokens: limitTokens()
    },
    grantTokens: c.grantTokens,
    totals: { all: allTot, today, cycle, cycleShare: limitTokens() > 0 ? Math.round((cycle / (limitTokens() + c.grantTokens)) * 1000) / 10 : null },
    trend: trendRows.map((r) => ({ date: r.d, total: Number(r.t || 0) })),
    perf: { calls: Number(perf?.c || 0), avgMs: Number(perf?.avgMs || 0), totalMs: Number(perf?.totalMs || 0), byScope }
  };
}
