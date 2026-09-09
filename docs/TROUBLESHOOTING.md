# 故障排查

按"症状 → 排查 → 修法"组织。读完任一节没解决，请把
`~/.claude/skills/vision-proxy/hooks/hook-debug.log` 末尾 20 行贴给
Claude Code 或维护者。

---

## 0. 怎么打开 debug 日志

```bash
tail -50 ~/.claude/skills/vision-proxy/hooks/hook-debug.log
```

每条记录前缀是 ISO 时间戳 + 标签（如 `paste[init]`、`paste[poll]`、
`transcribed OK`、`transcribe FAILED`）。最常见的几个标签：

- `fired: cwd=... prompt_len=...` — hook 触发了，prompt 长度
- `payload shape: ...` — Claude Code 传给 hook 的字段（key 不会打印）
- `paste[init]: ...` — 第一次扫描 transcript
- `paste[poll]: ...` — 后续轮询扫描
- `paste: decoded ...` — base64 解码到本地文件
- `transcribed OK: ...` — 视觉 API 调成功
- `transcribe FAILED: ...` — 视觉 API 调失败
- `images found: 0 ...` — 没找到任何图（hook 不会注入转写）
- `paste: no matching image record found in transcript` — transcript 60s 内没出现匹配 record

---

## 1. `[转写失败] xxx.png → 视觉通道调用失败`

**症状**：状态行明确说视觉 API 调用失败。debug log 里有 `transcribe FAILED`，含 exit code + error message。

**原因**：

| 原因 | debug log 关键字 | 修法 |
|---|---|---|
| `VISION_API_KEY` 没配 | `error: VISION_API_KEY not set` | 配 key 到 `scripts/.env` 或 `process.env` |
| key 错 | `HTTP 401` / `HTTP 403` | 重新生成 key |
| 余额/限流 | `HTTP 429` / `quota` | 等几秒重试，或换账号 |
| API base 错 | `ENOTFOUND` / `ECONNREFUSED` | 检查 `VISION_API_BASE` |
| 模型名错 | `model not found` / `400` | 检查 `VISION_MODEL`，参考各家文档 |
| 网络问题 | `ETIMEDOUT` / `ECONNRESET` | 检查代理/firewall |

**手动验证 vision.js 本身**：
```bash
cd ~/.claude/skills/vision-proxy
node scripts/vision.js /path/to/any.png --prompt-file hooks/prompt-template.txt
```

这条命令绕开 hook，直接看 vision.js 跑得通不。

---

## 2. `[转写失败] xxx.png → harness classifier 阻断`

**症状**：错误是 `glm-5.3-flash is temporarily unavailable, so auto mode cannot determine the safety of Bash`。多次重试都同样错误。

**原因**：Claude Code 的 Bash 安全分类器挂了。**这个分类器是 Claude Code 框架级配置，跟 vision-proxy 无关**。你 settings.json 里 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 配的是哪个模型，分类器就用哪个。临时不可用 = 后端那个端点挂了。

**修法**：

1. **等几秒重发** — 大概率几秒到几十秒就恢复
2. **手动 `!`-prefix 跑**（绕过分类器）：
   ```
   ! node /Users/laude/skills/vision-proxy/scripts/vision.js /path/to/xxx.png --prompt-file /tmp/prompt.txt
   ```
   （用 `!` 前缀，命令在本会话直接执行，输出进对话，模型基于结果继续答你）
3. **长期方案**：换 `settings.json` 里的 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 指向更稳的端点（注意：这影响所有 Bash 调用的安全分类）

---

## 3. 60 秒后还没看到 `[已转写]`

**症状**：贴图后模型"卡住"很久，60s 后才回复（如果还回复的话）。

**原因**：hook 在干这些事之一：

1. **等 transcript 写入** — Claude Code 把 user record 写到 transcript 文件的 fsync 延迟，实测 v2.1.220 最高 18s
2. **调视觉 API** — qwen-vl-max 走 DashScope 通常 5-15s
3. **base64 解码 + 持久化** — 大图（>2MB）解码稍慢

**怎么判断是哪个**：debug log 里看时间分布：
- `fired` → `paste[init] hit` 差 > 1s：在等 transcript
- `paste[init] hit` → `transcribed OK` 差 > 1s：在调视觉 API
- `transcribed OK` → stdout 出现差 > 1s：在 decode/写盘

**如果 `fired` 之后 60s 没有任何 `paste[init] hit`**：transcript 文件 60s 内都没创建（罕见但会发生）。重新贴一次图通常能过。

---

## 4. 拿到的是上一张图的转写

**症状**：贴了图 A，转写内容是 5 分钟前看过的图 B。状态行是 `[已转写·缓存命中]`。

**原因**：早期版本 bug — transcript 里多条含 image 的 user record 时，hook 可能错把几分钟前的 record 当成当前的。在 `vision-proxy` v2.0 已修：

- hook 现在会校验 candidate record 的 `Image #N` 编号必须匹配当前 prompt
- 还会校验 age ≤ 60s（避免老 record 误认）

