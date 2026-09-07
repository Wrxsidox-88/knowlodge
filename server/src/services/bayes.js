/**
 * 贝叶斯学习状态估计核心（v1.7.0）
 * ============================================================
 * 单用户系统的最大敌人是数据稀疏——深度模型需要海量做题数据，
 * 这里采用两条经典概率模型链路，配合知识图谱传播：
 *
 * 1) BKT 贝叶斯知识追踪（Corbett & Anderson, 1995）
 *    维护每个知识点的掌握后验 P(known|证据流)，按贝叶斯法则吸收
 *    每次"答对/答错/复习回忆"证据。参数为信息先验（单用户少量证据
 *    下先验承担主要正则作用，避免过拟合）。
 *
 * 2) 记忆稳定性模型（贝叶斯半衰期回归的离散化）
 *    维护记忆稳定性 θ（天），回忆概率 P(recall, t) = exp(-t / θ)。
 *    成功回忆 → 观测"t 天后仍记得"提升 θ（越接近遗忘边界增益越大，
 *    即"合意困难"）；遗忘/答错 → θ 按遗忘因子收缩。
 *    复习调度：预测回忆概率降到 P_TARGET 时安排下一次复习，
 *    间隔 t* = θ · ln(1/P_TARGET)，随个体表现自适应伸缩，
 *    取代固定艾宾浩斯间隔 [1,2,4,7,15,30]。
 *
 * 全部为纯函数：不依赖 db / 网络，可独立单测。
 */

export const BKT = {
  L0: 0.15,   // 初始掌握先验 P(known) —— 单个新知识点默认未掌握
  T: 0.12,    // 学习传递 P(learn)：一次有效学习机会后从未掌握 → 掌握
  G: 0.18,    // 猜对概率 P(guess)：未掌握却答对
  S: 0.08     // 失误概率 P(slip)：已掌握却答错
};

export const MEMORY = {
  THETA0: 1.5,        // 初始记忆稳定性（天）
  THETA_MIN: 0.4,     // 稳定性下限
  THETA_MAX: 365,     // 稳定性上限
  P_TARGET: 0.75,     // 复习调度阈值：预测回忆概率降到该值时安排复习
  FORGET_FACTOR: 0.35 // 遗忘/答错后稳定性收缩系数
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 观测"答对"后的掌握后验：P(K|correct) = (1-S)L / ((1-S)L + G(1-L))，再做学习传递 */
export function posteriorOnCorrect(L, { strength = 1 } = {}) {
  const l = clamp(Number(L) || 0, 0.01, 0.99);
  // 弱证据（如复习中的成功回忆）向先验收缩，防止高估
  const mixed = strength >= 1 ? l : strength * l + (1 - strength) * BKT.L0;
  const num = (1 - BKT.S) * mixed;
  const post = num / (num + BKT.G * (1 - mixed));
  return clamp(post + (1 - post) * BKT.T, 0.01, 0.99);
}

/** 观测"答错"后的掌握后验：P(K|wrong) = S·L / (S·L + (1-G)(1-L))，错误不产生学习传递 */
export function posteriorOnWrong(L, { strength = 1 } = {}) {
  const l = clamp(Number(L) || 0, 0.01, 0.99);
  const mixed = strength >= 1 ? l : strength * l + (1 - strength) * BKT.L0;
  const num = BKT.S * mixed;
  return clamp(num / (num + (1 - BKT.G) * (1 - mixed)), 0.01, 0.99);
}

/** 距上次成功回忆 t 天后的可提取概率（指数遗忘曲线） */
export function recallProbability(stability, days) {
  const theta = clamp(Number(stability) || MEMORY.THETA0, MEMORY.THETA_MIN, MEMORY.THETA_MAX);
  const t = Math.max(0, Number(days) || 0);
  return clamp(Math.exp(-t / theta), 0, 1);
}

/**
 * 成功回忆后的稳定性更新（贝叶斯上调，带收缩防过冲）：
 * θ' = θ · (1 + β·(1-P))，P = exp(-t/θ) 为该次回忆的预测概率。
 * - 复习太勤（P≈1）→ 几乎无增益；
 * - 恰在遗忘边缘成功（P≈0.3~0.5）→ 增益最大（合意困难）；
 * - 远超预期仍记得 → θ 显著上调但有界。
 */
export function stabilityAfterRecall(stability, days) {
  const theta = clamp(Number(stability) || MEMORY.THETA0, MEMORY.THETA_MIN, MEMORY.THETA_MAX);
  const t = Math.max(0, Number(days) || 0);
  const p = Math.exp(-t / theta);
  const gain = 1.2 * (1 - p);
  return clamp(theta * (1 + gain), MEMORY.THETA_MIN, MEMORY.THETA_MAX);
}

/** 遗忘/答错后的稳定性收缩 */
export function stabilityAfterLapse(stability) {
  return clamp((Number(stability) || MEMORY.THETA0) * MEMORY.FORGET_FACTOR, MEMORY.THETA_MIN, MEMORY.THETA_MAX);
}

/** 自适应复习间隔（天）：预测回忆概率降到 P_TARGET 所需时间 */
export function reviewIntervalDays(stability) {
  const theta = clamp(Number(stability) || MEMORY.THETA0, MEMORY.THETA_MIN, MEMORY.THETA_MAX);
  return clamp(theta * Math.log(1 / MEMORY.P_TARGET), 0.5, 180);
}

/**
 * 旧数据（正确/错误计数 + 艾宾浩斯轮次）迁移为概率状态：
 * - 把历史计数当作按时间顺序到达的证据流回放给 BKT；
 * - 旧固定间隔轮次 stage 近似映射为稳定性 θ ≈ θ0 · 1.7^stage
 *   （旧间隔 1/2/4/7/15/30 天的几何增长介于 1.7^k 附近）。
 */
export function migrateLegacy({ correct = 0, wrong = 0, stage = 0, last_review_at = null, now = Date.now() } = {}) {
  let L = BKT.L0;
  // 证据回放：交错排列对/错（错题通常先发生，正确发生在掌握之后）
  const events = [];
  for (let i = 0; i < wrong; i++) events.push(false);
  for (let i = 0; i < correct; i++) events.push(true);
  for (const ok of events.slice(-24)) {
    L = ok ? posteriorOnCorrect(L) : posteriorOnWrong(L);
  }
  const theta = clamp(MEMORY.THETA0 * Math.pow(1.7, Math.max(0, Number(stage) || 0)), MEMORY.THETA_MIN, MEMORY.THETA_MAX);
  return { p_known: L, stability: theta };
}

/** 合成掌握度展示分（0~100）：知识掌握后验 × 当前记忆可提取概率 */
export function masteryFromState(pKnown, stability, daysSinceReview, hasReview = false) {
  const retention = hasReview ? recallProbability(stability, daysSinceReview) : 1;
  return Math.round(100 * clamp(Number(pKnown) || 0, 0, 1) * retention);
}

/** 距上次复习的天数（输入为 SQLite datetime 文本，UTC） */
export function daysSince(sqliteTime, now = Date.now()) {
  if (!sqliteTime) return null;
  const ms = now - Date.parse(String(sqliteTime).replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) && ms >= 0 ? ms / 86400000 : 0;
}
