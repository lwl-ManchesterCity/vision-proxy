#!/usr/bin/env node
/**
 * vision-hook.js — UserPromptSubmit hook for the vision-proxy skill.
 *
 * Framework-enforced image transcription: runs BEFORE the (text-only) main
 * model sees the user message, so the model can never "simulate" having seen
 * an image. Reads the hook payload on stdin, transcribes any image paths/URLs
 * found in the prompt via scripts/vision.js (Route B), and prints the result
 * on stdout — plain-text stdout + exit 0 is injected into the model's context
 * by Claude Code.
 *
 * Scope & honest degradation:
 *   - Handles: image file paths (typed or drag-and-dropped, incl. escaped
 *     spaces), image URLs, "Saved attachments:" lists.
 *   - Clipboard-pasted images ("[Image #N]"): recovered in two passes:
 *     1) from image blocks inlined into the hook payload itself (preferred,
 *        when the framework version supports it), or 2) from the session
 *        transcript (user record contains base64 image blocks). Both paths
 *        decode the data to vision-transcripts/tmp/ and transcribe as local
 *        files. Falls back to an inline note when neither path yields data.
 *   - VISION_NATIVE_VISION=1 → user-declared native vision, hook stays silent.
 *
 * Never blocks the user's prompt: any internal failure degrades to a warning
 * note on stdout + exit 0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const VISION_JS = path.join(SKILL_DIR, 'scripts', 'vision.js');
const PROMPT_TEMPLATE = path.join(__dirname, 'prompt-template.txt');
const DEBUG_LOG = path.join(__dirname, 'hook-debug.log');
const IMG_EXT = '(?:png|jpe?g|gif|webp|bmp)';
const MAX_IMAGES = 3;
const VISION_TIMEOUT_MS = 110000;

// Debug log: hook runs are otherwise invisible. Append-only, best effort.
function dlog(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Extract image references (paths + URLs) from the prompt text. */
function extractImages(prompt, cwd) {
  const found = [];
  const seen = new Set();
  const push = (p, isUrl) => {
    const key = isUrl ? p : path.resolve(cwd, p.replace(/\\(.)/g, '$1'));
    if (!seen.has(key)) { seen.add(key); found.push({ src: key, isUrl }); }
  };

  // 1) image URLs
  const urlRe = new RegExp('https?://[^\\s"\'<>]+?\\.' + IMG_EXT + '(?:\\?[^\\s"\'<>]*)?', 'gi');
  for (const m of prompt.matchAll(urlRe)) push(m[0], true);

  // 2) file paths ending in an image extension (abs, ~/, or relative).
  //    Handles backslash-escaped chars produced by terminal drag-and-drop.
  const pathRe = new RegExp('(?:^|[\\s"\'(=,:])((?:~?\\/|\\.{1,2}\\/)?(?:[^\\s"\'()\\\\]|\\\\.)+?\\.' + IMG_EXT + ')', 'gim');
  for (const m of prompt.matchAll(pathRe)) {
    let p = m[1];
    if (p.startsWith('~')) p = path.join(process.env.HOME || '/', p.slice(1));
    push(p, false);
  }
  return found.slice(0, MAX_IMAGES);
}

