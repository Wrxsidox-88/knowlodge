/**
 * 学科学习策略画像（v1.7.0）
 * ============================================================
 * 不同学科的知识结构与遗忘规律差异极大：
 * - 数学/物理：程序性知识（解题步骤、推导），靠变式练习与错题重做巩固；
 * - 化学：符号系统 + 大量事实性知识（方程式、性质），需要默写与网络化记忆；
 * - 英语：陈述性 + 技能混合，高频短间隔的词汇/语块回顾最有效；
 * - 语文：长周期积累（素材、古诗文），复习密度低但周期长；
 * - 史地政生：记忆型科目，知识结构图 + 间隔背诵收益最高。
 * 这些画像注入 AI prompt（练习生成/错题分析/笔记结构化/学情报告）
 * 与复习提醒（建议复习方式），使整个系统按学科采取不同学习方法。
 */

const PROFILES = {
  数学: {
    type: '程序性',
    reviewStyle: '盖住答案重做原错题，再做一道同考点变式题',
    practiceHint: '出同考点变式题，强调完整推导过程与易错步骤',
    noteMethodHint: '以"题型 → 方法 → 易错点"的结构组织，公式与推导过程单独成支',
    memoryHint: '公式定理不能只背结论，要能默写推导路径'
  },
  物理: {
    type: '程序性',
    reviewStyle: '先复述物理模型与适用条件，再重做错题',
    practiceHint: '围绕同一物理模型换情境出题，突出受力/过程分析',
    noteMethodHint: '按"概念 → 规律（公式+适用条件）→ 典型模型"层次组织',
    memoryHint: '每个公式绑定一个物理模型和适用条件来记'
  },
  化学: {
    type: '混合',
    reviewStyle: '默写方程式与性质网络，再核对条件与配平',
    practiceHint: '结合方程式书写与实验情境出题，强调条件与现象',
    noteMethodHint: '以物质为中心辐射性质/制法/用途，方程式单独整理成卡',
    memoryHint: '方程式按"反应条件+现象"成对记忆，防止张冠李戴'
  },
  英语: {
    type: '记忆+技能',
    reviewStyle: '高频短间隔回顾词块，用例句造句自测',
    practiceHint: '出语块填空、句型转换或短文改错，避免孤立考单词',
    noteMethodHint: '按话题分组词块/句型，每个配一个自编例句',
    memoryHint: '词汇放在语块和例句里记，间隔重复密度要高于其他科目'
  },
  语文: {
    type: '积累型',
    reviewStyle: '默写古诗文与素材要点，隔天复述文章结构',
    practiceHint: '出古诗文默写、文意理解或仿写题',
    noteMethodHint: '按"字词积累 / 文言现象 / 阅读方法 / 作文素材"分板块组织',
    memoryHint: '古诗文默写与作文素材走长周期滚动复习'
  },
  生物: {
    type: '记忆型',
    reviewStyle: '画知识结构图复述，用教材原文核对表述',
    practiceHint: '围绕概念辨析与实验设计出题',
    noteMethodHint: '以"概念 → 过程/结构 → 易混对比"组织，多用对比表',
    memoryHint: '教材表述要精确，易混概念成对对比记忆'
  },
  历史: {
    type: '记忆型',
    reviewStyle: '按时间轴复述因果链条，再回看错题',
    practiceHint: '出因果分析、材料辨析类题目',
    noteMethodHint: '以时间轴为骨架，事件按"背景-经过-影响"挂载',
    memoryHint: '记因果链而不是孤立年份，用时间轴串联'
  },
  地理: {
    type: '混合',
    reviewStyle: '结合地图复述原理，再重做错题',
    practiceHint: '结合图表与区域情境出题，突出原理应用',
    noteMethodHint: '以"原理 → 区位要素 → 典型区域案例"组织，图文结合',
    memoryHint: '原理落到地图上记，区域案例作为原理的载体'
  },
  政治: {
    type: '记忆型',
    reviewStyle: '复述原理关键词与答题框架，再核对术语',
    practiceHint: '出材料分析题，强调原理与材料的对应',
    noteMethodHint: '按"原理 → 关键术语 → 答题模板"组织',
    memoryHint: '记关键词与框架，术语表述要规范'
  }
};

const FALLBACK = {
  type: '通用',
  reviewStyle: '盖住答案复述要点，再重做一遍错题',
  practiceHint: '出同考点变式题，考查理解与应用',
  noteMethodHint: '按"核心概念 → 展开要点 → 例子"的层级组织',
  memoryHint: '理解后按间隔重复记忆'
};

// 学科名模糊匹配：兼容"数学（必修一）""高一数学"等带修饰的写法
export function subjectProfile(subject) {
  const s = String(subject || '').trim();
  if (!s) return FALLBACK;
  for (const key of Object.keys(PROFILES)) {
    if (s.includes(key)) return PROFILES[key];
  }
  return FALLBACK;
}

/** 学科清单（供前端下拉与路由判断），保持与错题分析 prompt 的科目枚举一致 */
export const SUBJECT_KEYS = ['数学', '物理', '化学', '生物', '语文', '英语', '历史', '地理', '政治', '其他'];
