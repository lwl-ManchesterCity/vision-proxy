# vision-proxy

> A Claude Code / MiniMax Code skill that gives any text-only coding model
> the ability to "see" images — without changing the main model.

When the user pastes an image, drops a screenshot, or types a file path, the
skill transcribes it to structured text **before** the main model sees the
prompt, so the model can answer about the image without ever needing native
vision.

## How it works

```
   User pastes image in Claude Code
            │
            ▼
   ┌───────────────────────┐
   │  UserPromptSubmit hook │  ← vision-hook.js
   │  (synchronous, 120s)   │
   └──────────┬────────────┘
              │ base64 decode to local file
              ▼
   ┌───────────────────────┐
   │  vision.js  (Node)     │  ← calls any OpenAI-compatible
   │  Route B: external API │     /chat/completions endpoint
   └──────────┬────────────┘
              │ structured schema (image_type / transcription /
              │  structure / uncertainties)
              ▼
   Main model sees the prompt + injected transcript
   → can answer about the image, ask follow-ups, or mark cache hits
```

The skill is **idempotent** — past a cached `sha1` of an image and the
transcript is reused across sessions.

## Why this exists

You're using Claude Code with a strong coding model that happens to be
text-only (e.g. via a custom endpoint, a quantized local model, or a
text-only subscription tier). You want to keep that model, but you also
need it to "see" the bug screenshot, the architecture diagram, or the
design mock-up. This skill bridges the gap.

## Install

### As a Claude Code skill

```bash
git clone https://github.com/lwl-ManchesterCity/vision-proxy.git
mkdir -p ~/.claude/skills
cp -r vision-proxy ~/.claude/skills/vision-proxy
```

### As a project skill (per-repo)

```bash
git clone https://github.com/lwl-ManchesterCity/vision-proxy.git
mkdir -p .claude/skills
cp -r vision-proxy .claude/skills/vision-proxy
```

## Configure

```bash
cp .env.example scripts/.env
# edit scripts/.env and fill in VISION_API_KEY
```

The default endpoint is Alibaba DashScope (`qwen-vl-max`). Override
`VISION_API_BASE` for any other OpenAI-compatible multimodal API
(Moonshot, StepFun, Zhipu, OpenRouter, local vLLM, etc.).

`scripts/.env` is git-ignored — your key never leaves your machine.

## What gets transcribed

Triggered by any of:

- Image pasted into the terminal (`[Image #1]`)
- Image file dropped into the terminal (becomes `[Image: source: /path]`)
- Image file path typed directly in the prompt
- Image URL in the prompt
- "看 / 分析 / 识别这张截图" or "Saved attachments:" lists

Output goes to `<cwd>/vision-transcripts/<timestamp>-<name>.md` and is
shown to the main model as structured text. Each reply starts with a
status line:

```
[已转写] xxx.png → vision-transcripts/2026-09-09-144927-xxx.md
[已转写·缓存命中] xxx.png → ...
[转写失败] xxx.png → reason
[追问] xxx.png → round N
```

## Repository layout

```
SKILL.md                  — the skill spec, read by the model
references/
  schemas.md              — structured-output schema (image_type, transcription, structure, uncertainties)
scripts/
  vision.js               — Route B: external vision API caller (Node ≥ 18, zero deps)
  .env.example            — credential template (commit this; the real .env is git-ignored)
hooks/
  vision-hook.js          — UserPromptSubmit hook, decodes pasted images and dispatches to vision.js
  prompt-template.txt     — schema prompt template loaded by the hook
assets/
  canary.png              — image used to manually verify whether a model has native vision (see SKILL.md §0)
.env.example              — top-level credential template
.gitignore                — excludes .env, transcripts, debug log
```

## Hard guards (anti-hallucination)

The skill enforces two rules even when the model is misbehaving:

1. **`[已转写]` is only printed when the vision API was actually called** and
   returned a non-empty result. The hook is synchronous — there's no way for
   the model to "fake" a transcription and skip the API call.
2. **Audit block on every reply.** Each transcription is followed by a
   `<vision-proxy-audit>` block listing the channel, model, command, exit
   code, and the **verbatim** stdout from the vision API. This lets humans
   verify the call actually happened.

Both rules exist because in 2026-09 testing, a text-only endpoint (LongCat 2.0)
was observed confabulating an image description for a KPL esports poster,
claiming it was a "VS Code diff editor". The audit block makes that kind
of hallucination trivially detectable.

## Caveats

These tasks are **not** a good fit for structured transcription; the skill
will tell the user to switch to a native multimodal model instead:

- Pixel-perfect UI reproduction (hex / spacing / size — the schema is
  approximate, not a pixel sample)
- Dense small-text images (full-screen code, large tables — OCR accuracy
  vs. context length)
- Subjective aesthetic judgment ("which color is nicer")

## Provenance

- Originally developed for use with Claude Code v2.1.x and MiniMax Code
  with a custom GLM-based coding endpoint.
- Tested with Alibaba DashScope `qwen-vl-max` as the vision backend.
- Should work with any model that exposes OpenAI-compatible
  `/chat/completions` and accepts image content parts (base64 or URL).

## License

MIT. See [LICENSE](./LICENSE).
