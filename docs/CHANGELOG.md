# Changelog

按时间倒序。每个版本标注**新增 / 修复 / 内部**三类。

---

## v0.2.0 — 2026-09-09

开源首版。功能稳定但仍在演进。

### 新增

- **详细中文 README**（含完整架构图、路线 A vs B、缓存机制、追问机制、审计块、降级策略、各家 API 适配示例）
- **`docs/TROUBLESHOOTING.md`** — 12 节详细故障排查（按症状分组）
- **`docs/CHANGELOG.md`** — 本文件
- **`.env.example`** — 凭证模板（不含真实 key）
- **`.gitignore`** — 排除 `scripts/.env` / `vision-transcripts/` / `hooks/hook-debug.log`
- **`LICENSE`** — MIT
- **公开 GitHub repo**: https://github.com/lwl-ManchesterCity/vision-proxy

### 修复

- **Hook transcript 等待从 1.6s spin-wait 扩到 60s 纯 polling**：Claude Code v2.1.220 把 user record 写到 transcript 文件的 fsync 延迟最高 18s，老 hook 等 1.6s 就放弃，60s polling 覆盖所有 fsync 延迟场景
- **去掉 fs.watchFile，改用纯 polling**：macOS 上 `fs.watchFile` 对跨进程 append 不可靠（基于 mtime 触发，append 后 mtime 可能未刷新），polling 100% 可靠
- **加 Image #N 编号严格匹配**：transcript 里有多个 user record 含 image 块时，hook 必须只匹配当前 prompt 编号的 record，避免老 record 被错当新图
- **加 60s age 窗口**：candidate record 的 timestamp 超过 60s 视为过期（之前去掉 600s 校验矫枉过正，导致 4.5 分钟前的图被当当前图用）
- **加 payload shape dlog**：hook 入口打印 Claude Code 实际传的 payload 字段（key 不会打印，只看 keys + sizes），方便 debug
- **加 stdin payload key 字符脱敏**：dlog 不打印 base64 内容，只打长度和 media_type

### 内部

- **拆 `extractPastedImages` 为三层**：
  1. 路径 A：payload inline image blocks（部分 Claude Code 版本支持）
  2. 路径 B：transcript 还原（所有版本都支持）
  3. 路径 C：粘贴图还原失败时注入"指令"（让模型自己跑 vision.js）
- **拆 `decodeBlocks` 为独立 helper**：路径 A 和 B 共用 base64 → 本地文件解码逻辑

---

## v0.1.0 — 2026-09-08

首次可用版本。从 `~/Desktop/vision-proxy/` 独立目录开发，9/8 装到 `~/.claude/skills/vision-proxy/`。

### 新增

- `SKILL.md` — skill 规格（frontmatter 自动加载）
- `references/schemas.md` — 结构化输出 schema（image_type / transcription / structure / uncertainties）
- `scripts/vision.js` — Route B 视觉 API 调用
  - 零第三方依赖（Node ≥ 18 内置 `fetch`）
  - 多图输入（一个 request 多个 image content part）
  - 长边 > 1568px 压缩（macOS `sips`，否则原图 + 警告）
  - `.env` + 环境变量双配置
  - 启发式无图重试 4×（模型偶尔"看不到"图）
  - 通用瞬态重试 2×（5xx / 429 / 网络错误）
  - HTTP(S) URL 图片自动下载 + base64 内联
- `hooks/vision-hook.js` — UserPromptSubmit hook
  - 同步阻塞（120s timeout）
  - 路径提取（手敲 / 拖文件 / URL / Saved attachments）
  - 剪贴板粘贴图还原（从 session transcript 拿 base64）
  - sha1 缓存命中检测
  - 视觉 API 调用 + 持久化
  - 状态行 + 审计块 + 追问机制
- `assets/canary.png` — 金丝雀图（人工验证主模型视觉能力）
- `hooks/prompt-template.txt` — schema prompt 模板
- `hooks/hook-debug.log` — 运行时日志（gitignored）

### 已知问题

- transcript fsync 延迟（v0.1 修复）
- transcript 多 record 时错配（v0.1 部分修复，v0.2 完全修复）

---

## 关键事件时间线

| 时间 | 事件 |
|---|---|
| **2026-09-08** | 首次跑通。在 WorkBuddy 实施方会话环境验证路线 A（子代理读图）可行。 |
| **2026-09-08** | LongCat 2.0 幻觉事件：纯文本端点把 KPL 海报编成"VS Code Diff 编辑器"。**实证了"模型自评视觉能力"不可靠**，守卫改用 `VISION_NATIVE_VISION` 用户声明制 + 金丝雀图人工验证。 |
| **2026-09-08** | 路线 B 首跑合规性事件：状态行 `[已转写]` 出现但缺持久化文件路径、输出散文而非 schema、整盘无 `vision-transcripts/`。**新增 §3.3 审计块**作为用户核验通道真实性的强制接口。 |
| **2026-09-09 11:19** | 主模型切到 GLM-5.3 后 400 "Model only support text input"。**根因不是缺 skill，而是 hook 在 transcript fsync 延迟下放弃抓图**。 |
| **2026-09-09 13:44** | hook 抓到 4.5 分钟前的 KPL 海报错当 [Image #2] 用。**触发 Image #N 编号严格匹配修复**。 |
| **2026-09-09 14:01** | session transcript 整个文件 12 分钟内未创建，hook 60s 等不到。**已知边界 case，用户重发可解**。 |
| **2026-09-09 15:00** | 4 次重试 vision.js 全被 harness 分类器挂（glm-5.3-flash 临时不可用）。**外部故障，跟 skill 无关**。 |
| **2026-09-09 15:13** | 开源到 GitHub：https://github.com/lwl-ManchesterCity/vision-proxy |
