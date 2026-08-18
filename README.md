# 知识图谱智能问答系统（knowlodge）

以 AI 为核心、面向学习资料管理的知识图谱与智能问答平台。

```
材料输入 → AI分析构建知识图谱 → 用户查询 → 智能返回结果
```

## 技术栈

| 层 | 选型 |
|----|------|
| 前端 | Vue 3 + Vite + vue-router + ECharts（图谱可视化） + KaTeX/mhchem（数学、化学公式渲染） + WinUIonWeb（WinUI 3 / UWP Fluent 界面库，已内置到 `web/src/winui/`） |
| 后端 | Node.js + Express |
| 存储 | SQLite（node:sqlite 内置模块） + 内存向量索引 |
| 文档解析 | mammoth（Word）/ pdf-parse v2（PDF 文本+内嵌图像+页面渲染） |
| AI | OpenAI 兼容 API（chat + embeddings + vision 视觉模型），可对接 DeepSeek / 通义 / OpenAI 等 |

## 目录结构

```
server/   后端服务（材料管理 / AI 交互 / 数据存取 / 日志 / 查询管理 / 材料分析生成）
web/      前端 WebUI（总览 / 智能问答 / 知识图谱查询 / 语义检索 / 材料管理 / 材料分析 / 查询管理 / 设置）
```

## 快速开始

```bash
# 1. 后端
cd server
npm install
npm run dev               # http://localhost:8787
# 说明：首次启动会自动创建 .env（从 .env.example 复制）。
# AI_BASE_URL / AI_API_KEY 可直接在"设置"页填写，保存后持久化到 .env，重启不丢失。

# 2. 前端（新开终端）
cd web
npm install
npm run dev               # http://localhost:5173
```

默认账号：`admin` / `admin123`（首次启动自动创建，可在登录后修改）。

## 使用说明

### 知识管理（材料 → 图谱 → 问答）

1. **材料管理**：支持文本粘贴或文件上传（.txt / .md / .csv / .json / **.docx** / **.pdf** / **.png / .jpg / .gif / .webp / .bmp 图片**）。Word/PDF 自动提取文本与内嵌图像；无可提取内容的 PDF 自动整页渲染兜底；入库后为"待分析"状态。
2. **材料分析生成**：对材料触发分析任务，AI 流水线为 **视觉分析 → 分类 → 概览 → 元信息注册 → 知识抽取 → 向量化 → 并入总图谱**；分析时可输入**引导词**指导 AI。配置视觉模型后，材料中的图像（docx/pdf 内嵌图、图片材料、扫描页渲染图）由视觉模型解读，描述内容注入主模型分析上下文（未配置 API Key 时自动降级为离线启发式抽取）。
3. **智能问答（对话式全能助手）**：DeepSeek 风格多会话聊天——可新建/切换/重命名/删除多个对话，支持多轮追问（自动携带会话历史）。它是**有求必应的 AI 助手**：学科解题、学习方法、知识讲解、闲聊规划皆可回答；知识库有相关资料时自动引用出处，没有时基于自身知识作答。同时它**能调用你的学情数据**（薄弱知识点、最近错题、考试成绩、练习正确率、待复习提醒），在回答中给出个性化建议与"学情提示"。回答包含关联知识点树 + 引用材料与出处，数学/化学公式自动渲染（KaTeX + mhchem）。
4. **知识图谱查询**：三种视图——**力导向图谱**、**学习树**（按 科目 → 子知识网/题目 → 知识点 层级展开）、**Markdown 结构**。支持按科目/关键词筛选、节点详情、来源跳转。点击节点可查看**知识点讲解**（优先复用已存档描述，未存档时可由 AI 生成并回写存档）。
5. **语义检索**：基于向量相似度的跨材料语义搜索。
6. **查询管理**：历史查询的查看、复用、删除。

### 学习闭环（考试 → 错题 → 学情 → 巩固，PDCA）

7. **考试管理**：登记考试/练习（科目、日期、满分、得分），重复记录自动拒绝；按科目查看**成绩波动趋势图**。支持**大型考试（多科目联合）**：录入时填写"所属大型考试"，系统自动归组并给出**总分析**（总分/总得分率、各科排名柱状图、该次考试的错题分布、AI 总体分析报告）。
8. **错题本**：文本录入或**拍照上传**（视觉模型识别题干）；AI 结构化为标准记录（题干/选项/正确答案/作答/解析/知识点），支持**分析引导词**；错题与知识点**强关联**并入图谱。**错因标签动态可管理**：预置知识盲区/逻辑错误/概念混淆/粗心/方法错误等，用户可自行增删改（含说明）；AI 自动分析时会先读取全部标签及说明，优先选择已有标签，也可自行创建新标签（标记为 AI 创建）。
9. **学情分析**（可视化）：**薄弱知识点雷达图**、**错因标签分布环图**、**掌握度横向柱状图**、**成绩趋势折线图**、薄弱知识点标签云（掌握度 = 正确率 × 记忆保持系数，随时间衰减）；**艾宾浩斯记忆曲线**复习提醒（1/2/4/7/15/30 天间隔），完成复习即恢复记忆保持。
10. **学习计划**：AI 基于薄弱点、到期复习与近期考试生成 7 天个性化计划（支持引导词，可动态重新生成）。
11. **练习中心**：为薄弱考点生成**变式训练题**（AI 出题，几何题输出图形参数由系统 SVG 渲染）；AI 判题或自评，结果回写掌握度。
12. **学习报告**：各科目考点掌握度、错因×科目分布、成长轨迹图表 + AI 学情总结。
13. **首页倒计时**：支持创建/删除重要日期倒计时，首页轮播展示。
14. **首页学情概览与 AI 加油站**：首页展示各科平均掌握度、错因标签、薄弱知识点与待复习数量；"AI 加油站"**每小时自动生成一次**鼓励语（结合进步与薄弱数据，1 小时内访问复用缓存、不重复生成，可手动"换一句"强制刷新）。
15. **设置**：AI 接入（base_url / key / 对话 / 备用对话 / 重试次数 / 向量 / **视觉**模型）、**自动分析开关**；配置写入 `server/.env` 持久化，主模型失败自动切换备用模型。
16. **监控**：`GET /api/monitor` 查看系统运行状态与近期日志。