**如果还遇到**：升级到最新 vision-proxy 即可。

---

## 5. 提示"hook path 找不到" / "permission denied"

**症状**：debug log 完全没有 "fired" 行（hook 没触发）；或者 hook 启动失败（settings.json 报错）。

**原因 1**：hook 没注册到 settings.json。
**修法**：在 `~/.claude/settings.json` 加：
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

**原因 2**：node 路径不对（Claude Code 用 minimal PATH）。
**修法**：用绝对路径调 node：
```bash
which node  # 拿你的 node 绝对路径
# 把 settings.json 里的 "node ..." 改成 "/Users/lwl/.local/bin/node ..."
```

**原因 3**：hook 脚本权限不够。
**修法**：`chmod +x ~/.claude/skills/vision-proxy/hooks/vision-hook.js`

**验证 hook 注册**：
```bash
cat ~/.claude/settings.json | python3 -m json.tool | grep -A 5 hooks
```

---

## 6. `[未转写] xxx.png → 原因：原生视觉可用`

**症状**：状态行说"原生视觉可用"，但你主模型根本没有视觉（比如 400 Model only support text input 错误）。

**原因**：你（或前一个用户）设了 `VISION_NATIVE_VISION=1`，skill 整体休眠了。

**修法**：
```bash
unset VISION_NATIVE_VISION
# 或编辑 ~/.claude/skills/vision-proxy/scripts/.env 删掉那一行
# 或编辑项目级 .env
```

**正确设置 `VISION_NATIVE_VISION=1` 的条件**（参考 `SKILL.md` §0）：

1. 人工测试：让主模型描述 `assets/canary.png` 里的内容
2. 肉眼对比图片实际内容
3. 完全一致 → 才设 `=1`
4. 错、漏、编造任何细节 → 不要设

---

## 7. 视觉 API 一直超时（vision.js timeout）

**症状**：debug log 显示 `transcribe FAILED ... timeout`。

**原因**：`scripts/vision.js` 默认 vision API timeout 110s。如果 API 端点慢（海外 API、限流时段），可能超时。

**修法**：传 `--max-tokens` 减小，或临时关掉压缩试试：
```bash
node scripts/vision.js /path/to/xxx.png --no-compress --prompt-file hooks/prompt-template.txt
```

或换更快的视觉模型（如 `qwen-vl-plus` 比 `qwen-vl-max` 快 50% 但精度略低）。

---

## 8. 审计块缺失

**症状**：回复里没有 `<vision-proxy-audit>` 块。

**原因**：主模型自己跑了 vision.js（hook 失败后的 fallback 路径），但没遵守 skill 的 §3.3 规范。

**修法**：把这个文件指给主模型看（`SKILL.md` §3.3），提醒它输出审计块。或者**让 hook 成功**——hook 触发后会自动注入完整审计块。

---

## 9. cache 命中但内容错了

**症状**：换了一张完全不同的图，但转写是旧图的（缓存命中）。

**原因**：极少见。可能 `shasum -a 1` 在某个边缘 case 撞了（理论概率 2^-160 ≈ 0）。更可能是 `image_sha1` frontmatter 被手动改过。

**修法**：删掉对应缓存文件：
```bash
rm /path/to/cwd/vision-transcripts/<file>.md
```

下次发同一图（或新图）会重新转写。

---

## 10. 怎么完全关掉 skill

**临时关**（只关本会话）：
```bash
unset VISION_NATIVE_VISION  # 没用，要 set =1 才关
# 实际：本会话重新启动 Claude Code 即可（hook 来自 settings.json）
```

**长期关**（针对某个项目）：
```bash
# 把项目级 .claude/settings.json 的 hooks 段清空
```

**彻底卸载**：
```bash
rm -rf ~/.claude/skills/vision-proxy
# 从 ~/.claude/settings.json 删掉 hooks 段
```

---

## 11. 调试 hook 的最快方法

不开 Claude Code，直接喂 JSON 给 hook：
```bash
cd ~/.claude/skills/vision-proxy
echo '{"prompt":"[Image #1]","cwd":"/tmp","transcript_path":"/nonexistent"}' | \
  node hooks/vision-hook.js
echo "---"
tail -5 hooks/hook-debug.log
```

60s 后应该看到 `paste: no matching image record found in transcript (gave up after 121 scans in 60s)`。说明 hook 本身工作正常，问题在 transcript 链路。

---

## 12. 报告 bug 时请附这些信息

提 issue 或问维护者时附上：

1. `~/.claude/skills/vision-proxy/hooks/hook-debug.log` 末尾 30 行
2. `node --version`
3. Claude Code 版本（`claude --version`）
4. 主模型是哪个、API base 是什么（来自 `~/.claude/settings.json` 的 env 段）
5. 视觉模型是哪个（来自 `scripts/.env` 的 `VISION_MODEL`）
6. 复现步骤（粘图 / 拖文件 / 路径 / URL / Saved attachments）

不要附：你的 `VISION_API_KEY`、完整的 `vision-transcripts/` 内容（含敏感截图转写）。
