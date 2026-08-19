<template>
  <div class="col-stack settings-page">
    <div v-if="pageLoading" class="page-loading"><span class="loading"></span>正在加载数据…</div>

    <!-- 账户信息（Windows 11 设置 > 账户 布局：扁平展示、不折叠、无卡片包裹） -->
    <section class="account-section">
      <div class="account-frame">
        <div class="account-main">
          <div class="account-head">
            <span class="account-avatar">{{ initial }}</span>
            <div class="account-meta">
              <div class="account-name">{{ accUser?.username || 'admin' }}</div>
              <div class="account-sub">{{ (accUser?.role === 'admin' ? '管理员' : '用户') }} · 本地账户</div>
            </div>
          </div>
          <div class="account-edit">
            <label class="field">
              <span>新用户名</span>
              <input v-model="accForm.username" :placeholder="'留空则不修改（当前：' + (accUser?.username || 'admin') + '）'" />
            </label>
            <div class="toolbar" style="margin: 0">
              <span v-if="accMsg" class="muted" :class="accErr ? 'danger' : 'done'" style="font-size: 12px">{{ accMsg }}</span>
              <div class="spacer"></div>
              <button @click="openPasswordModal">修改密码…</button>
              <button class="primary" :disabled="accSaving" @click="saveAccount">
                <span v-if="accSaving" class="loading"></span>保存用户名
              </button>
            </div>
          </div>
        </div>

        <!-- 右侧系统信息：当前系统版本 / 服务器版本 / Node 版本 / 内存占用 -->
        <div class="account-sys">
          <div class="as-title">系统信息</div>
          <div
            class="as-row"
            :class="{ 'row-flash': sysFlash === 'osVersion' }"
            @click="onSysRow('osVersion')">
            <span class="k">系统版本</span><span>{{ sysInfo?.osVersion || '-' }}</span>
          </div>
          <div
            class="as-row"
            :class="{ 'row-flash': sysFlash === 'serverVersion' }"
            @click="onSysRow('serverVersion')">
            <span class="k">服务器版本</span><span>knowlodge v{{ sysInfo?.serverVersion || '-' }}</span>
          </div>
          <div
            class="as-row"
            :class="{ 'row-flash': sysFlash === 'nodeVersion' }"
            @click="onSysRow('nodeVersion')">
            <span class="k">Node 版本</span><span>{{ sysInfo?.nodeVersion || '-' }}</span>
          </div>
          <div
            class="as-row"
            :class="{ 'row-flash': sysFlash === 'memory' }"
            @click="onSysRow('memory')">
            <span class="k">内存占用</span><span>{{ sysInfo?.memoryMB != null ? sysInfo.memoryMB + ' MB' : '-' }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 状态摘要（常驻可读，不折叠） -->
    <div class="card">
      <div class="toolbar" style="margin: 0">
        <span class="badge" :class="info?.ai?.enabled ? 'done' : 'pending'">
          {{ info?.ai?.enabled ? 'AI 已接入' : '离线模式（未配置 Key，使用启发式分析）' }}
        </span>
        <span class="muted" v-if="info?.ai?.keyPreview">当前 Key：{{ info.ai.keyPreview }}</span>
        <div class="spacer"></div>
        <span class="muted">向量索引条数：{{ info?.vectorIndexSize ?? '-' }}</span>
      </div>
    </div>

    <!-- 外观与动画 -->
    <WinExpander
      class="settings-expander"
      Header="外观与动画"
      Description="页面切换动画样式（明暗主题切换在标题栏）"
      HeaderIcon="&#xE8AB;">
      <label class="field">
        <span>页面切换动画</span>
        <WinRadioButtons :SelectedIndex="transitionIndex" MaxColumns="2" @SelectionChanged="onTransitionChanged">
          <WinRadioButton v-for="m in transitionModes" :key="m.value" :Content="m.label" />
        </WinRadioButtons>
      </label>
      <div class="muted" style="font-size: 12px; line-height: 1.7">
        与 Windows 应用导航过渡一致的 8 种切换效果：默认淡入、滑动（从右/左）、进入、钻取、通用、连续，或无动画。
      </div>
    </WinExpander>

    <!-- AI 与模型 -->
    <WinExpander
      class="settings-expander"
      Header="AI 与模型"
      Description="OpenAI 兼容接口：Base URL、Key、对话 / 备用 / 向量 / 视觉模型，自动分析与图谱子网策略开关"
      HeaderIcon="&#xE713;">
      <div v-if="error" class="error-box">{{ error }}</div>
      <label class="field">
        <span>API Base URL</span>
        <input v-model="form['ai.baseUrl']" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="field">
        <span>API Key</span>
        <input v-model="form['ai.apiKey']" type="password" placeholder="sk-..." />
      </label>
      <label class="field">
        <span>对话模型（分类/概览/知识抽取/问答）</span>
        <div class="toolbar" style="margin: 0">
          <input v-model="form['ai.chatModel']" placeholder="gpt-4o-mini / deepseek-chat / qwen-plus" style="flex: 1" />
          <button class="small" :disabled="fetchingModels" @click="fetchModels">
            <span v-if="fetchingModels" class="loading"></span>获取模型列表
          </button>
        </div>
      </label>
      <div v-if="models.length" class="toolbar" style="margin-bottom: 10px">
        <span class="muted">可用模型（点击填入）：</span>
        <span v-for="mo in models.slice(0, 12)" :key="mo" class="chip" @click="form['ai.chatModel'] = mo">{{ mo }}</span>
      </div>
      <label class="field">
        <span>备用对话模型（主模型失败自动切换）</span>
        <input v-model="form['ai.backupModel']" placeholder="可留空" />
      </label>
      <label class="field" style="max-width: 220px">
        <span>重试次数</span>
        <input v-model="form['ai.retryCount']" type="number" min="1" max="5" />
      </label>
      <label class="field">
        <span>向量模型（Embedding：语义检索）</span>
        <input v-model="form['ai.embedModel']" placeholder="text-embedding-3-small / text-embedding-v3" />
      </label>
      <label class="field">
        <span>视觉分析模型（解读 docx/pdf 内嵌图片、图片材料、扫描页）</span>
        <input v-model="form['ai.visionModel']" placeholder="gpt-4o-mini / qwen-vl-plus（可留空）" />
      </label>
      <div class="settings-toggle-row">
        <div class="settings-toggle-text">
          <span class="settings-toggle-title">错题录入后自动 AI 分析</span>
          <span class="settings-toggle-desc">保存错题后自动进入 AI 结构化分析，并关联知识点、更新掌握度</span>
        </div>
        <WinToggleSwitch :IsOn="autoAnalyze" @update:IsOn="autoAnalyze = $event" />
      </div>
      <div class="settings-toggle-row">
        <div class="settings-toggle-text">
          <span class="settings-toggle-title">允许 AI 分析时按需创建知识清单</span>
          <span class="settings-toggle-desc">分析材料 / 错题时，AI 可按需建立目录化知识清单</span>
        </div>
        <WinToggleSwitch :IsOn="listsAutocreate" @update:IsOn="listsAutocreate = $event" />
      </div>
      <div class="settings-toggle-row">
        <div class="settings-toggle-text">
          <span class="settings-toggle-title">允许 AI 直接修改现有子网</span>
          <span class="settings-toggle-desc">
            开启：分析前注入已有知识图谱，由 AI 自行判断"并入已有子网"还是"新建子网"；
            关闭：不注入已有图谱，每次分析都为材料新建独立子网，不改动任何已有子网
          </span>
        </div>
        <WinToggleSwitch :IsOn="modifySubGraphs" @update:IsOn="modifySubGraphs = $event" />
      </div>
      <div class="toolbar">
        <button class="primary" :disabled="saving" @click="save">
          <span v-if="saving" class="loading"></span>保存设置
        </button>
        <button :disabled="testing" @click="test">
          <span v-if="testing" class="loading"></span>连通性测试
        </button>
        <button @click="openStreamModal">流式输出设置…</button>
      </div>
      <div class="settings-toggle-row" style="margin-top: 4px">
        <div class="settings-toggle-text">
          <span class="settings-toggle-title">AI 用量计量</span>
          <span class="settings-toggle-desc">
            开启后记录每次 AI 调用的 token 消耗（问答 / 图片识别 / 向量化 / 分析），可在弹窗查看趋势与总量、性能，
            并可设置每月/每周限额、临时增加或重置（需密码确认）、趋势保存窗口
          </span>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <WinToggleSwitch :IsOn="meterEnabled" @update:IsOn="onMeterToggle" />
          <button :disabled="!meterEnabled" @click="openMeter">Token 计量…</button>
        </div>
      </div>
      <div v-if="!meterEnabled" class="muted" style="font-size: 11px; margin-top: 4px">
        已关闭计量，Token 计量入口不可操作；开启后方可查看与设置
      </div>
      <div v-if="testResult" class="node-card">
        <div v-if="testResult.enabled === false" class="muted">{{ testResult.error }}</div>
        <template v-else>
          <div>
            对话模型：<span class="badge" :class="testResult.chat ? 'done' : 'failed'">{{ testResult.chat ? '可用' : '失败' }}</span>
            <span v-if="testResult.chatError" class="muted"> {{ testResult.chatError }}</span>
          </div>
          <div style="margin-top: 6px">
            向量模型：<span class="badge" :class="testResult.embedding ? 'done' : 'failed'">{{ testResult.embedding ? '可用' : '失败' }}</span>
            <span v-if="testResult.embeddingError" class="muted"> {{ testResult.embeddingError }}</span>
          </div>
          <div style="margin-top: 6px">
            视觉模型：<span class="badge" :class="testResult.vision ? 'done' : 'failed'">{{ testResult.vision ? '可用' : testResult.visionError || '未测试' }}</span>
          </div>
        </template>
      </div>
    </WinExpander>

    <!-- 倒计时管理 -->
    <WinExpander
      class="settings-expander"
      Header="倒计时管理"
      Description="创建重要日期倒计时，在首页轮播展示（精确到秒）"
      HeaderIcon="&#xE734;">
      <div class="toolbar" style="flex-wrap: wrap">
        <input v-model="cdForm.title" placeholder="标题，如：期末考试" style="width: 220px" />
        <WinDatePicker v-model:Date="cdDateModel" />
        <WinTimePicker v-model:SelectedTime="cdTimeModel" ClockIdentifier="24HourClock" />
        <button class="primary" @click="addCountdown">新建</button>
      </div>
      <div v-if="!countdowns.length" class="empty">暂无倒计时</div>
      <div v-for="c in countdowns" :key="c.id" class="node-card" style="max-width: 640px">
        <div class="toolbar" style="margin: 0">
          <strong>{{ c.title }}</strong>
          <span class="badge pending">{{ fmtTarget(c.target_time) }}</span>
          <div class="spacer"></div>
          <button class="small danger" @click="delCountdown(c)">删除</button>
        </div>
      </div>
    </WinExpander>

    <!-- 数据管理 -->
    <WinExpander
      class="settings-expander"
      Header="数据管理"
      Description="导出 / 导入全部数据、服务重启与 PM2 开机自启配置"
      HeaderIcon="&#xE8B7;">
      <div class="toolbar">
        <button :disabled="exporting" @click="openDataAction('export')">
          <span v-if="exporting" class="loading"></span>导出全部数据（zip 压缩包）
        </button>
        <label class="btn" style="cursor: pointer">
          <span v-if="importing" class="loading"></span>导入数据（zip）
          <input type="file" accept=".zip" style="display: none" @change="importData" />
        </label>
      </div>
      <div class="muted" style="line-height: 1.8; margin-top: 6px">
        · 导出包含：数据库、知识图谱、材料/错题图片、学习数据与 .env 配置。<br />
        · 导入会<strong style="color: var(--warn)">覆盖</strong>当前全部数据并自动重启服务，请谨慎操作。
      </div>
      <h3 style="margin-top: 14px">服务控制</h3>
      <div class="toolbar">
        <button class="danger" @click="openDataAction('restart')">重启服务</button>
        <button @click="showPm2 = !showPm2">PM2 开机自启配置</button>
      </div>
      <div v-if="showPm2 && pm2" class="node-card" style="margin-top: 8px">
        <div class="muted" style="margin-bottom: 6px">{{ pm2.note }}</div>
        <pre class="md-text">{{ pm2.commands.join('\n') }}</pre>
        <details style="margin-top: 6px">
          <summary class="muted" style="cursor: pointer">ecosystem 配置文件</summary>
          <pre class="md-text">{{ pm2.config }}</pre>
        </details>
      </div>
    </WinExpander>

    <!-- 关于（Windows 系统信息风格） -->
    <WinExpander
      class="settings-expander"
      Header="关于"
      Description="系统信息、版本与所使用的开源项目"
      HeaderIcon="&#xE8A1;"
      :IsExpanded="true">
      <div class="about-header">
        <div class="about-app">
          <div class="about-app-title">知识图谱智能问答系统</div>
          <div class="about-app-sub">knowlodge · v{{ sysInfo?.serverVersion || updLocal?.version || '-' }}</div>
          <div class="about-app-desc">以 AI 为核心的学习平台：材料输入 → 知识图谱构建 → 智能问答 → 学习闭环（考试 / 错题 / 学情 / 练习 / 报告）</div>
        </div>
      </div>

      <div class="about-section-title">规格</div>
      <div class="about-specs">
        <div class="about-spec"><span>前端</span><span>Vue 3 + Vite + WinUIonWeb（UWP 风格界面）</span></div>
        <div class="about-spec"><span>后端</span><span>Node.js + Express + SQLite</span></div>
        <div class="about-spec"><span>AI</span><span>OpenAI 兼容接口（对话 / 向量 / 视觉模型）</span></div>
        <div class="about-spec"><span>呈现</span><span>ECharts 图表 · KaTeX 公式 · SVG 图形渲染</span></div>
      </div>

      <div class="about-section-title">开源项目</div>
      <div class="about-links">
        <a class="about-link" href="https://github.com/Wrxsidox-88/knowlodge" target="_blank" rel="noopener">
          <svg class="gh-icon" viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <span class="about-link-text">
            <strong>Wrxsidox-88/knowlodge</strong>
            <small>知识图谱智能问答系统 · 项目代码仓库</small>
          </span>
          <span class="about-link-arrow">&#xE72A;</span>
        </a>
        <a class="about-link" href="https://github.com/Furry-Xiyi/WinUIonWeb" target="_blank" rel="noopener">
          <svg class="gh-icon" viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <span class="about-link-text">
            <strong>Furry-Xiyi/WinUIonWeb</strong>
            <small>WebUI 使用的 WinUI 开源组件库（已内置）</small>
          </span>
          <span class="about-link-arrow">&#xE72A;</span>
        </a>
      </div>

      <div class="about-footer">© 2026 Wrxsidox-88 · 基于 WinUIonWeb（Vue 组件库）构建 · 界面图标来自 Segoe MDL2</div>
    </WinExpander>

    <!-- 说明 -->
    <WinExpander
      class="settings-expander"
      Header="说明"
      Description="系统配置与使用须知"
      HeaderIcon="&#xE8E4;">
      <ul style="padding-left: 20px; line-height: 2; color: var(--text-dim); font-size: 13px">
        <li><strong>.env 是唯一配置源</strong>：运行时配置只从 server/.env 读取，不受系统环境变量、启动命令影响；设置保存即写入该文件。</li>
        <li>未配置 API Key 时以离线模式运行；配置后走完整 AI 流水线。</li>
        <li>AI 问答可绘图（函数/几何/全符号），由系统精确渲染，非 HTML 绘制，可导出 PNG 插入 Word。</li>
        <li>AI 工具（重析材料/编辑倒计时/知识清单/生成文档）均需用户授权后执行。</li>
        <li>公式使用 LaTeX 语法（$...$ / $$...$$ / $\ce{...}$）自动渲染。</li>
      </ul>
    </WinExpander>

    <!-- 版本与更新（Windows 更新风格） -->
    <WinExpander
      class="settings-expander"
      Header="版本与更新"
      Description="检查、下载并应用到最新版本，自动更新策略"
      HeaderIcon="&#xEB22;">
      <div class="toolbar" style="margin: 0">
        <span>当前版本 <span class="badge">{{ updLocal.version }}</span></span>
        <span v-if="updBusyCount > 0" class="badge pending">运行中任务 {{ updBusyCount }}</span>
        <div class="spacer"></div>
        <button class="primary" :disabled="updChecking" @click="checkUpdate">
          <span v-if="updChecking" class="loading"></span>检查更新
        </button>
        <button @click="openUpdChangelog">查看更新日志</button>
        <button :disabled="updReadmeBusy" @click="openUpdReadme">
          <span v-if="updReadmeBusy" class="loading"></span>系统介绍
        </button>
        <button class="danger" :disabled="updApplying || updBusyCount > 0" @click="forceUpdate">强制更新</button>
      </div>

      <div class="card" style="margin-top: 10px">
        <template v-if="updHasUpdate">
          <span class="badge done">发现新版本 {{ updLastCheck.remoteVersion }}</span>
          <div class="muted" style="margin-top: 6px">当前版本 {{ updLastCheck.localVersion }}，可更新</div>
        </template>
        <template v-else-if="updLastCheck && updLastCheck.ok">
          <span class="badge done">已是最新版本</span>
        </template>
        <template v-else>
          <span class="badge pending">尚未检测到更新</span>
          <div v-if="updLastCheck && updLastCheck.error" class="muted" style="font-size: 12px; margin-top: 4px">{{ updLastCheck.error }}</div>
        </template>
        <div v-if="updLastCheck && updLastCheck.checkedAt" class="muted" style="font-size: 12px; margin-top: 6px">最近检查：{{ updLastCheck.checkedAt }}</div>
      </div>

      <div v-if="updHasUpdate" class="node-card" style="margin-top: 10px">
        <div class="muted" style="margin-bottom: 4px">更新日志</div>
        <div class="md-body" style="max-height: 180px; overflow: auto" v-html="md(updLastCheck.changelog || '（无更新日志）')"></div>
        <div class="toolbar" style="margin-top: 8px">
          <button class="small" :disabled="updDiffBusy" @click="viewDiff">
            <span v-if="updDiffBusy" class="loading"></span>查看将更新的文件
          </button>
        </div>
        <div v-if="updDiff" class="muted" style="font-size: 12px; margin-top: 6px">
          将更新 <b>{{ updDiff.count }}</b> 个文件（分支 {{ updDiff.branch }}）到 {{ updDiff.remoteVersion }}：
        </div>
        <div v-if="updDiff" class="upd-diff-list">
          <div v-for="f in updDiff.changedFiles" :key="f.path" class="upd-diff-item">
            <span class="badge" :class="f.action === 'create' ? 'done' : 'pending'">{{ f.action === 'create' ? '新增' : '修改' }}</span>
            <span class="upd-diff-path">{{ f.path }}</span>
          </div>
        </div>
        <label class="field" style="margin-top: 10px">
          <span>更新方式</span>
          <WinRadioButtons :SelectedIndex="updMethodIndex" MaxColumns="2" @SelectionChanged="onUpdMethodChanged">
            <WinRadioButton v-for="m in updMethodOptions" :key="m.value" :Content="m.label" />
          </WinRadioButtons>
        </label>
        <div class="toolbar" style="margin-top: 8px">
          <button class="primary" :disabled="updApplying || updBusyCount > 0" @click="openApply">
            <span v-if="updApplying" class="loading"></span>应用更新
          </button>
          <span v-if="updBusyCount > 0" class="muted" style="font-size: 12px">有任务运行中，暂不可更新</span>
        </div>
      </div>

      <!-- 实时更新进度条（触发更新后每 1.5s 轮询） -->
      <div v-if="updProgressShown" class="node-card" style="margin-top: 10px">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px">
          <div class="muted">更新进度</div>
          <div class="spacer"></div>
          <button @click="openUpdateLog">更新日志</button>
        </div>
        <WinProgressBar :Value="updProgressPercent" :IsIndeterminate="updProgressIndeterminate" :Width="'100%'" :MinHeight="4" />
        <div v-if="updProgressMessage" class="muted" style="font-size: 12px; margin-top: 6px">{{ updProgressMessage }}</div>
      </div>
      <div v-if="updApplySuccess && !updProgressShown" class="muted done" style="margin-top: 8px">{{ updApplySuccess }}</div>

      <h3 style="margin-top: 14px">设置</h3>
      <label class="field">
        <span>仓库地址</span>
        <input v-model="updRepo" placeholder="https://github.com/Wrxsidox-88/knowlodge" />
      </label>
      <div class="settings-toggle-row" style="margin-top: 8px">
        <div class="settings-toggle-text">
          <span class="settings-toggle-title">使用代理</span>
          <span class="settings-toggle-desc">通过代理服务器拉取更新（代理地址留空 = 关闭代理）</span>
        </div>
        <WinToggleSwitch :IsOn="updUseProxy" @update:IsOn="updUseProxy = $event" />
      </div>
      <label v-if="updUseProxy" class="field" style="margin-top: 8px">
        <span>代理地址</span>
        <input v-model="updProxyUrl" placeholder="http://127.0.0.1:7890" />
      </label>
      <label class="field" style="margin-top: 8px; max-width: 220px">
        <span>检查更新间隔（小时）</span>
        <input v-model.number="updInterval" type="number" min="0" />
      </label>
      <label class="field" style="margin-top: 8px">
        <span>自动更新策略</span>
        <WinRadioButtons :SelectedIndex="updAutoIndex" MaxColumns="3" @SelectionChanged="onUpdAutoChanged">
          <WinRadioButton v-for="o in updAutoOptions" :key="o.value" :Content="o.label" />
        </WinRadioButtons>
      </label>
      <div class="muted" style="font-size: 12px; margin-top: 4px">关闭自动更新（off）时仅可手动检查与应用更新。</div>
      <div class="toolbar" style="margin-top: 10px">
        <button class="primary" @click="saveUpdateSettings">保存设置</button>
        <span v-if="updSaved" class="muted done" style="font-size: 12px">设置已保存</span>
        <span v-if="updStatusError" class="muted danger" style="font-size: 12px">{{ updStatusError }}</span>
      </div>
      <div v-if="updLastResult" class="muted" style="font-size: 12px; margin-top: 8px">
        最近结果：<span :class="updLastResult.ok ? 'done' : 'danger'">{{ updLastResult.ok ? '成功' : '失败' }}</span>
        <template v-if="!updLastResult.ok && updLastResult.reason">（{{ updLastResult.reason }}）</template>
        <template v-if="updLastResult.version"> · {{ updLastResult.method || '' }} {{ updLastResult.version }}</template>
        <template v-if="updLastResult.ts"> · {{ updLastResult.ts }}</template>
      </div>
      <div v-if="updErr" class="error-box" style="margin-top: 8px">{{ updMsg }}</div>
      <div v-else-if="updMsg" class="muted" style="margin-top: 8px; font-size: 12px">{{ updMsg }}</div>
    </WinExpander>

    <!-- Token 计量弹窗：趋势 / 总量 / 性能 / 限额 / 趋势窗口 / 临时增加 / 重置 -->
    <Teleport to="body">
    <div v-if="meterModal" class="modal-mask" @click.self="meterModal = false">
      <div class="modal meter-modal">
        <h3 style="display: flex; align-items: center; gap: 8px">
          Token 计量
          <span class="badge" :class="meterEnabled ? 'done' : 'muted'">{{ meterEnabled ? '已开启' : '未开启' }}</span>
          <div class="spacer"></div>
          <button @click="meterModal = false">关闭</button>
        </h3>

        <!-- 总量 / 今日 / 周期 -->
        <div class="meter-kpis">
          <div class="meter-kpi"><span class="l">累计总量</span><span class="v">{{ fmtTok(mTotal) }}</span></div>
          <div class="meter-kpi"><span class="l">今日</span><span class="v">{{ fmtTok(mToday) }}</span></div>
          <div class="meter-kpi"><span class="l">本月/周</span><span class="v">{{ fmtTok(mCycle) }}</span></div>
        </div>
        <div v-if="mCycleShare != null && meterEnabled" class="meter-progress">
          <div class="meter-progress-track"><div class="meter-progress-fill" :style="{ width: Math.min(100, mCycleShare) + '%' }"></div></div>
          <span class="muted">已用周期限额 {{ mCycleShare }}%{{ mGrant ? `（含临时增加 ${fmtTok(mGrant)}）` : '' }}</span>
        </div>

        <!-- 折线趋势图 -->
        <div class="meter-section-title">近 {{ mWindowDays }} 天趋势（tokens / 天）</div>
        <div class="meter-chart" :class="{ disabled: !meterEnabled }">
          <svg v-if="mTrend.length > 1" viewBox="0 0 620 180" preserveAspectRatio="none" style="width:100%;height:180px;display:block">
            <polyline :points="mPoints" fill="none" stroke="var(--accent-base,#0078d4)" stroke-width="2" stroke-linejoin="round" />
            <polyline :points="mArea" fill="var(--accent-base,#0078d4)" opacity="0.12" />
            <text v-for="p in mAxis" :key="p.x" :x="p.x" :y="p.y" font-size="10" fill="#888">{{ p.label }}</text>
          </svg>
          <div v-else class="meter-empty">暂无趋势数据</div>
        </div>

        <!-- 性能 -->
        <div class="meter-section-title">性能</div>
        <div class="meter-perf">
          <span>调用次数 <b>{{ mPerf.calls ?? 0 }}</b></span>
          <span>平均耗时 <b>{{ mPerf.avgMs ?? 0 }} ms</b></span>
          <span>总耗时 <b>{{ fmtMs(mPerf.totalMs) }}</b></span>
          <span>问答 <b>{{ fmtTok(mPerf.byScope?.chat || 0) }}</b></span>
          <span>图片识别 <b>{{ fmtTok(mPerf.byScope?.vision || 0) }}</b></span>
          <span>向量化 <b>{{ fmtTok(mPerf.byScope?.embed || 0) }}</b></span>
        </div>

        <!-- 限额与趋势窗口设置 -->
        <div class="meter-section-title">限额与趋势窗口</div>
        <div class="meter-rows" :class="{ disabled: !meterEnabled }">
          <div class="form-row">
            <span>限额周期</span>
            <select v-model="mDraft.period" :disabled="!meterEnabled">
              <option value="month">每月</option>
              <option value="week">每周</option>
            </select>
          </div>
          <div class="form-row">
            <span>限额数值</span>
            <input v-model.number="mDraft.value" type="number" min="0" :disabled="!meterEnabled" />
            <select v-model="mDraft.unit" :disabled="!meterEnabled">
              <option value="M">M（百万）</option>
              <option value="B">B（十亿）</option>
              <option value="T">T（万亿）</option>
            </select>
          </div>
          <div class="form-row">
            <span>趋势保存窗口（天）</span>
            <input v-model.number="mDraft.windowDays" type="number" min="1" max="365" :disabled="!meterEnabled" />
          </div>
          <div style="display: flex; gap: 10px; margin-top: 6px">
            <button class="primary" :disabled="meterSaving || !meterEnabled" @click="saveMeterConfig">
              <span v-if="meterSaving" class="loading"></span>保存设置
            </button>
          </div>
        </div>

        <!-- 临时增加 / 重置 -->
        <div class="meter-section-title">临时额度管理</div>
        <div class="meter-rows" :class="{ disabled: !meterEnabled }">
          <div class="form-row">
            <span>临时增加</span>
            <input v-model.number="mGrantValue" type="number" min="0" :disabled="!meterEnabled" style="width:110px" />
            <select v-model="mGrantUnit" :disabled="!meterEnabled">
              <option value="M">M</option><option value="B">B</option><option value="T">T</option>
            </select>
            <button class="small" :disabled="meterBusy || !meterEnabled" @click="doGrant">增加</button>
          </div>
          <div class="form-row">
            <span>临时重置</span>
            <button class="small" :disabled="meterBusy || !meterEnabled" @click="requestMeterAuth('reset')">重置（需密码认证）</button>
          </div>
        </div>

        <div v-if="meterMsg" class="muted" style="margin-top: 8px; font-size: 12px">{{ meterMsg }}</div>
      </div>
    </div>

    <!-- 密码认证弹窗：额度设置 / 临时增加 / 临时重置 等计量修改操作需验证当前账户密码 -->
    <div v-if="meterPwModal" class="modal-mask" @click.self="meterPwModal = false">
      <div class="modal" style="width: min(420px, 92vw)">
        <h3>密码认证</h3>
        <p class="muted" style="font-size: 13px; line-height: 1.6; margin-bottom: 12px">
          此操作需要验证当前账户密码：<strong>{{ meterPwActionLabel }}</strong>
        </p>
        <div class="pw-row">
          <WinPasswordBox v-model:Password="meterPw" :PasswordRevealMode="meterPwShow ? 'Visible' : 'Hidden'" PlaceholderText="输入当前账户密码" :Width="'100%'" @Enter="meterPwConfirm" />
          <WinCheckBox v-model:IsChecked="meterPwShow" Content="显示密码" />
        </div>
        <div v-if="meterPwErr" class="error-box" style="margin-top: 8px">{{ meterPwErr }}</div>
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px">
          <button @click="meterPwModal = false">取消</button>
          <button class="primary" :disabled="meterBusy" @click="meterPwConfirm">
            <span v-if="meterBusy" class="loading"></span>确定
          </button>
        </div>
      </div>
    </div>

    <!-- 流式输出设置弹窗：管理各功能是否启用流式输出 -->
    <div v-if="streamModal" class="modal-mask" @click.self="streamModal = false">
      <div class="modal" style="width: min(480px, 92vw)">
        <h3>流式输出设置</h3>
        <p class="muted" style="font-size: 13px; line-height: 1.7; margin-bottom: 12px">
          控制各 AI 功能是否以<strong>流式输出</strong>方式调用（流式=边生成边返回，长输出更稳健；关闭=传统一次返回）。修改后点击下方保存生效。
        </p>
        <div v-for="s in streamItems" :key="s.key" class="settings-toggle-row">
          <div class="settings-toggle-text">
            <span class="settings-toggle-title">{{ s.label }}</span>
            <span class="settings-toggle-desc">{{ s.desc }}</span>
          </div>
          <WinToggleSwitch :IsOn="streamPrefs[s.key]" @update:IsOn="streamPrefs[s.key] = $event" />
        </div>
        <div v-if="streamMsg" class="muted" style="margin: 6px 0 0; font-size: 12px">{{ streamMsg }}</div>
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px">
          <button @click="streamModal = false">取消</button>
          <button class="primary" :disabled="streamSaving" @click="saveStream">
            <span v-if="streamSaving" class="loading"></span>保存流式设置
          </button>
        </div>
      </div>
    </div>

    <!-- 数据管理操作确认：二次确认 + 验证密码（导出/导入/重启） -->
    <div v-if="dataActionModal" class="modal-mask">
      <div class="modal" style="width: min(420px, 92vw)">
        <h3>{{ dataActionTitle }}</h3>
        <p class="muted" style="font-size: 13px; line-height: 1.7; margin-bottom: 12px">{{ dataActionDesc }}</p>
        <label class="field">
          <span>密码</span>
          <div class="pw-row">
            <WinPasswordBox v-model:Password="dataPw" :PasswordRevealMode="dataPwShow ? 'Visible' : 'Hidden'" PlaceholderText="输入当前账户密码" :Width="'100%'" />
            <WinCheckBox v-model:IsChecked="dataPwShow" Content="显示密码" />
          </div>
        </label>
        <div v-if="dataErr" class="error-box" style="margin: 0 0 10px">{{ dataErr }}</div>
        <div style="display: flex; justify-content: flex-end; gap: 10px">
          <button @click="dataActionModal = false">取消</button>
          <button class="danger" :disabled="dataBusy" @click="confirmData">
            <span v-if="dataBusy" class="loading"></span>确认{{ dataActionOk }}
          </button>
        </div>
      </div>
    </div>

    <!-- 开发者选项（开发者模式开启后显示） -->
    <WinExpander v-if="devEnabled" class="settings-expander" Header="开发者选项" HeaderIcon="&#xE71D;">
      <div class="dev-actions">
        <div class="dev-row">
          <div>
            <div class="dev-title">查看详细日志</div>
            <div class="muted" style="font-size: 12px">AI 分析、流式对话等详细运行日志；弹窗查看并每 5 秒自动刷新（首页不再显示日志）</div>
          </div>
          <button @click="openLogs">打开日志</button>
        </div>
        <div class="dev-row">
          <div>
            <div class="dev-title">清空系统数据</div>
            <div class="muted" style="font-size: 12px">删除全部材料、知识图谱、错题、考试、倒计时等数据；需二次确认并输入密码</div>
          </div>
          <button class="danger" @click="openClear">清空数据</button>
        </div>
      </div>
      <div class="toolbar" style="margin-top: 12px">
        <span class="muted" style="font-size: 12px">关闭后页面将自动刷新回到普通模式。</span>
        <div class="spacer"></div>
        <button @click="closeDev">关闭开发者模式</button>
      </div>
    </WinExpander>

    <!-- 开发者模式开启弹窗：确认同意风险 + 输入密码 -->
    <div v-if="devModal" class="modal-mask">
      <div class="modal" style="width: min(430px, 92vw)">
        <h3>开启开发者模式</h3>
        <p class="muted" style="font-size: 13px; line-height: 1.7; margin-bottom: 12px">
          开发者模式将暴露系统运行详情（AI 请求、详细日志、数据明细），<b>可能造成信息泄露</b>，请确认开启。
        </p>
        <WinCheckBox v-model:IsChecked="devAgree" Content="我已了解并同意承担相关风险" />
        <label class="field" style="margin-top: 12px">
          <span>密码</span>
          <div class="pw-row">
            <WinPasswordBox v-model:Password="devPw" :PasswordRevealMode="devPwShow ? 'Visible' : 'Hidden'" PlaceholderText="输入当前账户密码" :Width="'100%'" />
            <WinCheckBox v-model:IsChecked="devPwShow" Content="显示密码" />
          </div>
        </label>
        <div v-if="devErr" class="error-box" style="margin: 0 0 10px">{{ devErr }}</div>
        <div style="display: flex; justify-content: flex-end; gap: 10px">
          <button @click="devModal = false">取消</button>
          <button class="primary" :disabled="devBusy" @click="confirmDev">
            <span v-if="devBusy" class="loading"></span>开启开发者模式
          </button>
        </div>
      </div>
    </div>

    <!-- 详细日志弹窗：每 5 秒自动刷新 -->
    <div v-if="logModal" class="modal-mask">
      <div class="modal log-modal">
        <h3>详细日志<span class="muted" style="font-size: 12px"> 每 5 秒自动刷新{{ logEntries.length ? ' · ' + logEntries.length + ' 条' : '' }}</span></h3>
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px">
          <button :disabled="logBusy" @click="refreshLogs">{{ logBusy ? '刷新中…' : '立即刷新' }}</button>
          <span v-if="logLastRefreshed" class="muted" style="font-size: 12px">更新于 {{ logLastRefreshed }}</span>
          <div class="spacer"></div>
          <button @click="closeLogs">关闭</button>
        </div>
        <pre class="log-box log-box-live">{{ logText }}</pre>
      </div>
    </div>

    <!-- 清空系统数据：二次提示后输入密码确认 -->
    <div v-if="clearModal" class="modal-mask">
      <div class="modal" style="width: min(420px, 92vw)">
        <h3>清空系统数据</h3>
        <p class="muted" style="font-size: 13px; line-height: 1.7; margin-bottom: 12px">
          将删除<strong>全部</strong>材料、知识图谱、错题、考试、练习、倒计时、知识清单、脑图与聊天记录，<strong>不可恢复</strong>。请再次输入密码确认：
        </p>
        <label class="field">
          <span>密码</span>
          <div class="pw-row">
            <WinPasswordBox v-model:Password="clearPw" :PasswordRevealMode="clearPwShow ? 'Visible' : 'Hidden'" PlaceholderText="输入当前账户密码" :Width="'100%'" />
            <WinCheckBox v-model:IsChecked="clearPwShow" Content="显示密码" />
          </div>
        </label>
        <div v-if="clearErr" class="error-box" style="margin: 0 0 10px">{{ clearErr }}</div>
        <div style="display: flex; justify-content: flex-end; gap: 10px">
          <button @click="clearModal = false">取消</button>
          <button class="danger" :disabled="clearBusy" @click="confirmClear">
            <span v-if="clearBusy" class="loading"></span>确认清空
          </button>
        </div>
      </div>
    </div>

    <!-- 修改密码弹窗：独立弹窗，带显示模式的密码框 + 新密码输入两遍验证 -->
    <div v-if="pwModal" class="modal-mask">
      <div class="modal" style="width: min(420px, 92vw)">
        <h3>修改密码</h3>
        <p class="muted" style="font-size: 12px; margin: 0 0 12px">当前账户：{{ accUser?.username || 'admin' }}</p>
        <label class="field">
          <span>当前密码</span>
          <div class="pw-row">
            <WinPasswordBox v-model:Password="pwForm.current" :PasswordRevealMode="showPwCurrent ? 'Visible' : 'Hidden'" PlaceholderText="请输入当前密码" :Width="'100%'" />
            <WinCheckBox v-model:IsChecked="showPwCurrent" Content="显示密码" />
          </div>
        </label>
        <label class="field">
          <span>新密码</span>
          <div class="pw-row">
            <WinPasswordBox v-model:Password="pwForm.next" :PasswordRevealMode="showPwNext ? 'Visible' : 'Hidden'" PlaceholderText="至少 4 位" :Width="'100%'" />
            <WinCheckBox v-model:IsChecked="showPwNext" Content="显示密码" />
          </div>
        </label>
        <label class="field">
          <span>确认新密码</span>
          <div class="pw-row">
            <WinPasswordBox v-model:Password="pwForm.confirm" :PasswordRevealMode="showPwConfirm ? 'Visible' : 'Hidden'" PlaceholderText="再次输入新密码" :Width="'100%'" />
            <WinCheckBox v-model:IsChecked="showPwConfirm" Content="显示密码" />
          </div>
        </label>
        <div v-if="pwErr" class="error-box" style="margin: 0 0 10px">{{ pwErr }}</div>
        <div style="display: flex; justify-content: flex-end; gap: 10px">
          <button @click="pwModal = false">取消</button>
          <button class="primary" :disabled="pwSaving" @click="savePassword">
            <span v-if="pwSaving" class="loading"></span>确认修改
          </button>
        </div>
      </div>
    </div>
    </Teleport>

    <!-- 更新日志弹窗 -->
    <Teleport to="body">
      <div v-if="updChangelogModal" class="modal-mask" @click.self="updChangelogModal = false">
        <div class="modal" style="width: min(560px, 92vw)">
          <h3>更新日志</h3>
          <div class="md-body" style="max-height: 60vh; overflow: auto; margin-top: 8px" v-html="md(updChangelogContent)"></div>
          <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px">
            <button @click="updChangelogModal = false">关闭</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 详细更新日志弹窗（轮询 /api/update/log：后台构建/重启命令输出） -->
    <Teleport to="body">
      <div v-if="updLogModal" class="modal-mask" @click.self="closeUpdateLog">
        <div class="modal" style="width: min(760px, 94vw)">
          <h3 style="display: flex; align-items: center; gap: 8px">
            更新日志
            <div class="spacer"></div>
            <button :disabled="updLogBusy" @click="refreshUpdateLog">
              <span v-if="updLogBusy" class="loading"></span>刷新
            </button>
            <button @click="closeUpdateLog">关闭</button>
          </h3>
          <p class="muted" style="font-size: 12px; margin-top: 4px">仅展示与本次更新相关的后台命令输出（构建/重启等）</p>
          <pre
            ref="updLogPre"
            class="md-text log-console"
            style="max-height: 60vh; overflow: auto; margin-top: 8px; white-space: pre-wrap; word-break: break-word; font-family: monospace"
            >{{ updLogContent || '（暂无日志）' }}</pre>
        </div>
      </div>
    </Teleport>

    <!-- 系统介绍（README）弹窗 -->
    <Teleport to="body">
      <div v-if="updReadmeModal" class="modal-mask" @click.self="updReadmeModal = false">
        <div class="modal" style="width: min(600px, 92vw)">
          <h3 style="display: flex; align-items: center; gap: 8px">
            系统介绍（README）
            <div class="spacer"></div>
            <button @click="updReadmeModal = false">关闭</button>
          </h3>
          <div v-if="updReadmeBusy" class="muted" style="padding: 12px 0">
            <span class="loading"></span> 加载中…
          </div>
          <div v-else-if="updReadmeMsg" class="error-box" style="margin-top: 8px">{{ updReadmeMsg }}</div>
          <div v-else class="md-body" style="max-height: 60vh; overflow: auto; margin-top: 8px" v-html="md(updReadmeContent)"></div>
        </div>
      </div>
    </Teleport>

    <!-- 更新操作弹窗（应用更新 / 强制更新 / 保存设置，通用密码确认）：需验证当前账户密码 -->
    <Teleport to="body">
      <div v-if="updModal" class="modal-mask" @click.self="closeApply">
        <div class="modal" style="width: min(440px, 92vw)">
          <h3>{{ updModalTitle }}</h3>
          <p class="muted" style="font-size: 13px; line-height: 1.7; margin-bottom: 12px">{{ updModalDesc }}</p>
          <div class="pw-row">
            <WinPasswordBox v-model:Password="updPw" :PasswordRevealMode="updPwShow ? 'Visible' : 'Hidden'" PlaceholderText="输入当前账户密码" :Width="'100%'" @Enter="confirmUpdAction" />
            <WinCheckBox v-model:IsChecked="updPwShow" Content="显示密码" />
          </div>
          <div v-if="updBusyTask" class="error-box" style="margin-top: 8px">有任务运行中，请等待完成后重试</div>
          <div v-else-if="updPwErr" class="error-box" style="margin-top: 8px">{{ updPwErr }}</div>
          <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px">
            <button @click="closeApply">取消</button>
            <button :class="updModalOkDanger ? 'danger' : 'primary'" :disabled="updApplying || updBusyCount > 0" @click="confirmUpdAction">
              <span v-if="updApplying" class="loading"></span>{{ updModalOkLabel }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { pageTransitionIndex, setPageTransition, MODES } from '../platform.js';
import WinExpander from '../winui/components/WinExpander.vue';
import WinToggleSwitch from '../winui/components/WinToggleSwitch.vue';
import WinRadioButtons from '../winui/components/WinRadioButtons.vue';
import WinRadioButton from '../winui/components/WinRadioButton.vue';
import WinDatePicker from '../winui/components/WinDatePicker.vue';
import WinTimePicker from '../winui/components/WinTimePicker.vue';
import WinPasswordBox from '../winui/components/WinPasswordBox.vue';
import WinCheckBox from '../winui/components/WinCheckBox.vue';
import WinProgressBar from '../winui/components/WinProgressBar.vue';
import { api } from '../api.js';
import { parseLocalDate, fmtDate, parseTimeStr, fmtTimeHM, renderMarkdown } from '../util.js';
const md = renderMarkdown;
import { winConfirm, winAlert } from '../dialogs.js';

// ---- 账户信息（顶部，Windows 11 设置 > 账户 风格）----
const accUser = ref(null);
const accForm = reactive({ username: '' });
const accSaving = ref(false);
const accMsg = ref('');
const accErr = ref(false);
const initial = computed(() => (accUser.value?.username || 'admin').charAt(0).toUpperCase());

// 右侧系统信息（版本 + 内存占用）
const sysInfo = ref(null);

async function loadSysInfo() {
  try {
    sysInfo.value = await api.monitor();
  } catch {
    sysInfo.value = null;
  }
}

// 修改密码：独立弹窗，密码框旁"显示密码"勾选框控制明文/密文，新密码输入两遍校验
const pwModal = ref(false);
const pwSaving = ref(false);
const pwErr = ref('');
const pwForm = reactive({ current: '', next: '', confirm: '' });
const showPwCurrent = ref(false);
const showPwNext = ref(false);
const showPwConfirm = ref(false);

async function loadAccount() {
  try {
    const d = await api.me();
    accUser.value = d.user;
  } catch {
    accUser.value = null;
  }
}

async function saveAccount() {
  if (!accForm.username.trim()) {
    accErr.value = true;
    accMsg.value = '请输入新的用户名';
    return;
  }
  accSaving.value = true;
  accMsg.value = '';
  accErr.value = false;
  try {
    await api.updateAccount({ username: accForm.username.trim() });
    await loadAccount();
    accForm.username = '';
    accMsg.value = '用户名已更新';
  } catch (e) {
    accErr.value = true;
    accMsg.value = (e.response?.data?.error) || e.message || '保存失败';
  } finally {
    accSaving.value = false;
  }
}

function openPasswordModal() {
  pwForm.current = '';
  pwForm.next = '';
  pwForm.confirm = '';
  showPwCurrent.value = false;
  showPwNext.value = false;
  showPwConfirm.value = false;
  pwErr.value = '';
  pwModal.value = true;
}

async function savePassword() {
  pwErr.value = '';
  if (!pwForm.current) {
    pwErr.value = '请输入当前密码';
    return;
  }
  if (!pwForm.next) {
    pwErr.value = '请输入新密码';
    return;
  }
  if (pwForm.next.length < 4) {
    pwErr.value = '新密码长度至少 4 位';
    return;
  }
  if (pwForm.next !== pwForm.confirm) {
    pwErr.value = '两次输入的新密码不一致';
    return;
  }
  pwSaving.value = true;
  try {
    await api.updateAccount({ currentPassword: pwForm.current, newPassword: pwForm.next });
    pwModal.value = false;
    pwForm.current = '';
    pwForm.next = '';
    pwForm.confirm = '';
    winAlert({ title: '提示', message: '密码已修改，下次登录请使用新密码。' });
  } catch (e) {
    pwErr.value = (e.response?.data?.error) || e.message || '修改失败';
  } finally {
    pwSaving.value = false;
  }
}

// ---- 开发者模式 ----
const devEnabled = ref(false);
const sysFlash = ref('');
const sysClicks = ref([]);
const devModal = ref(false);
const devAgree = ref(false);
const devPw = ref('');
const devPwShow = ref(false);
const devBusy = ref(false);
const devErr = ref('');
const logModal = ref(false);
const logEntries = ref([]);
const logBusy = ref(false);
const logLastRefreshed = ref('');
let logTimer = null;
const clearModal = ref(false);
const clearPw = ref('');
const clearPwShow = ref(false);
const clearBusy = ref(false);
const clearErr = ref('');

async function loadDev() {
  try {
    const d = await api.devStatus();
    devEnabled.value = !!d.enabled;
  } catch {
    devEnabled.value = false;
  }
}

// 系统信息行：点击产生一闪即过的动画；连点 5 次"系统版本"触发开发者模式弹窗
function onSysRow(key) {
  sysFlash.value = '';
  requestAnimationFrame(() => {
    sysFlash.value = key;
  });
  clearTimeout(sysFlash._t);
  sysFlash._t = setTimeout(() => {
    if (sysFlash.value === key) sysFlash.value = '';
  }, 350);
  if (key === 'osVersion') {
    const now = Date.now();
    sysClicks.value = sysClicks.value.filter((t) => now - t < 3000);
    sysClicks.value.push(now);
    if (sysClicks.value.length >= 5) {
      sysClicks.value = [];
      devModal.value = true;
    }
  }
}

async function confirmDev() {
  devErr.value = '';
  if (!devAgree.value) {
    devErr.value = '请先勾选"我已了解并同意承担相关风险"';
    return;
  }
  if (!devPw.value) {
    devErr.value = '请输入密码';
    return;
  }
  devBusy.value = true;
  try {
    await api.devEnable(devPw.value);
    devModal.value = false;
    devAgree.value = false;
    devEnabled.value = true;
    devPw.value = '';
  } catch (e) {
    devErr.value = (e.response?.data?.error) || e.message || '开启失败';
  } finally {
    devBusy.value = false;
  }
}

async function closeDev() {
  try {
    await api.devDisable();
    devEnabled.value = false;
  } catch {
    /* 即使失败也回到普通模式 */
  }
  location.reload();
}

const logText = computed(() =>
  logEntries.value
    .slice()
    .reverse()
    .map((l) => {
      const t = (l.time || '').slice(11, 19);
      const extra = l.extra !== undefined ? `\n    详情: ${JSON.stringify(l.extra)}` : '';
      return `[${t}] [${l.level}] ${l.msg}${extra}`;
    })
    .join('\n')
);

async function refreshLogs() {
  if (logBusy.value) return;
  logBusy.value = true;
  try {
    const d = await api.getLogs();
    logEntries.value = (d.logs || []).slice(-200);
    logLastRefreshed.value = new Date().toLocaleTimeString();
  } catch {
    /* 拉取失败静默 */
  } finally {
    logBusy.value = false;
  }
}

function openLogs() {
  logModal.value = true;
  refreshLogs();
  clearInterval(logTimer);
  logTimer = setInterval(refreshLogs, 5000);
}

function closeLogs() {
  logModal.value = false;
  clearInterval(logTimer);
  logTimer = null;
}

function openClear() {
  winConfirm({
    title: '清空系统数据',
    message: '确定要清空全部数据吗？此操作不可恢复。'
  }).then((ok) => {
    if (!ok) return;
    clearPw.value = '';
    clearErr.value = '';
    clearModal.value = true;
  });
}

async function confirmClear() {
  clearErr.value = '';
  if (!clearPw.value) {
    clearErr.value = '请输入密码';
    return;
  }
  clearBusy.value = true;
  try {
    await api.devClearData(clearPw.value);
    clearModal.value = false;
    winAlert({ title: '已完成', message: '已清空系统数据，即将刷新页面。' }).then(() => location.reload());
  } catch (e) {
    clearErr.value = (e.response?.data?.error) || e.message || '清空失败';
  } finally {
    clearBusy.value = false;
  }
}

const info = ref(null);
const form = reactive({
  'ai.baseUrl': '', 'ai.apiKey': '', 'ai.chatModel': '', 'ai.backupModel': '',
  'ai.retryCount': '1', 'ai.embedModel': '', 'ai.visionModel': '',
  'study.autoAnalyze': 'on', 'lists.aiAutocreate': 'off', 'graph.aiModifySubGraphs': 'on'
});
const error = ref('');
const saving = ref(false);
const testing = ref(false);
const testResult = ref(null);
const models = ref([]);
const pageLoading = ref(true);
const fetchingModels = ref(false);
const autoAnalyze = ref(true);
const listsAutocreate = ref(false);
const modifySubGraphs = ref(true);

// 流式输出设置（AI 加油站等 7 项）
const STREAM_ITEMS = [
  { key: 'qa', label: 'AI 问答', desc: '智能问答长回答边生成边返回' },
  { key: 'vision', label: '图片识别', desc: '材料/错题图片的 AI 视觉识别' },
  { key: 'encourage', label: 'AI 加油站', desc: '首页倒计时旁的学习鼓励语生成' },
  { key: 'embed', label: '向量化', desc: '材料片段 Embedding 向量化（语义检索）' },
  { key: 'summary', label: 'AI 概括', desc: '材料概览 / 统一汇总生成' },
  { key: 'classify', label: 'AI 分类', desc: '材料科目 / 分册 / 类型分类' },
  { key: 'graph', label: 'AI 知识图谱生成整理', desc: '知识抽取、并入图谱与结构优化' }
];
const streamItems = STREAM_ITEMS;
const streamModal = ref(false);
const streamSaving = ref(false);
const streamMsg = ref('');
const streamPrefs = reactive({ qa: true, vision: true, encourage: true, embed: true, summary: true, classify: true, graph: true });

function openStreamModal() {
  streamMsg.value = '';
  streamModal.value = true;
}

async function saveStream() {
  streamMsg.value = '';
  streamSaving.value = true;
  try {
    const values = {};
    for (const s of STREAM_ITEMS) values[`stream.${s.key}`] = streamPrefs[s.key] ? 'on' : 'off';
    await api.saveSettings(values);
    streamMsg.value = '流式设置已保存';
    setTimeout(() => { streamModal.value = false; }, 600);
  } catch (e) {
    streamMsg.value = (e.response?.data?.error) || e.message || '保存失败';
  } finally {
    streamSaving.value = false;
  }
}

// ---------- Token 计量 ----------
const meterEnabled = ref(true);
const meterModal = ref(false);
const meterStatus = ref(null);
const meterSaving = ref(false);
const meterBusy = ref(false);
const meterMsg = ref('');
const mGrantValue = ref(0);
const mGrantUnit = ref('M');
const mDraft = reactive({ period: 'month', value: 0, unit: 'M', windowDays: 30 });
// 统一密码认证弹窗：额度设置 / 临时增加 / 临时重置
const meterPwModal = ref(false);
const meterPw = ref('');
const meterPwShow = ref(false);
const meterPwErr = ref('');
const pendingMeterAction = ref(null);
const METER_PW_LABELS = { config: '保存限额与趋势窗口设置', grant: '临时增加额度', reset: '临时重置（取消全部临时增加）' };
const meterPwActionLabel = computed(() => METER_PW_LABELS[pendingMeterAction.value] || '');

const mTotal = computed(() => meterStatus.value?.totals?.all || 0);
const mToday = computed(() => meterStatus.value?.totals?.today || 0);
const mCycle = computed(() => meterStatus.value?.totals?.cycle || 0);
const mCycleShare = computed(() => meterStatus.value?.totals?.cycleShare);
const mGrant = computed(() => meterStatus.value?.grantTokens || 0);
const mWindowDays = computed(() => meterStatus.value?.config?.windowDays ?? 30);
const mTrend = computed(() => meterStatus.value?.trend || []);
const mPerf = computed(() => meterStatus.value?.perf || {});
const mPoints = computed(() => chartPolyline(mTrend.value));
const mArea = computed(() => {
  const pts = mPoints.value;
  if (!pts.length) return '';
  const first = String(pts[0]).split(',').slice(0, 2).join(',');
  return `${first} ${pts.join(' ')} 620,178 0,178`;
});
const mAxis = computed(() => {
  const t = mTrend.value;
  if (t.length <= 1) return [];
  const w = 620, hTop = 14, hBottom = 178;
  return t.map((d, i) => ({ x: i === 0 ? 0 : (i / (t.length - 1)) * w, y: hBottom + 12, label: (d.date || '').slice(5) }));
});

function fmtTok(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K';
  return String(n);
}
function fmtMs(ms) {
  ms = Number(ms) || 0;
  if (ms >= 60000) return (ms / 60000).toFixed(1) + ' min';
  return ms + ' ms';
}
function chartPolyline(trend) {
  if (!trend || trend.length < 2) return '';
  const w = 620, hTop = 14, hBottom = 172;
  const max = Math.max(...trend.map((d) => d.total || 0), 1);
  return trend.map((d, i) => {
    const x = i === 0 ? 0 : (i / (trend.length - 1)) * w;
    const y = hBottom - ((d.total || 0) / max) * (hBottom - hTop);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

async function onMeterToggle(val) {
  meterEnabled.value = val;
  try {
    await api.saveUsagemeter({ enabled: val });
    if (val) await refreshMeter();
  } catch (e) {
    meterEnabled.value = !val;
    meterMsg.value = (e.response?.data?.error) || e.message || '切换失败';
  }
}

async function refreshMeter() {
  try {
    meterStatus.value = await api.getUsagemeter();
    meterEnabled.value = !!meterStatus.value?.enabled;
    if (meterStatus.value?.config) {
      mDraft.period = meterStatus.value.config.period;
      mDraft.value = meterStatus.value.config.value;
      mDraft.unit = meterStatus.value.config.unit;
      mDraft.windowDays = meterStatus.value.config.windowDays;
    }
  } catch (e) {
    meterMsg.value = (e.response?.data?.error) || e.message || '加载失败';
  }
}

async function openMeter() {
  meterMsg.value = '';
  meterModal.value = true;
  await refreshMeter();
}

async function saveMeterConfig() {
  requestMeterAuth('config');
}

async function doGrant() {
  if (!(Number(mGrantValue.value) > 0)) { meterMsg.value = '请输入要临时增加的额度和单位'; return; }
  requestMeterAuth('grant');
}

// 请求密码认证：弹出独立密码认证弹窗，验证通过后再执行对应计量修改操作
function requestMeterAuth(action) {
  meterPw.value = '';
  meterPwErr.value = '';
  pendingMeterAction.value = action;
  meterPwModal.value = true;
}

async function meterPwConfirm() {
  if (!meterPw.value) { meterPwErr.value = '请输入密码'; return; }
  meterBusy.value = true;
  meterPwErr.value = '';
  try {
    await api.verifyPassword(meterPw.value);
    await runMeterAction(pendingMeterAction.value);
    meterPw.value = '';
    meterPwModal.value = false;
  } catch (e) {
    meterPwErr.value = (e.response?.data?.error) || e.message || '认证失败';
  } finally {
    meterBusy.value = false;
  }
}

async function runMeterAction(action) {
  switch (action) {
    case 'config':
      await api.saveUsagemeter({
        period: mDraft.period,
        value: Number(mDraft.value) || 0,
        unit: mDraft.unit,
        windowDays: Number(mDraft.windowDays) || 30
      });
      meterMsg.value = '计量设置已保存（已验证）';
      break;
    case 'grant':
      await api.usagemeterGrant(Number(mGrantValue.value), mGrantUnit.value);
      meterMsg.value = '已临时增加额度';
      mGrantValue.value = 0;
      break;
    case 'reset':
      await api.usagemeterReset();
      meterMsg.value = '已临时重置（取消全部临时增加）';
      break;
  }
  await refreshMeter();
}

// 页面切换动画模式（platform.js 持久化；模板用 transitionIndex 单选）
const transitionIndex = pageTransitionIndex;
const transitionModes = MODES;

function onTransitionChanged({ SelectedIndex }) {
  const mode = MODES[SelectedIndex];
  if (mode) setPageTransition(mode.value);
}

const countdowns = ref([]);
const cdForm = reactive({ title: '', date: '', time: '08:00:00' });
const cdDateModel = computed({
  get: () => parseLocalDate(cdForm.date),
  set: (d) => { cdForm.date = d ? fmtDate(d) : ''; }
});
const cdTimeModel = computed({
  get: () => parseTimeStr(cdForm.time),
  set: (t) => { cdForm.time = t ? `${fmtTimeHM(t)}:00` : ''; }
});

const exporting = ref(false);
const importing = ref(false);
const showPm2 = ref(false);
const pm2 = ref(null);

// 数据管理操作：二次确认 + 验证密码（导出/导入/重启；PM2 配置除外）
const dataActionModal = ref(false);
const dataAction = ref('');
const dataPw = ref('');
const dataPwShow = ref(false);
const dataBusy = ref(false);
const dataErr = ref('');
const dataImportFile = ref(null);

const DATA_ACTIONS = {
  export: { title: '导出全部数据', desc: '将打包全部数据（数据库、图谱、图片、学习数据与 .env 配置）下载到本地。确定继续？', ok: '导出' },
  import: { title: '导入数据', desc: '导入将覆盖当前全部数据并自动重启服务，此操作不可撤销。确定继续？', ok: '导入' },
  restart: { title: '重启服务', desc: '将中断当前所有正在进行的任务并重启服务，确定继续？', ok: '重启' }
};

const dataActionTitle = computed(() => DATA_ACTIONS[dataAction.value]?.title || '数据操作确认');
const dataActionDesc = computed(() => DATA_ACTIONS[dataAction.value]?.desc || '');
const dataActionOk = computed(() => DATA_ACTIONS[dataAction.value]?.ok || '');

function openDataAction(action) {
  if (!DATA_ACTIONS[action]) return;
  dataAction.value = action;
  dataPw.value = '';
  dataPwShow.value = false;
  dataErr.value = '';
  dataActionModal.value = true;
}

async function confirmData() {
  dataErr.value = '';
  if (!dataPw.value) {
    dataErr.value = '请输入密码';
    return;
  }
  dataBusy.value = true;
  try {
    await api.verifyPassword(dataPw.value);
  } catch (e) {
    dataErr.value = (e.response?.data?.error) || e.message || '密码验证失败';
    dataBusy.value = false;
    return;
  }
  dataBusy.value = false;
  dataActionModal.value = false;
  dataPw.value = '';
  const action = dataAction.value;
  if (action === 'export') doExport();
  else if (action === 'import') doImport();
  else if (action === 'restart') doRestart();
}

async function load() {
  info.value = await api.getSettings();
  form['ai.baseUrl'] = info.value.ai.baseUrl || '';
  form['ai.apiKey'] = info.value.values['ai.apiKey'] || '';
  form['ai.chatModel'] = info.value.ai.chatModel || '';
  form['ai.backupModel'] = info.value.ai.backupModel || '';
  form['ai.retryCount'] = String(info.value.ai.retryCount || 1);
  form['ai.embedModel'] = info.value.ai.embedModel || '';
  form['ai.visionModel'] = info.value.ai.visionModel || '';
  form['study.autoAnalyze'] = (info.value.values['study.autoAnalyze'] || 'on');
  form['lists.aiAutocreate'] = (info.value.values['lists.aiAutocreate'] || 'off');
  form['graph.aiModifySubGraphs'] = (info.value.values['graph.aiModifySubGraphs'] || 'on');
  autoAnalyze.value = form['study.autoAnalyze'] === 'on';
  listsAutocreate.value = form['lists.aiAutocreate'] === 'on';
  modifySubGraphs.value = form['graph.aiModifySubGraphs'] === 'on';
  // 流式输出偏好
  const st = info.value.ai?.stream || {};
  for (const s of STREAM_ITEMS) streamPrefs[s.key] = st[s.key] !== false;
  const sv = info.value.values || {};
  for (const s of STREAM_ITEMS) {
    if (sv[`stream.${s.key}`] !== undefined) streamPrefs[s.key] = sv[`stream.${s.key}`] === 'on';
  }
  meterEnabled.value = info.value.values?.['meter.enabled'] === 'on';
  countdowns.value = (await api.listCountdowns()).items;
}

async function save() {
  saving.value = true;
  error.value = '';
  try {
    const values = { ...form };
    values['study.autoAnalyze'] = autoAnalyze.value ? 'on' : 'off';
    values['lists.aiAutocreate'] = listsAutocreate.value ? 'on' : 'off';
    values['graph.aiModifySubGraphs'] = modifySubGraphs.value ? 'on' : 'off';
    await api.saveSettings(values);
    await load();
    winAlert({ title: '提示', message: '设置已保存到 .env' });
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await api.testAI();
  } catch (e) {
    error.value = e.message;
  } finally {
    testing.value = false;
  }
}

async function fetchModels() {
  fetchingModels.value = true;
  try {
    const r = await api.models();
    models.value = r.items || [];
    if (!models.value.length) winAlert({ title: '提示', message: '未获取到模型列表（请确认 base_url 支持 /models 接口）' });
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  } finally {
    fetchingModels.value = false;
  }
}

function fmtTarget(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

async function addCountdown() {
  if (!cdForm.title.trim() || !cdForm.date) {
    winAlert({ title: '提示', message: '请填写标题与日期' });
    return;
  }
  const time = cdForm.time || '00:00:00';
  await api.createCountdown({ title: cdForm.title.trim(), targetTime: `${cdForm.date}T${time}` });
  cdForm.title = '';
  countdowns.value = (await api.listCountdowns()).items;
}

async function delCountdown(c) {
  if (!(await winConfirm({ title: '删除确认', message: `删除倒计时「${c.title}」？`, danger: true }))) return;
  await api.deleteCountdown(c.id);
  countdowns.value = (await api.listCountdowns()).items;
}

async function doExport() {
  exporting.value = true;
  try {
    const res = await api.exportData();
    if (!res.ok) throw new Error('导出失败 ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `knowlodge-backup-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  } finally {
    exporting.value = false;
  }
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  dataImportFile.value = file;
  openDataAction('import');
}

async function doImport() {
  const file = dataImportFile.value;
  if (!file) return;
  importing.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await api.importData(fd);
    winAlert({ title: '提示', message: r.message || '数据包已接收，服务正在重启…' });
    setTimeout(() => location.reload(), 3500);
  } catch (err) {
    winAlert({ title: '操作失败', message: err.message });
    importing.value = false;
  } finally {
    dataImportFile.value = null;
  }
}

async function doRestart() {
  try {
    const r = await api.restartSystem();
    winAlert({ title: '提示', message: r.message || '正在重启…' });
    setTimeout(() => location.reload(), 3000);
  } catch (e) {
    winAlert({ title: '操作失败', message: e.message });
  }
}

async function loadPm2() {
  try {
    pm2.value = await api.pm2Info();
  } catch {
    /* ignore */
  }
}

// ---- 版本与更新 ----
const updStatus = ref(null);
const updStatusError = ref('');
const updChecking = ref(false);
const updMsg = ref('');
const updErr = ref(false);
const updSaved = ref(false);
const updLoaded = ref(false);
const updRepo = ref('');
const updProxyUrl = ref('');
const updUseProxy = ref(false);
const updInterval = ref(24);
const updAutoMode = ref('notify');
const updMethod = ref('incremental');
const updDiff = ref(null);
const updDiffBusy = ref(false);
const updApplying = ref(false);
const updApplySuccess = ref('');
// 通用密码确认弹窗：应用更新 / 强制更新 / 保存设置
const updModal = ref(false);
const pendingUpdAction = ref('');
const updPw = ref('');
const updPwShow = ref(false);
const updPwErr = ref('');
const updBusyTask = ref(false);
// 更新日志 / 系统介绍弹窗
const updChangelogModal = ref(false);
const updReadmeModal = ref(false);
const updReadmeBusy = ref(false);
const updReadmeContent = ref('');
const updReadmeMsg = ref('');
// 实时更新进度（触发更新后轮询 /update/status 的 progress）
const updProgress = ref(null);
let updProgressTimer = null;
// 更新完成后自动刷新页面（服务重启恢复后 location.reload()）
const updAutoReload = ref(false);
// 防抖：只有进度确实进入过“运行中”之后结束，才允许自动刷新（避免应用启动瞬间误触发）
const updSawRunning = ref(false);
// 详细更新日志（轮询 /api/update/log）
const updLogModal = ref(false);
const updLogContent = ref('');
const updLogBusy = ref(false);
let updLogTimer = null;
const updLogPre = ref(null);

const updLocal = computed(() => updStatus.value?.local || {});
const updLastCheck = computed(() => updStatus.value?.lastCheck || null);
const updLastResult = computed(() => updStatus.value?.lastResult || null);
const updBusyCount = computed(() => updStatus.value?.busy || 0);
const updHasUpdate = computed(() => !!updLastCheck.value?.hasUpdate);

// 通用密码弹窗的标题 / 描述 / 按钮文案与危险样式（强制更新为 danger）
const updModalTitle = computed(() => ({
  apply: '应用更新',
  force: '强制更新',
  save: '保存设置'
}[pendingUpdAction.value] || '更新操作'));
const updModalDesc = computed(() => {
  if (pendingUpdAction.value === 'apply') {
    return `将更新至新版本${updLastCheck.value?.remoteVersion ? ' ' + updLastCheck.value.remoteVersion : ''}（${updMethodConfigLabel.value}）。输入当前账户密码确认：`;
  }
  if (pendingUpdAction.value === 'force') {
    return '强制更新将不做任何检查，直接从仓库拉取完整包覆盖本地代码（无论仓库是否一致）。确认后输入当前账户密码：';
  }
  if (pendingUpdAction.value === 'save') {
    return '保存仓库地址、代理、更新间隔与自动更新策略。输入当前账户密码确认：';
  }
  return '';
});
const updModalOkLabel = computed(() => ({
  apply: '确定更新',
  force: '确定强制更新',
  save: '确定保存'
}[pendingUpdAction.value] || '确定'));
const updModalOkDanger = computed(() => pendingUpdAction.value === 'force');

const updChangelogContent = computed(() => updLocal.value.changelog || updLastCheck.value?.changelog || '（暂无更新日志）');

// 实时更新进度
const updProgressShown = computed(() => !!updProgress.value && updProgress.value.running !== false);
const updProgressPercent = computed(() => Math.min(100, Math.max(0, Number(updProgress.value?.percent) || 0)));
const updProgressIndeterminate = computed(() => updProgressShown.value && updProgress.value.percent == null);
const updProgressMessage = computed(() => updProgress.value?.message || (updProgress.value?.step ? `正在${updProgress.value.step}` : ''));

// 详细更新日志内容更新时自动滚动到底部
watch(updLogContent, () => {
  if (updLogModal.value && updLogPre.value) {
    updLogPre.value.scrollTop = updLogPre.value.scrollHeight;
  }
});

const updMethodOptions = [
  { value: 'incremental', label: '增量对比' },
  { value: 'full', label: '完整替换' }
];
const updAutoOptions = [
  { value: 'notify', label: '仅检测提醒' },
  { value: 'download', label: '检测并下载' },
  { value: 'auto', label: '直接完成更新' }
];
const updMethodIndex = computed(() => {
  const i = updMethodOptions.findIndex((o) => o.value === updMethod.value);
  return i < 0 ? 0 : i;
});
const updAutoIndex = computed(() => {
  const i = updAutoOptions.findIndex((o) => o.value === updAutoMode.value);
  return i < 0 ? 0 : i;
});
const updMethodConfigLabel = computed(() => {
  const o = updMethodOptions.find((item) => item.value === updMethod.value);
  return o ? o.label : updMethod.value;
});

function onUpdMethodChanged({ SelectedIndex }) {
  const o = updMethodOptions[SelectedIndex];
  if (o) updMethod.value = o.value;
}
function onUpdAutoChanged({ SelectedIndex }) {
  const o = updAutoOptions[SelectedIndex];
  if (o) updAutoMode.value = o.value;
}

async function refreshUpdateStatus() {
  try {
    const s = await api.getUpdateStatus();
    updStatus.value = s;
    updStatusError.value = '';
    const c = s?.config;
    if (c) {
      if (!updLoaded.value) {
        updRepo.value = c.repo || '';
        updUseProxy.value = !!c.proxy;
        updInterval.value = c.intervalHours ?? 24;
        updAutoMode.value = c.autoMode || 'notify';
        updMethod.value = c.method || 'incremental';
        updLoaded.value = true;
      }
      updProxyUrl.value = c.proxy || '';
    }
  } catch (e) {
    updStatusError.value = (e.response?.data?.error) || e.message || '加载更新状态失败';
  }
}

async function checkUpdate() {
  if (updChecking.value) return;
  updChecking.value = true;
  updMsg.value = '';
  updErr.value = false;
  updDiff.value = null;
  try {
    await api.checkUpdate();
    await refreshUpdateStatus();
  } catch (e) {
    updErr.value = true;
    updMsg.value = (e.response?.data?.error) || e.message || '检查更新失败';
  } finally {
    updChecking.value = false;
  }
}

async function viewDiff() {
  if (updDiffBusy.value) return;
  updDiffBusy.value = true;
  updMsg.value = '';
  updErr.value = false;
  try {
    updDiff.value = await api.getUpdateDiff();
  } catch (e) {
    updErr.value = true;
    updMsg.value = (e.response?.data?.error) || e.message || '获取更新文件失败';
  } finally {
    updDiffBusy.value = false;
  }
}

// 保存设置：现在需先弹密码框验证，验证通过后写回（POST /api/update/settings 需 password）
function saveUpdateSettings() {
  openUpdAction('save');
}

function openApply() {
  openUpdAction('apply');
}

function forceUpdate() {
  openUpdAction('force');
}

function openUpdAction(action) {
  updPw.value = '';
  updPwShow.value = false;
  updPwErr.value = '';
  updBusyTask.value = false;
  updApplySuccess.value = '';
  pendingUpdAction.value = action;
  updModal.value = true;
}

function closeApply() {
  if (updApplying.value) return;
  updModal.value = false;
}

async function confirmUpdAction() {
  if (!updPw.value) {
    updPwErr.value = '请输入密码';
    return;
  }
  updApplying.value = true;
  updPwErr.value = '';
  updBusyTask.value = false;
  let failed = false;
  try {
    const action = pendingUpdAction.value;
    if (action === 'apply') await applyUpdateRun(updPw.value, false);
    else if (action === 'force') await applyUpdateRun(updPw.value, true);
    else if (action === 'save') await saveUpdateSettingsRun(updPw.value);
  } catch (e) {
    failed = true;
    const msg = (e.response?.data?.error) || e.message || '';
    const action = pendingUpdAction.value;
    if (action === 'apply' || action === 'force') {
      if (/运行中|正在运行/.test(msg)) {
        updBusyTask.value = true;
        updPwErr.value = '';
        await refreshUpdateStatus();
      } else if (/密码/.test(msg)) {
        updPwErr.value = msg || '密码验证失败';
      } else {
        updPwErr.value = msg || '应用更新失败';
      }
    } else {
      // save
      if (/密码/.test(msg)) {
        updPwErr.value = msg || '密码验证失败';
      } else {
        updErr.value = true;
        updMsg.value = msg || '保存设置失败';
      }
    }
  } finally {
    updApplying.value = false;
  }
  if (!failed && !updPwErr.value) {
    updPw.value = '';
    updModal.value = false;
  }
}

async function applyUpdateRun(pw, force) {
  const payload = { password: pw, method: updMethod.value };
  const lc = updLastCheck.value;
  if (lc?.remoteVersion) payload.targetVersion = lc.remoteVersion;
  if (lc?.changelog) payload.changelog = lc.changelog;
  if (force) payload.force = true;
  // 先启动轮询：下载/解压/替换/重启全阶段实时显示进度（含下载速度）
  startUpdateProgress();
  let r;
  try {
    r = await api.applyUpdate(payload);
  } catch (e) {
    stopUpdateProgress();
    updProgress.value = null;
    throw e;
  }
  if (r?.skipped) {
    updApplySuccess.value = r.message || '已跳过：本地已与仓库一致';
    stopUpdateProgress();
    updProgress.value = null;
    await refreshUpdateStatus();
    return;
  }
  updAutoReload.value = true;
  updApplySuccess.value = force
    ? (r?.message || '强制更新已开始，正在拉取最新代码…')
    : `更新已开始${r?.method ? `（${r.method}` : ''}${r?.version ? ` ${r.version}` : ''}${r?.method ? '）' : ''}，可在后台日志查看进度。`;
  await refreshUpdateStatus();
}

async function saveUpdateSettingsRun(pw) {
  updSaved.value = false;
  updErr.value = false;
  updMsg.value = '';
  const r = await api.saveUpdateSettings({
    repo: updRepo.value.trim(),
    proxy: updUseProxy.value ? updProxyUrl.value.trim() : '',
    intervalHours: Number(updInterval.value) || 0,
    autoMode: updAutoMode.value,
    method: updMethod.value,
    password: pw
  });
  if (r && r.error) throw new Error(r.error);
  updSaved.value = true;
  await refreshUpdateStatus();
}

// ---- 实时更新进度：轮询 /update/status 的 progress ----
function startUpdateProgress() {
  stopUpdateProgress();
  refreshUpdateProgress();
  updProgressTimer = setInterval(refreshUpdateProgress, 1500);
}

async function refreshUpdateProgress() {
  try {
    const s = await api.getUpdateStatus();
    if (!s) return;
    updStatus.value = s;
    const p = s.progress;
    if (p && p.running === true) updSawRunning.value = true; // 曾真正进入运行态
    // 关键修复：空闲(null/初始 idle)时绝不停止轮询——
    // 否则更新刚发起那一瞬读到 null 就会停掉定时器，下载阶段进度条永不出现且不再更新
    if (p && p.running === false && updSawRunning.value) {
      // 更新确实运行过且已结束 → 停止轮询；若本次成功发起则等待服务恢复后自动刷新
      stopUpdateProgress();
      updProgress.value = null;
      if (updAutoReload.value) { updAutoReload.value = false; autoReloadAfterUpdate(); }
      return;
    }
    updProgress.value = (p && p.running === true) ? p : null;
  } catch {
    /* 忽略瞬时失败，等待下一轮轮询 */
  }
}

function stopUpdateProgress() {
  if (updProgressTimer) {
    clearInterval(updProgressTimer);
    updProgressTimer = null;
  }
}

// ---- 更新完成自动刷新页面：服务重启后 /health 恢复时 location.reload() ----
async function autoReloadAfterUpdate() {
  for (let i = 0; i < 60; i++) {
    try {
      const resp = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        location.reload();
        return;
      }
    } catch {
      /* 服务尚未恢复，继续等待 */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  location.reload();
}

// ---- 详细更新日志：打开弹窗即开始轮询 /api/update/log，关闭/卸载时停止 ----
function openUpdateLog() {
  updLogModal.value = true;
  refreshUpdateLog();
  startUpdateLogPoll();
}

function closeUpdateLog() {
  updLogModal.value = false;
  stopUpdateLogPoll();
}

function startUpdateLogPoll() {
  stopUpdateLogPoll();
  updLogTimer = setInterval(refreshUpdateLog, 1500);
}

function stopUpdateLogPoll() {
  if (updLogTimer) {
    clearInterval(updLogTimer);
    updLogTimer = null;
  }
}

async function refreshUpdateLog() {
  if (updLogBusy.value) return;
  updLogBusy.value = true;
  try {
    const r = await api.getUpdateLog();
    if (r && typeof r.content === 'string') {
      updLogContent.value = r.content;
      nextTick(() => {
        if (updLogPre.value) updLogPre.value.scrollTop = updLogPre.value.scrollHeight;
      });
    }
  } catch {
    /* 忽略瞬时失败，保留上次内容，下一轮轮询重试 */
  } finally {
    updLogBusy.value = false;
  }
}

// ---- 更新日志 / 系统介绍弹窗 ----
function openUpdChangelog() {
  updChangelogModal.value = true;
}

async function openUpdReadme() {
  updReadmeModal.value = true;
  updReadmeMsg.value = '';
  updReadmeContent.value = '';
  if (updReadmeBusy.value) return;
  updReadmeBusy.value = true;
  try {
    const r = await api.getUpdateReadme();
    updReadmeContent.value = (r && r.content) || '';
    if (!updReadmeContent.value) updReadmeMsg.value = '暂无可用的系统介绍。';
  } catch (e) {
    updReadmeMsg.value = (e.response?.data?.error) || e.message || '加载系统介绍失败';
  } finally {
    updReadmeBusy.value = false;
  }
}

onMounted(() => {
  loadAccount();
  loadSysInfo();
  loadDev();
  refreshUpdateStatus();
  Promise.all([load(), loadPm2()])
    .catch(() => {})
    .finally(() => {
      pageLoading.value = false;
    });
});

onUnmounted(() => {
  clearInterval(logTimer);
  stopUpdateProgress();
  stopUpdateLogPoll();
});
</script>