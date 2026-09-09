# vision-proxy：结构化 Schema 与视觉通道 Prompt 模板

> 本文件由 `SKILL.md` 引用。包含首过描述的统一骨架、各 image_type 的 `structure` 分型细则、路线 A/B 的 prompt 模板、追问循环规则。
> 视觉模型的全部 prompt 都从本文件装配；`SKILL.md` 不重复定义 schema。

---

## 1. Schema 总框架（首过描述必填）

所有图片首过描述统一返回以下骨架，Markdown 格式：

```markdown
## IMAGE ANALYSIS RESULT
- image_path: <绝对路径>
- image_type: error_screenshot | ui_mockup | architecture_diagram | data_chart | photo | other
- summary: <一句话概括，≤ 50 字>
- transcription: <完整文字转录；无文字则写 NONE>
- structure: <按 image_type 分型输出，详见 §2>
- visual_details: <无法结构化但有信息量的视觉细节>
- uncertainties: <识别不清 / 可能出错的部分；无则写 NONE>
```

**强制规则**：
1. 先输出 `image_type`，再按对应分型输出 `structure`；分类错误比描述粗糙更致命。
2. `uncertainties` 字段必须存在；它是主模型发起追问的触发器，不允许省略。
3. `transcription` 一律逐字转录，禁止改写、概括、修正原文（包括标点与大小写）。
4. 不要输出 schema 之外的内容；多图场景每张图一段，重复使用本骨架。

---

## 2. 分型 `structure` 细则

### 2.1 `error_screenshot`（报错 / 日志 / 堆栈截图）

- `transcription` 必须**逐字完整**：错误码、异常类型、堆栈帧（文件路径 + 行号）、错误消息。
- `structure` 输出三段：
  - **错误类型**：`<异常类名>: <错误消息>（若有）`，否则描述现象（如"窗口无可见文字"）。
  - **根因帧定位**：`<文件路径>:<行号>，函数 <func>，语句 <code>`。
  - **调用链摘要**：从根因向上回溯 3–5 帧（`<module>` → `main()`(line N) → ...）。
- 堆栈超过 20 帧：完整保留前 5 帧与所有**用户代码帧**（非 framework 帧），中间 framework 帧压缩为一行 `... N framework frames omitted ...`。
- 截图只显示了**部分**堆栈（顶部或底部被裁切）：在 `uncertainties` 显式说明"图片底部 / 顶部被截断，无法判断的异常类型或行号"。

### 2.2 `ui_mockup`（UI 截图 / 设计稿）—— 主场景

> 用户已确认：图片绝大多数是项目前端截图（设计稿、线上页面、报错态、弹窗、组件细节）。`image_type` 难以判断时默认按 `ui_mockup` 处理。

#### 2.2.1 先判定子类型（在 `structure` 开头用一行标签）

| 子类型 | 判定线索 |
|---|---|
| `design_mockup` | 设计稿导出（Figma / Sketch / XD），画面干净，无浏览器 chrome、无地址栏、无滚动条、无真实数据 |
| `live_page` | 真实页面截图（含浏览器 chrome、地址栏、滚动条、真实业务数据） |
| `live_page_with_devtools` | 浏览器开发者工具处于打开状态（Elements / Console / Network 面板可见） |

`live_page_with_devtools` 截图里的**控制台报错**视同 `error_screenshot` 规则——逐字转录到 `transcription`；其它结构仍按 `ui_mockup` 描述。

#### 2.2.2 `structure`：组件层级树（缩进文本）

每个节点标注三件事：组件类型 / 文字内容 / 相对位置。例：

```
- Page (背景 #F5F7FA)
  - Card (白底圆角, 居中, w≈640px)
    - Title (H1, 文本 "欢迎回来", 卡片顶部左对齐)
    - Subtitle (Text, 文本 "登录以继续使用工作台", 标题正下方)
    - Form (垂直堆叠)
      - Field (邮箱)
        - Label (Text, "邮箱")
        - Input (占位符 "请输入邮箱", 描边圆角, 高度≈56px)
      - Field (密码)
        - Label (Text, "密码")
        - Input (占位符 "请输入密码", 描边圆角)
      - Button (主色实心, 文本 "登 录", 全宽, 主色≈#3B82F6)
      - Link (Text, "忘记密码？", 主色蓝, 按钮下方左对齐)
```

层级深度通常 3–5 层即可，避免无限下钻到像素。

#### 2.2.3 `visual_details` 必填项