function sha1File(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Recover clipboard-pasted images ([Image #N]).
 *
 * Order of preference:
 *   1. Payload's own image blocks — some Claude Code versions inline the
 *      pasted image data directly into the UserPromptSubmit payload, so we
 *      don't have to wait for the transcript to flush. Recognized shapes:
 *        payload.images = [{ type:'image', source:{type:'base64', media_type, data} }]
 *        payload.attachments = [{...same shape...}]
 *   2. Session transcript — fallback when payload doesn't carry the data.
 *      Transcript writes are async relative to the hook fire, so we retry
 *      with a longer spin-wait (~15s) before giving up.
 *
 * Age guard: prompt contains [Image #N] in this turn, so the user is sending
 * an image right now — do NOT skip the record on age alone. We keep an age
 * log line for visibility, but accept the most recent user record that pairs
 * the marker with base64 image blocks.
 */
function extractPastedImages(payload, tmpDir) {
  const prompt = payload.prompt || '';
  if (!/\[Image #\d+\]/i.test(prompt)) return [];

  // 1) Payload-level image blocks (when the framework inlines them).
  const inline = collectInlineImageBlocks(payload);
  if (inline.length > 0) {
    dlog(`paste: got ${inline.length} image block(s) from payload (no transcript needed)`);
    return decodeBlocks(inline, tmpDir, 'payload');
  }

  // 2) Transcript fallback — pure polling. fs.watchFile is unreliable on
  // macOS for cross-process appends (mtime granularity + FSEvents quirks),
  // so we poll ourselves. Each scan reads at most the tail of the file and
  // is microseconds when nothing has changed; budget is 60s total.
  const tp = payload.transcript_path;
  if (!tp) { dlog('paste: payload has no transcript_path and no inline image blocks'); return []; }

  const marker = /\[Image #\d+\]/i;
  // Collect Image #N numbers from the current prompt so we can pin candidate
  // records to the same numbers — without this, an old "Image #1" record
  // (minutes earlier in the same session) can be mis-decoded as "Image #2".
  const currentNums = new Set();
  for (const m of prompt.matchAll(/\[Image #(\d+)\]/gi)) currentNums.add(m[1]);
  const recordMatchesCurrent = (texts) => {
    if (currentNums.size === 0) return true; // no anchor in current prompt → fall back to marker-only match
    return texts.some(t => {
      const m = String(t).match(/\[Image #(\d+)\]/i);
      return m && currentNums.has(m[1]);
    });
  };

  let imgs = null;
  let chosenLine = -1;
  let lastSize = -1;
  let attempt = 0;
  const deadline = Date.now() + 60000;
  // Age window: 60s. Covers the worst fsync lag we've seen (~18s in v2.1.220)
  // and prevents old records from earlier in the same session from being
  // picked up as "current".
  const MAX_AGE_S = 60;

  const scan = (label) => {
    attempt++;
    let stat;
    try { stat = fs.statSync(tp); } catch (e) { dlog(`paste[${label}]: stat fail: ${String(e.message).slice(0, 100)}`); return false; }
    if (stat.size === lastSize) return false;
    lastSize = stat.size;
    let lines;
    try { lines = fs.readFileSync(tp, 'utf8').split('\n'); }
    catch (e) { dlog(`paste[${label}]: read fail: ${String(e.message).slice(0, 100)}`); return false; }
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 400; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      if (r.type !== 'user') continue;
      const content = r.message && r.message.content;
      if (!Array.isArray(content)) continue;
      const texts = content.filter(b => b && b.type === 'text').map(b => String(b.text || ''));
      const blocks = content.filter(b => b && b.type === 'image' && b.source && b.source.type === 'base64' && b.source.data);
      if (blocks.length === 0 || !texts.some(t => marker.test(t))) continue;
      // Pin to current prompt's Image numbers — guard against old-session pollution.
      if (!recordMatchesCurrent(texts)) {
        const curNums = Array.from(currentNums).join(',');
        const recMarker = texts.find(t => marker.test(t)) || '';
        dlog(`paste[${label}]: line ${i} skipped (Image #N mismatch — current=[${curNums}], record=${recMarker})`);
        continue;
      }
      const age = r.timestamp ? Math.round((Date.now() - new Date(r.timestamp).getTime()) / 1000) : '?';
      if (age !== '?' && age > MAX_AGE_S) { dlog(`paste[${label}]: line ${i} skipped (stale age=${age}s > ${MAX_AGE_S}s)`); continue; }
      dlog(`paste[${label}]: hit line ${i} (scan#${attempt}, size=${stat.size}, age=${age}s, blocks=${blocks.length})`);
      imgs = blocks;
      chosenLine = i;
      return true;
    }
    return false;
  };

  if (scan('init')) return decodeBlocks(imgs, tmpDir, 'transcript');

  // Poll every 500ms. Cheap: stat is a single syscall; the heavy read only
  // runs when the file size has actually changed.
  while (!imgs && Date.now() < deadline) {
    const until = Date.now() + 500;
    while (Date.now() < until) { /* sleep */ }
    if (scan('poll')) break;
  }

  if (!imgs) { dlog(`paste: no matching image record found in transcript (gave up after ${attempt} scans in 60s)`); return []; }
  dlog(`paste: matched line ${chosenLine} (${imgs.length} block(s)) after ${attempt} scan(s)`);
  return decodeBlocks(imgs, tmpDir, 'transcript');
}

/** Look for image blocks inlined into the hook payload itself. */
function collectInlineImageBlocks(payload) {
  const out = [];
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const b of arr) {
      if (!b) continue;
      const src = b.source || (b.image && b.image.source);
      if (b.type === 'image' && src && src.type === 'base64' && src.data) out.push({ source: src });
      else if (src && src.type === 'base64' && src.data) out.push({ source: src });
    }
  };
  collect(payload.images);
  collect(payload.attachments);
  collect(payload.message && payload.message.content);
  return out;
}

/** Decode base64 image blocks to local files in tmpDir. */
function decodeBlocks(blocks, tmpDir, source) {
  const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };
  const out = [];
  blocks.slice(0, MAX_IMAGES).forEach((b, i) => {
    const src = b.source || {};
    try {
      const ext = EXT[src.media_type] || '.png';
      const buf = Buffer.from(src.data, 'base64');
      const fp = path.join(tmpDir, `pasted-${timestamp()}-${i}${ext}`);
      fs.writeFileSync(fp, buf);
      out.push({ src: fp, isUrl: false, pasted: true, label: `Image #${i + 1} (剪贴板粘贴, ${source})` });
      dlog(`paste: decoded Image #${i + 1} -> ${fp} (${buf.length} bytes, ${src.media_type || '?'})`);
    } catch (e) { dlog(`paste: decode failed #${i + 1}: ${String(e.message).slice(0, 120)}`); }
  });
  return out;
}

/** Compact, safe summary of payload shape for debug logging. Never prints base64. */
function describePayload(p) {
  const out = [];
  for (const k of Object.keys(p || {})) {
    const v = p[k];
    if (v == null) { out.push(`${k}=null`); continue; }
    if (Array.isArray(v)) { out.push(`${k}=Array(${v.length})${describeArraySample(v)}`); continue; }
    if (typeof v === 'string') { out.push(`${k}=str(${v.length})`); continue; }
    if (typeof v === 'object') { out.push(`${k}=Object{${Object.keys(v).join(',')}}`); continue; }
    out.push(`${k}=${typeof v}`);
  }
  return out.join(' ');
}
function describeArraySample(arr) {
  if (arr.length === 0) return '';
  const s = arr.slice(0, 1).map(x => {
    if (!x || typeof x !== 'object') return typeof x;
    const t = x.type || (x.source && x.source.type) || '?';
    const src = x.source || {};
    const media = src.media_type || '';
    const dataLen = typeof src.data === 'string' ? src.data.length : 0;
    return `{type=${t}${media ? `,media=${media}` : ''}${dataLen ? `,data=${dataLen}` : ''}}`;
  }).join('');
  return ':' + s;
}

/** Look up <cwd>/vision-transcripts/*.md frontmatter for a matching sha1. */
function cacheLookup(dir, sha1) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return null; }
  for (const f of files) {
    try {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 800);
      if (head.includes('image_sha1: ' + sha1)) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const m = text.match(/## FIRST PASS\n([\s\S]*?)(?=\n## FOLLOW-UPS|$)/);
        return { file: path.join(dir, f), body: m ? m[1].trim() : text };
      }
    } catch { /* skip unreadable */ }
  }
  return null;
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sanitize(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w一-鿿-]+/g, '-').slice(0, 60);
}

function main() {
  // User-declared native vision → stay silent.
  if (process.env.VISION_NATIVE_VISION === '1') { dlog('skip: VISION_NATIVE_VISION=1'); process.exit(0); }

  let payload;
  try { payload = JSON.parse(readStdin()); } catch { dlog('skip: stdin JSON parse failed'); process.exit(0); }
  const prompt = payload.prompt || '';
  const cwd = payload.cwd || process.cwd();
  dlog(`fired: cwd=${cwd} prompt_len=${prompt.length}`);
  // Diagnostic: payload shape (keys + sizes, no base64 content). Helps tune
  // collectInlineImageBlocks if the framework starts inlining image data
  // under a different field name than {images, attachments, message.content}.
  dlog(`payload shape: ${describePayload(payload)}`);

  const tDir = path.join(cwd, 'vision-transcripts');
  const tmpDir = path.join(tDir, 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* best effort */ }

  const pathImages = extractImages(prompt, cwd).filter(i => {
    if (i.isUrl) return true;
    try { return fs.statSync(i.src).isFile(); } catch { return false; }
  });
  const pastedImages = extractPastedImages(payload, tmpDir);
  const images = pathImages.concat(pastedImages).slice(0, MAX_IMAGES);
  dlog(`images found: ${images.length} (paths=${pathImages.length}, pasted=${pastedImages.length})${images.length ? ' -> ' + images.map(i => i.src).join(', ') : ''}`);

  if (images.length === 0) {
    if (/\[Image #\d+\]/i.test(prompt)) {
      // Paste recovery failed — last-resort fallback.
      process.stdout.write(
        '[vision-proxy hook] 检测到剪贴板粘贴的图片（[Image #N]），但无法从会话记录中还原图片文件。\n' +
        '指令：当前模型无原生视觉能力，必须使用 vision-proxy skill 处理该图片——实际执行视觉通道调用，' +
        '输出 [已转写]/[转写失败] 状态行与 <vision-proxy-audit> 审计块。禁止在未实际调用的情况下编造图片内容。\n' +
        '建议：提醒用户改用拖拽文件方式发图（终端会自动带出真实路径，转写更可靠）。\n'
      );
    }
    process.exit(0);
  }

  const template = fs.readFileSync(PROMPT_TEMPLATE, 'utf8');
  const blocks = [];
  const statusLines = [];

  images.forEach((img, idx) => {
    const label = img.label || img.src;
    const name = img.pasted ? img.label : path.basename(img.src);
    let sha = null;
    if (!img.isUrl) { try { sha = sha1File(img.src); } catch { /* ignore */ } }

    // cache
    if (sha) {
      const hit = cacheLookup(tDir, sha);
      if (hit) {
        statusLines.push(`[已转写·缓存命中] ${name} → ${path.relative(cwd, hit.file)}`);
        blocks.push(`=== IMAGE ${idx + 1}: ${label} (channel: cache, transcript: ${path.relative(cwd, hit.file)}) ===\n${hit.body}\n=== END IMAGE ${idx + 1} ===`);
        return;
      }
    }

    // live transcription via Route B
    const promptFile = path.join(tmpDir, `hook-prompt-${Date.now()}-${idx}.txt`);
    const imageList = images.map((x, i) => `${i + 1}. ${x.src}`).join('\n');
    try {
      fs.writeFileSync(promptFile, template.replace('{N}', String(images.length)).replace('{IMAGE_LIST}', imageList));
      // Use process.execPath (the node binary running this hook) instead of
      // bare 'node' — Claude Code may spawn hooks with a minimal PATH.
      const out = execFileSync(process.execPath, [VISION_JS, img.src, '--prompt-file', promptFile], {
        timeout: VISION_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      dlog(`transcribed OK: ${img.src} (${out.length} chars)`);
      // persist
      const ts = timestamp();
      const mdName = `${ts}-${sanitize(path.basename(img.src))}.md`;
      const mdPath = path.join(tDir, mdName);
      const model = process.env.VISION_MODEL || 'qwen-vl-max';
      fs.writeFileSync(mdPath,
        `---\nimage_path: ${img.pasted ? img.label + ' -> ' + img.src : img.src}\nimage_sha1: ${sha || 'n/a (url)'}\n` +
        `image_type: (见 FIRST PASS)\nvision_channel: B(API, ${model}) [hook]\ncreated: ${new Date().toISOString()}\n---\n\n` +
        `## FIRST PASS\n${out.trim()}\n\n## FOLLOW-UPS\n`);
      statusLines.push(`[已转写] ${name} → vision-transcripts/${mdName}`);
      blocks.push(`=== IMAGE ${idx + 1}: ${label} (channel: B, ${model}, exit: 0, transcript: vision-transcripts/${mdName}) ===\n${out.trim()}\n=== END IMAGE ${idx + 1} ===`);
    } catch (e) {
      const code = e.status != null ? e.status : 'timeout/error';
      dlog(`transcribe FAILED: ${img.src} exit=${code} err=${String(e.message).slice(0, 200)}`);
      statusLines.push(`[转写失败] ${name} → 视觉通道调用失败 (exit ${code})`);
      blocks.push(`=== IMAGE ${idx + 1}: ${label} (channel: B, FAILED, exit ${code}) ===\n转写失败。禁止编造该图片内容；如需重试，使用 vision-proxy skill 的路线 B 手动执行。\n=== END IMAGE ${idx + 1} ===`);
    } finally {
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
    }
  });

  const header =
    '[vision-proxy hook] 框架已在模型处理本消息前完成图片转写。以下转写是关于图片的唯一事实来源，禁止编造或"补充"图片内容。\n' +
    '指令：回复开头逐行输出以下状态行；随后基于转写内容回答用户；对细节存疑时使用 vision-proxy skill 的追问机制（scripts/vision.js），禁止猜测。\n\n' +
    statusLines.join('\n') + '\n';
  process.stdout.write(header + '\n' + blocks.join('\n\n') + '\n');
  process.exit(0);
}

main();