## 配置与持久化

- 服务首次启动若 `server/.env` 不存在，会自动从 `.env.example` 复制创建。
- "设置"页保存的 AI 配置（base_url / key / 对话 / 向量 / 视觉模型）直接写回 `.env` 对应环境变量并即时生效，重启不丢失。
- 业务数据存于 `server/data/knowlodge.db`，上传图片存于 `server/data/images/`，运行日志存于 `server/data/logs/`。备份时复制整个 `server/data/` 与 `server/.env` 即可。
- 可通过环境变量 `KNOWLODGE_DATA_DIR` / `KNOWLODGE_ENV_PATH` 指定数据目录与 .env 路径（用于多实例或测试隔离）。旧库自动迁移（新增列/表不影响已有数据）。

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/login | 登录获取 token |
| GET/POST/DELETE | /api/materials | 材料增删查 |
| POST | /api/materials/upload | 文件上传（docx/pdf/图片/文本） |
| GET | /api/materials/:id/images | 材料图像列表（含视觉描述） |
| POST | /api/analysis/run | 触发材料分析 |
| GET | /api/analysis/jobs | 分析任务列表/进度 |
| POST | /api/qa | 智能问答 |
| POST | /api/search | 语义检索 |
| GET | /api/graph | 图谱数据（节点/关系/子网成员，支持筛选/邻域） |
| GET | /api/graph/node/:id | 知识点详情（关系/子网/出处） |
| GET | /api/graph/node/:id/explain | 知识点讲解（存档优先，可 AI 生成，?force=1 强制重生成） |
| GET/POST/PUT/DELETE | /api/exams | 考试记录管理（自动去重，可归属大型考试） |
| GET | /api/exams/trend | 成绩趋势 |
| GET | /api/exams/events | 大型考试事件列表（聚合总分） |
| GET | /api/exams/events/:id | 大型考试总分析（总分/各科/错题分布/AI总评） |
| GET/POST/PUT/DELETE | /api/wrong | 错题管理（文本/拍照录入） |
| GET/POST/PUT/DELETE | /api/wrong/causes | 错因标签管理（用户/AI 均可创建） |
| POST | /api/wrong/:id/analyze | 错题 AI 结构化 + 知识点强关联（注入已有标签，支持引导词） |
| GET | /api/study/overview | 学情总览（雷达/错因/掌握度/趋势/复习提醒） |
| POST | /api/study/reviews/:nodeId/complete | 完成记忆曲线复习 |
| GET/POST | /api/study/plan | 读取/重新生成个性化学习计划 |
| POST | /api/study/practice/generate | 生成薄弱考点变式练习 |
| POST | /api/study/practices/:id/submit | 提交练习（AI 判题/自评，更新掌握度） |
| GET | /api/study/report | 学习报告数据 |
| GET | /api/study/report/summary | AI 学情总结 |
| GET/POST/DELETE | /api/countdowns | 倒计时管理 |
| GET/POST/PUT/DELETE | /api/chat/conversations | 问答会话管理（多对话/重命名/删除） |
| GET/POST | /api/chat/conversations/:id/messages | 会话消息（多轮对话，携带学情上下文） |
| GET | /api/study/encourage | AI 鼓励语（每小时缓存，过期自动更新） |
| POST | /api/study/encourage/refresh | 强制刷新生成鼓励语 |
| GET/PUT | /api/settings | 读取/保存设置（持久化到 .env） |
| GET | /api/monitor | 系统监控 |

## 生产环境部署

**前置**：服务器安装 Node.js ≥ 22.13（推荐 24 LTS，`node:sqlite` 内置）。

```bash
# 1. 获取代码（推送到服务器后）
cd /opt/knowlodge

# 2. 安装依赖
cd server && npm install --omit=dev
cd ../web && npm install && npm run build   # 构建产物 web/dist 由后端直接托管

# 3. 启动（单进程同时提供 API 与前端页面）
cd ../server && node src/index.js           # 默认 http://<服务器IP>:8787
```

推荐使用 PM2 守护进程：

```bash
npm install -g pm2
cd /opt/knowlodge/server
pm2 start src/index.js --name knowlodge
pm2 save && pm2 startup                     # 开机自启
```

访问 `http://<服务器IP>:8787`，使用 `admin/admin123` 登录后请立即修改密码，并在"设置"页配置 AI 接入。
若需 HTTPS/域名，可在前端加一层 Nginx 反向代理到 8787 端口并配置证书。