- **主色调近似 hex**（背景 / 卡片 / 主操作 / 文本四档至少给出）。
- **布局模式线索**：flex / grid / 绝对定位 / 居中 / 全宽 / 自适应等能从图里看出来的特征。
- **字号层级**：标题 / 副标题 / 正文 / 标签 / 占位符的相对大小（用 px 区间描述优于瞎猜）。
- **间距相对关系**："按钮间距约为字高的 1.5 倍"、"标题→副标题 ≈ 8px，副标题→首个 Label ≈ 32px"这类**相对描述**优先于像素数值。

#### 2.2.4 前端场景增量字段（能辨认则写，辨认不出写入 `uncertainties`，禁止硬猜）

- **可辨认的 UI 框架线索**：Element Plus / Ant Design / Tailwind / shadcn / 自研 等风格特征（如"Tailwind 蓝 ≈#3B82F6 + 圆角 8–12px"或"Ant Design 风格 24×24 图标按钮 + 圆角 2px"）。
- **响应式线索**：移动端 / 桌面端 / 自适应断点。
- **页面状态**：加载中 / 空态 / 错误态 / 弹窗遮罩 / Toast。
- **图标 / 表情**：可识别含义的写出来，识别不出写"abstract icon, meaning unclear"。

#### 2.2.5 交互状态

能在图里看出来的（hover 高亮 / 禁用灰 / 选中态 / focus 描边）显式标注。无则不写。

#### 2.2.6 分类困难时的默认规则

`image_type` 难判时按 `ui_mockup` 处理，理由：当前项目以代码 / 前端为主，UI 截图是最常见类型。

### 2.3 `architecture_diagram`（架构图 / 流程图 / 拓扑图）

`structure` 输出**两张清单**：

```
nodes:
  - id: A
    label: "用户"
    type: user
  - id: B
    label: "xdpi 数据面"
    type: data-plane
    ...
edges:
  - from: A
    to: B
    label: "NDJSON"
    style: solid
  - from: B
    to: C
    label: "打分结果"
    style: dashed
  ...
```

同时**优先用 Mermaid 语法重表达整张图**（`flowchart LR` / `graph TD` / `sequenceDiagram`），写在一个 Mermaid 代码块里。虚线 / 实线 / 双向箭头需区分并在 `uncertainties` 标注置信度（"双向箭头可能是单向"）。

### 2.4 `data_chart`（柱状 / 折线 / 饼图 / 散点）

- `structure` 包含：图表类型 / 坐标轴（含义 + 单位）/ 数据系列 / 关键拐点。
- 数据**转录为 Markdown 表格**（或 CSV）。
- 数据点过密（> 20 点）时：转录关键拐点 + 趋势结论，并在 `uncertainties` 标注"非全量转录"。

### 2.5 `photo` / `other`

自由描述 + OCR，`structure` 从简：

- `photo`：`structure` 写场景 / 主体 / 关键元素 / 文字内容（如有）。
- `other`：`structure` 写"非标准图像类型" + 自由文字描述。

---

## 3. Schema 使用规则（再次强调）

1. 视觉模型**必须先分类再输出** `structure`；
2. `uncertainties` 字段是追问触发器，**必须存在**；
3. `transcription` 逐字，禁止改写；
4. 视觉模型**不输出任何 schema 之外的内容**（不写"以下是我看到的..."之类的开场白）；
5. 多图：每张图独立一段 `## IMAGE ANALYSIS RESULT`，并在段首用 `-- image 1/2` 这种标签提示关联顺序。

---

## 4. Route A：子代理 Prompt 模板

主代理在自身无视觉能力时使用。子代理必须能用工具读取本地图片文件（如本平台的 Read 工具接受绝对路径直接显示图片内容）。

```
你是视觉分析子代理。读取图片文件：<image_path>。
（多图时：读取图片文件 1：<image_path_1>；读取图片文件 2：<image_path_2>。请按顺序分析，并在每段用 "-- image i/N" 标记。）

任务背景：<主模型提供的 2–3 句任务上下文，让视觉模型知道该关注什么>。

按以下 schema 输出，不要输出任何 schema 之外的内容：

【schema 总框架 + image_type 全集】
（粘贴 §1 的骨架 + §2.1–2.5 各分型名称列表）

要求：
1. 先判断 image_type，再按对应分型输出 structure；
2. transcription 逐字转录，禁止改写、概括、修正原文；
3. 不确定的内容写入 uncertainties，禁止猜测；
4. ui_mockup 必须先区分子类型（design_mockup / live_page / live_page_with_devtools）；
5. classification 困难时默认按 ui_mockup 处理。
```

**子代理返回值即为主模型消费的转写文本**——直接追加到主上下文，不做二次包装。

---

## 5. Route B：外部视觉 API 调用

### 5.1 脚本位置

`<skill-dir>/scripts/vision.js`（Node ≥ 18，零第三方依赖；详见 SKILL.md §5.2）。

### 5.2 调用约定

