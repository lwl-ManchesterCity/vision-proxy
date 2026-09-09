# vision-proxy

> 给任何"无视觉能力"的编程主模型装上眼睛——不换主模型、不改上下文。
> A drop-in skill for Claude Code / MiniMax Code that gives any text-only coding
> model the ability to "see" pasted images, dropped screenshots, and image URLs.

[English version (older, shorter) is preserved below for reference.](#english-version-shorter)

---

## 这是什么

`vision-proxy` 是一个 **Claude Code skill**（也可用于 MiniMax Code 等兼容框架）。它解决一个具体问题：

> 你的 Claude Code 主模型是 GLM、Qwen、Coder-LLaMA 或任何**没有原生视觉能力**的文本模型。你在终端里贴了一张报错截图、拖了一张设计稿、或手敲了一个图片路径——但模型只能看到一段 `[Image #1]` 文字占位，**真的图它看不到**。

vision-proxy 在模型看到你的消息**之前**，用 `UserPromptSubmit` hook 同步地把图转写成结构化文本，注入到主上下文。模型拿到的不是原图，但**足够它回答你关于图的问题**。整个过程对模型透明，对你也透明（每条回复开头都有 `[已转写]` 状态行）。

### 关键特性

- **同步转写**——hook 在消息送达模型前完成，不阻塞用户输入
- **结构化输出**——`image_type` / `transcription` / `structure` / `uncertainties`，不是散文
- **缓存命中**——同一张图只转写一次，结果按 sha1 跨会话复用
- **追问机制**——对细节存疑时只问几十 token 的 Q&A，不重发全量描述
- **硬性反幻觉**——hook 不可能跳过 API 调用"假装"转写；每次回复带审计块
- **零依赖**——`vision.js` 用 Node ≥ 18 内置的 `fetch`，不需要 `npm install`
- **可换底座**——默认 DashScope `qwen-vl-max`，可换成任何 OpenAI 兼容的视觉 API（Moonshot / StepFun / Zhipu / OpenRouter / 自建 vLLM）

---

## 为什么做这个

作者用的是 Claude Code + 自定义 GLM 端点（GLM 5.3 系列，文本专精但没有视觉）。日常工作里常常需要给模型看：

- 报错截图（特别是 GUI 应用、浏览器报错、前端样式问题）
- 设计稿（设计师发的 UI mockup，要复刻）
- 架构图（同事画的 whiteboard 照片）
- 数据图表（运营给的 Excel 截图）

切到原生多模态模型要付出代价（贵、慢、或者单纯没额度）。**vision-proxy 让"轻量文本模型 + 按需调视觉 API"成为默认配置**。

---

## 核心机制

### 整体流程

```
   你贴了图 / 拖了文件 / 手敲了路径
              │
              ▼
   ┌─────────────────────────────────────┐
   │ Claude Code / MiniMax Code          │
   │ UserPromptSubmit hook 触发          │
   │ (120s 同步，超时即放弃)             │
   └──────────────┬──────────────────────┘
                  │
                  ▼
   ┌─────────────────────────────────────┐
   │ vision-hook.js                      │
   │                                     │
   │ 1. 从 prompt 文本里抓图片路径/URL   │
   │ 2. 如果是 [Image #N]（粘贴图）       │
   │    → 从 hook payload 拿 base64     │
   │    → 或从 transcript 还原          │
   │ 3. base64 解码到 vision-transcripts/│
   │    tmp/ 下的本地 jpg/png 文件      │
   │ 4. 调 vision.js（Route B）          │
   │ 5. 把结构化转写注入主上下文         │
   └──────────────┬──────────────────────┘
                  │
                  ▼
   ┌─────────────────────────────────────┐
   │ vision.js  (Route B)                │
   │                                     │
   │ · OpenAI 兼容的 /chat/completions   │
   │ · 多模态模型（如 qwen-vl-max）       │
   │ · 接收 base64 图片 + schema prompt  │
   │ · 返回结构化 JSON-ish 文本          │
   │ · 可选: 压缩 >1568px 长边的图       │
   │   (macOS sips / 否则原图+警告)      │
   └──────────────┬──────────────────────┘
                  │
                  ▼
   ┌─────────────────────────────────────┐
   │ 主模型                              │
   │                                     │
   │ 看到: 你的 prompt + 注入的转写块    │
   │ 输出: [已转写] 状态行 + 真实回答     │
   │ 询问细节: 走追问机制（只问几十 token）│
   └─────────────────────────────────────┘
```

### 路线 A vs 路线 B

| 路线 | 何时用 | 现状 |
|---|---|---|
| **路线 A** — 子代理路由 | 主模型支持的端点能调多模态子代理 | **默认关闭**。Claude Code 框架级子代理继承主模型 key + 模型，纯文本主模型调子代理也没视觉。**只有聚合网关能换子代理模型时才用**。本仓库未配置路线 A 验证。 |
| **路线 B** — 外部视觉 API | 配置了 `VISION_API_KEY` | **默认走这条**。`scripts/vision.js` 直接调 `VISION_API_BASE`（默认 DashScope）上的多模态模型。 |

### 触发信号

skill 会被以下任一信号自动加载（来自 `SKILL.md` 的 frontmatter `description` 字段）：

- 用户消息含图片（粘贴、上传、拖拽）
- 消息含本地图片绝对路径（含 `~/Desktop/...`、`/tmp/...` 等）
- 消息含 `http://` / `https://` 图片 URL
- 出现 `Saved attachments:` 列表
- 用户说"看 / 分析 / 识别这张截图"、"按截图还原"、"这是不是 bug"

**不**触发：纯文字、emoji、ASCII art、已是 base64 嵌入的占位资源。

### 缓存机制

每个图片按 **sha1** 索引（`shasum -a 1`）。命中顺序：

1. 同一个 `cwd` 下 `<cwd>/vision-transcripts/*.md` 的 frontmatter `image_sha1` 字段
2. 命中即复用该文件的 `## FIRST PASS` 段，不再调视觉 API
3. 未命中才调 `vision.js`

这意味着：**跨会话复用**——你在 A 项目看过的图，搬到 B 项目也得重传一次 sha1，但 B 项目里再发同图秒级命中。

### 追问机制

`uncertainties` 字段非空时，**必须**追问而不是猜测（反幻觉规则）。追问只问具体问题（"登录按钮的背景 hex 多少？"），不是"帮我再仔细看看"。追问回答**追加**到原 `## FOLLOW-UPS` 区块，按 `Q1/A1` 编号，不新建文件。主上下文只追加几十 token 的 Q&A，不重复全量描述。

### 审计块（反幻觉硬约束）

每次转写后，回复里**必须**包含一个 `<vision-proxy-audit>` 块，列出：

- 通道（Route A 子代理 / Route B 外部 API）
- 模型名 + API base
- 实际执行的命令（含 vision.js 路径）
- 退出码
- **视觉通道原始返回（逐字，禁止改写）**

**省略审计块 = 流程违规**。这是用户区分"真调了视觉 API"和"模型又在编"的唯一依据。

### 反幻觉守卫

skill 强制两条铁律（背景：2026-09 测试中，LongCat 2.0 纯文本端点曾把一张 KPL 海报绘声绘色编成"VS Code Diff 编辑器"——具体到代码结构、变更性质、表格布局，全部幻觉）：

1. **`[已转写]` 只在视觉 API 真的被调用并返回非空结果时才输出**。hook 同步阻塞，模型无法"模拟"流程跳过调用。
2. **审计块包含完整原始返回**，人类能直接核验通道真的被调过。

---

## 安装

### 方式 1：用户级安装（所有项目可用）

```bash
git clone https://github.com/lwl-ManchesterCity/vision-proxy.git
mkdir -p ~/.claude/skills
cp -r vision-proxy ~/.claude/skills/vision-proxy
```

### 方式 2：项目级安装（仅当前项目）

```bash
git clone https://github.com/lwl-ManchesterCity/vision-proxy.git
mkdir -p .claude/skills
cp -r vision-proxy .claude/skills/vision-proxy
```

### 方式 3：从 GitHub 装用户级（推荐）

```bash
# 1. 装 skill 目录
git clone https://github.com/lwl-ManchesterCity/vision-proxy.git /tmp/vision-proxy
mkdir -p ~/.claude/skills
cp -r /tmp/vision-proxy ~/.claude/skills/vision-proxy
rm -rf /tmp/vision-proxy

# 2. 装 hook（注册到 settings.json）
# 把以下加到 ~/.claude/settings.json 的 hooks 字段：
#   "UserPromptSubmit": [{
#     "hooks": [{
#       "type": "command",
#       "command": "node /Users/lwl/.claude/skills/vision-proxy/hooks/vision-hook.js",
#       "timeout": 120
#     }]
#   }]

# 3. 配凭证（见下节）
```

### 验证安装

启动 Claude Code，贴一张图。回复开头应该看到：

```
[已转写] xxx.png → vision-transcripts/2026-09-09-144927-xxx.md
```

如果看到的是 `[转写失败]` 或 `[未转写]`，去 `~/.claude/skills/vision-proxy/hooks/hook-debug.log` 末尾几行找原因（参考 `docs/TROUBLESHOOTING.md`）。

---

## 配置

### 最小配置（DashScope 默认可跑）

```bash
cd ~/.claude/skills/vision-proxy
cp .env.example scripts/.env
# 编辑 scripts/.env，把 VISION_API_KEY 换成你的 DashScope key
```

### 各家 API 适配

**DashScope（默认）**：
```bash
VISION_API_KEY=sk-...
VISION_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_MODEL=qwen-vl-max
```

**Moonshot Kimi（OpenAI 兼容）**：
```bash
VISION_API_KEY=sk-...
VISION_API_BASE=https://api.moonshot.cn/v1
VISION_MODEL=moonshot-v1-8k-vision-preview  # 或当前支持的视觉模型
```

**StepFun**：
```bash
VISION_API_KEY=...
VISION_API_BASE=https://api.stepfun.com/v1
VISION_MODEL=step-1v-8k
```

**OpenRouter**（聚合多模型）：
```bash
VISION_API_KEY=sk-or-...
VISION_API_BASE=https://openrouter.ai/api/v1
VISION_MODEL=anthropic/claude-3.5-sonnet  # 或 google/gemini-pro-vision
```

**自建 vLLM / Ollama 兼容端点**：
```bash
VISION_API_KEY=anything  # 一些本地服务不校验 key
VISION_API_BASE=http://localhost:8000/v1
VISION_MODEL=Qwen2-VL-7B-Instruct  # 或任何已部署的多模态模型
```

### 凭证查找顺序

`scripts/vision.js` 按以下顺序找 `VISION_API_KEY`：

1. `process.env.VISION_API_KEY`（shell / Claude Code env）
2. `./.env`（调用方的 cwd，**项目级覆盖**）
3. `scripts/.env`（skill 默认 fallback）

这意味着你可以：

- 在 skill 默认配置里用 DashScope
- 在某个项目里用 `echo 'VISION_API_KEY=sk-...' > /path/to/project/.env` 覆盖

**`scripts/.env` 在 `.gitignore` 里，永远不会被 push。**

### 如果你的主模型已经有原生视觉

设 `VISION_NATIVE_VISION=1` 让 skill 整体休眠（hook 静默不做事）。**设置前必须人工验证**——让主模型描述 `assets/canary.png` 里的内容，对比图片实际内容。完全一致才设；说错、说漏、编造任何细节都不要设（详见 `SKILL.md` §0）。

---

## 使用场景

### 场景 1：粘图（剪贴板）

```
[Image #1]
```

hook 会从 session transcript 还原 base64 并转写。**注意**：Claude Code 写 transcript 可能有延迟（实测 v2.1.220 达 18s），hook 会轮询 60s 等写入完成。

### 场景 2：拖文件到终端

```
[Image: source: /Users/lwl/Desktop/screenshot.png]
```

（实际是用户拖文件，CLI 渲染成这个标记。）hook 抓路径走 file 模式，立即读盘 + sha1 + 转写。

### 场景 3：手敲路径

```
看看 /tmp/error.png 这个报错
```

hook 抓 `/tmp/error.png`，转写。

### 场景 4：图片 URL

```
https://example.com/diagram.png 这张图怎么理解？
```

hook 下载 + 转写。

### 场景 5：Saved attachments 列表

有些框架把上传图片列在 `Saved attachments:` 下。hook 会扫这个列表。

### 场景 6：缓存命中

```
❯ /Users/lwl/Desktop/screenshot.png
[已转写·缓存命中] screenshot.png → vision-transcripts/...
```

毫秒级返回。

---

## 输出格式

每条回复开头一行状态标记（5 种变体）：

```
[已转写] xxx.png → vision-transcripts/2026-09-09-144927-xxx.md
[已转写·缓存命中] xxx.png → vision-transcripts/...
[未转写] xxx.png → 原因（原生视觉可用 / 与任务无关 / 通道不可用）
[转写失败] xxx.png → 原因摘要
[追问] xxx.png → 第 N 轮（已追加到 vision-transcripts/<file>.md）
```

多图：每张一行。状态行**必须出现在正文之前**，方便一眼判断"它看没看我的图"。

紧随其后是 `<vision-proxy-audit>` 块，列出通道/模型/命令/退出码/原始返回。

之后才是主模型基于转写内容的真实回答。

---

## 持久化目录

`<cwd>/vision-transcripts/` 下的 `.md` 文件，命名 `YYYY-MM-DD-HHMMSS-<原名>.md`：

```markdown
---
image_path: /abs/path/xxx.png
image_sha1: <sha1 十六进制>
image_type: ui_mockup
vision_channel: B(API, qwen-vl-max)
created: 2026-09-09T14:49:27+08:00
---

## FIRST PASS
<首过结构化输出全文（视觉模型 stdout 逐字）>

## FOLLOW-UPS
### Q1: 按钮背景 hex？
A1: ...
### Q2: ...
```

**`vision-transcripts/` 在 `.gitignore` 里**——含敏感截图的转写（比如含 token、密码的报错截图），不应入仓。

**建议**：你 clone vision-proxy 后也把 `vision-transcripts/` 加到你主项目的 `.gitignore` 里。

---

## 降级策略

以下任务**不适合**结构化转写，skill 会主动告诉用户"建议切到原生多模态模型"：

1. **像素级 UI 复刻**（精确间距 / 色值）——视觉通道返回的 hex / 尺寸是近似描述，不是像素采样
2. **密集小字图片**（满屏代码截图 / 大表格截图）——OCR 准确率与上下文长度不可兼得
3. **视觉审美判断**（"哪个配色更好看"）——结构化 schema 本身不覆盖

这三种情况请直接用原生多模态模型（`/model` 切到支持视觉的）。

---

## 故障排查

常见问题详细排查见 [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)。简版：

| 症状 | 原因 | 修法 |
|---|---|---|
| `[转写失败] xxx.png → 视觉通道调用失败` | `VISION_API_KEY` 没配 / key 错 / API 限流 | 配 key / 等 / 换模型 |
| `[转写失败] xxx.png → harness classifier 阻断` | Claude Code 的 Bash 安全分类器挂 | 等几秒重发 / 在主模型设置里换分类器模型 |
| 60s 后还没看到 `[已转写]` | hook 在等 transcript 写入 / 在调视觉 API | 等等；如果持续挂，去 `hook-debug.log` 看 |
| 拿到的是上一张图的转写 | 同 session 多图时 Image #N 错配（已修） | 现在不应发生，如果发生升级 vision-proxy |
| `globs` 失败 / `permission denied` | hook 路径写错 / Node 找不到 | 检查 `~/.claude/settings.json` 的 hooks 段 |

---

## 仓库结构

```
vision-proxy/
├── SKILL.md                  ← skill 规格（模型读这份，frontmatter 自动加载）
├── README.md                 ← 你正在看（人读这份）
├── LICENSE                   ← MIT
├── .env.example              ← 凭证模板（无 key）
├── .gitignore                ← 排除 .env / vision-transcripts/ / debug log
│
├── references/
│   └── schemas.md            ← 结构化输出 schema 各分型细则
│
├── scripts/
│   ├── vision.js             ← Route B 视觉 API 调用（Node ≥ 18，零依赖）
│   └── .env.example          ← skill 内部凭证模板副本
│
├── hooks/
│   ├── vision-hook.js        ← UserPromptSubmit hook（同步，120s timeout）
│   ├── prompt-template.txt   ← hook 装配的 schema prompt 模板
│   └── hook-debug.log        ← 运行时日志（gitignored）
│
├── assets/
│   └── canary.png            ← 验证主模型视觉能力的金丝雀图
│
└── docs/
    ├── TROUBLESHOOTING.md    ← 详细故障排查
    └── CHANGELOG.md          ← 版本与关键事件
```

---

## 开发与自测

### 端到端自测 hook

```bash
# 1. 构造一个 payload 喂给 hook
echo '{"prompt":"[Image #1]","cwd":"/tmp","transcript_path":"/nonexistent"}' | \
  node hooks/vision-hook.js

# 应该看到 60s 等 transcript 然后放弃
# 2. 看 debug log
tail -20 hooks/hook-debug.log
```

### 端到端自测 vision.js

```bash
VISION_API_KEY=sk-... \
VISION_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 \
VISION_MODEL=qwen-vl-max \
node scripts/vision.js /path/to/test.png --prompt-file hooks/prompt-template.txt
```

### 端到端自测缓存

发同一张图两次：第一次转写（10-30s），第二次秒级命中（`[已转写·缓存命中]`）。

---

## 贡献

PR / issue 都欢迎。但有几条原则：

1. **不要破坏反幻觉守卫**——审计块、状态行、`## FIRST PASS` 逐字保留是底线
2. **schema 是核心资产**——改 `references/schemas.md` 之前先开 issue 讨论
3. **新增依赖是大事**——`vision.js` 现在零依赖，加 `package.json` 之前先论证必要性
4. **PR 自带自测记录**——新增/改动核心逻辑（hook 抓图、vision.js 调用、schema 解析）请附端到端测试输出

---

## License

MIT. 见 [LICENSE](./LICENSE)。

---

## English Version (Shorter)

> A drop-in skill for Claude Code / MiniMax Code that gives any text-only coding model the ability to "see" pasted images, dropped screenshots, and image URLs.

The skill runs a synchronous `UserPromptSubmit` hook that decodes any
image the user attaches, calls an external multimodal model (default
`qwen-vl-max` via DashScope), and injects a structured schema response
back into the main context before the main model sees the prompt. The
main model never needs native vision.

**Why**: keep a strong text-only coding model (GLM / Qwen / Coder-LLaMA)
as the default; pay for vision only when an image is actually attached.

**Install**:
```bash
git clone https://github.com/lwl-ManchesterCity/vision-proxy.git
cp -r vision-proxy ~/.claude/skills/vision-proxy
cp ~/.claude/skills/vision-proxy/.env.example \
   ~/.claude/skills/vision-proxy/scripts/.env
# fill in VISION_API_KEY
```

**Hook registration** in `~/.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "node /Users/lwl/.claude/skills/vision-proxy/hooks/vision-hook.js",
        "timeout": 120
      }]
    }]
  }
}
```

**Docs**: [TROUBLESHOOTING](./docs/TROUBLESHOOTING.md) ·
[CHANGELOG](./docs/CHANGELOG.md) · [SKILL spec](./SKILL.md)