主代理在调用前**先准备 prompt 文本文件**（把 §4 的模板填好，存为 `vision-prompt.txt`），然后用脚本：

```bash
# 单图
node scripts/vision.js /path/to/img.png --prompt-file vision-prompt.txt

# 多图（前后关联，必须一次调用）
node scripts/vision.js a.png b.png --prompt-file vision-prompt.txt

# 指定模型 / 自建网关
node scripts/vision.js img.png \
  --prompt-file vision-prompt.txt \
  --model qwen-vl-max \
  --api-base https://dashscope.aliyuncs.com/compatible-mode/v1 \
  --format openai

# Anthropic
node scripts/vision.js img.png \
  --prompt-file vision-prompt.txt \
  --api-base https://api.anthropic.com \
  --model claude-sonnet-4-5 \
  --format anthropic
```

**配置来源**（优先级从高到低）：
1. 命令行 flag（`--api-key` / `--api-base` / `--model` / `--format`）
2. 进程环境变量
3. 当前工作目录下的 `.env`（仅在环境变量未设置时生效）
4. 内置默认值（`VISION_API_BASE` 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`，`VISION_MODEL` 默认 `qwen-vl-max`）

`.env` 样例：

```bash
VISION_API_KEY=sk-xxxxxxxxxxxxxxxxxxxx
VISION_MODEL=qwen-vl-max
# VISION_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
# VISION_API_FORMAT=auto
# VISION_MAX_TOKENS=4096
```

### 5.3 推荐配置

| 场景 | 推荐组合 |
|---|---|
| 国内可访问、低成本 | 阿里云百炼 OpenAI 兼容端点 + `qwen-vl-max`（默认） |
| 国际通用 | OpenAI `/v1/chat/completions` + `gpt-4o` |
| Anthropic 直连 | `https://api.anthropic.com` + `claude-sonnet-4-5` + `--format anthropic` |
| DashScope 原生 SDK 协议 | `https://dashscope.aliyuncs.com` + `--format dashscope`（自动检测） |

### 5.4 退出码约定

| 退出码 | 含义 | 主代理（SKILL.md §3.3）应做 |
|---|---|---|
| 0 | 成功，stdout 是转写文本 | 追加到上下文 |
| 1 | 硬错误（网络 / HTTP / 不支持的图） | 切换到路线 A 或重试 1 次 |
| 2 | 用法错误（缺 key / 缺 prompt） | 告知用户配置 |
| 3 | 模型 4 次重试仍报"no image" | 提示用户换网关或换 `VISION_API_FORMAT` |
| 4 | 模型返回空 | 重试 1 次（换措辞），仍失败则放弃 |

### 5.5 Prompt 模板（写入 `vision-prompt.txt`）

把 §4 的子代理 prompt 模板的"任务背景"和"schema"两段原样写入文件，再加上：开头一段**明确告知**模型"以下 N 张图片，路径列表：..."。避免模型在多图场景里混淆顺序。

---

## 6. 追问循环（Follow-up）

**何时发起追问**（满足任一即追问，不要猜测）：

1. `uncertainties` 字段非空且影响主任务决策。
2. 写代码需要的具体参数缺失（颜色 hex、像素尺寸、精确文案、完整路径）。
3. `transcription` 中存在影响正确性的歧义（同形异义词、字符识别存疑）。
4. `structure` 的子类型判定影响后续处理（如 "这是设计稿还是线上页面？" 决定要不要查 CSS 源码）。

**追问 prompt 模板**（追加调用，**不要**重发全量 schema）：

```
基于上一轮对此图片的转写结果，请只回答以下问题，不要重述全图：

<image_path>: <具体问题 1>
<可选：image_path>: <具体问题 2>

已知上下文（避免重复）：<把首过的 summary + structure 摘要 20 行内塞进来>
```

**约束**：

- 每次追问只问少数问题；问题尽量可机器验证（"按钮背景 hex 是多少"而非"按钮好不好看"）。
- 追问回答**追加**到原 `vision-transcripts/<file>.md` 的 `## FOLLOW-UPS` 区块（按 `Q1/A1, Q2/A2` 编号），不要新建文件。
- 主模型在主上下文里只追加"问答对"（几十 token），不重复整张图的全量描述。

---

## 7. 与 SKILL.md 的对应关系

| 规格 | 在本文件的位置 |
|---|---|
| §4 Schema 总框架 | §1 |
| §4.2 分型细则 | §2 |
| §5.1 路线 A prompt 模板 | §4 |
| §5.2 路线 B 实现细节 + 改造点 | §5 |
| 追问循环 | §6 |

`SKILL.md` 引用本文档为"细则文件"；如本文件与 `SKILL.md` 冲突，以本文件为准（schema 是 skill 的核心资产，主流程只在 SKILL.md）。
