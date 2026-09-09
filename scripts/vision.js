#!/usr/bin/env node
/**
 * vision.js — Route B vision channel for vision-proxy skill.
 *
 * Implements the "external vision API" route (spec §5.2) with the four
 * improvements over the reference implementation:
 *   1. max_tokens default 4096 (was 1024; long stack traces get truncated)
 *   2. long-edge > 1568px image compression (uses macOS `sips` when present,
 *      falls back to sending the original bytes otherwise with a warning)
 *   3. multi-image input — multiple positional image args are sent in a
 *      single request as separate content parts (for related-image scenes)
 *   4. prompt is the structured schema from references/schemas.md
 *      (write the prompt to a file, pass via --prompt-file)
 *
 * Plus the reference implementation's standalone qualities that we keep:
 *   - zero third-party npm dependencies (uses Node ≥ 18 globals: fetch)
 *   - .env + environment-variable dual config
 *   - magic-byte image type detection (PNG/JPEG/GIF/WebP/BMP)
 *   - HTTP(S) URL image sources are downloaded and base64-encoded inline
 *   - heuristic no-image retry (4× / 2s) for "model didn't see the image"
 *   - generic transient retry (2×) for 5xx / 429 / network errors
 *
 * Usage:
 *   node vision.js <img1> [<img2> ...] [--prompt-file <file>] [--model <m>]
 *                 [--api-base <url>] [--api-key <k>] [--format <auto|openai|anthropic|dashscope>]
 *                 [--max-tokens <n>] [--no-compress] [--help]
 *
 * Legacy positional form (spec §5.2): <img1> [<img2> ...] [prompt.txt]
 * (model selection is flag/env only: --model or VISION_MODEL)
 *
 * Exit codes:
 *   0 success; stdout = the model's text response
 *   1 hard failure (network / HTTP / unsupported image)
 *   2 usage error (bad args, missing prompt, missing key)
 *   3 model keeps reporting no image after 4 retries
 *   4 empty response from the model
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { URL } = require('url');

// ---------- .env loader (no deps) ----------
// Lookup order: process env > ./.env (cwd, project-level) > <script-dir>/.env (skill default).
// First writer wins, so load cwd first to give the project override priority.
function loadDotEnvFile(envFile) {
  if (!fs.existsSync(envFile)) return;
  const text = fs.readFileSync(envFile, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnvFile(path.join(process.cwd(), '.env'));
loadDotEnvFile(path.join(__dirname, '.env'));

// ---------- Argv parsing ----------
function parseArgs(argv) {
  const opts = {
    images: [], promptFile: null, model: null,
    apiBase: null, apiKey: null, format: null,
    maxTokens: null, compress: true, help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--prompt-file' || a === '-p') { opts.promptFile = argv[++i]; continue; }
    if (a === '--model' || a === '-m') { opts.model = argv[++i]; continue; }
    if (a === '--api-base') { opts.apiBase = argv[++i]; continue; }
    if (a === '--api-key') { opts.apiKey = argv[++i]; continue; }
    if (a === '--format') { opts.format = argv[++i]; continue; }
    if (a === '--max-tokens') { opts.maxTokens = parseInt(argv[++i], 10); continue; }
    if (a === '--no-compress') { opts.compress = false; continue; }
    if (a.startsWith('--')) {
      process.stderr.write(`error: unknown flag ${a}\n`);
      process.exit(2);
    }
    positional.push(a);
  }
  // Legacy positional: <img1> [<img2> ...] [prompt.txt] [model].
  // The last positional that is an existing file or has a text-ish extension
  // is treated as the prompt file (only if --prompt-file wasn't given).
  if (!opts.promptFile && positional.length >= 2) {
    const last = positional[positional.length - 1];
    const looksTexty = /\.(txt|md|prompt|json)$/i.test(last) || fs.existsSync(last);
    const looksImagey = /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(last);
    if (looksTexty && !looksImagey) {
      opts.promptFile = last;
      positional.pop();
    }
  }
  for (const p of positional) opts.images.push(p);
  if (!opts.help && opts.images.length === 0) {
    process.stderr.write('error: no image arguments\n');
    process.exit(2);
  }
  return opts;
}

// ---------- Magic-byte image type detection ----------
const IMG_SIG = [
  { ext: 'png',  mime: 'image/png',  sig: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { ext: 'jpg',  mime: 'image/jpeg', sig: Buffer.from([0xff, 0xd8, 0xff]) },
  { ext: 'gif',  mime: 'image/gif',  sigs: [Buffer.from('GIF87a'), Buffer.from('GIF89a')] },
  { ext: 'webp', mime: 'image/webp', sig: Buffer.from('RIFF') },
  { ext: 'bmp',  mime: 'image/bmp',  sig: Buffer.from('BM') },
];
function detectImage(buf) {
  for (const f of IMG_SIG) {
    const sigs = f.sigs || [f.sig];
    for (const sig of sigs) {
      if (buf.length >= sig.length && buf.subarray(0, sig.length).equals(sig)) {
        if (f.ext === 'webp' && !(buf.length >= 12 && buf.subarray(8, 12).toString() === 'WEBP')) continue;
        return f;
      }
    }
  }
  return null;
}

// ---------- Dimension parsing (no deps) ----------
function parseSize(buf, type) {
  if (type === 'png') {
    if (buf.length < 24) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (type === 'gif') {
    if (buf.length < 10) return null;
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (type === 'bmp') {
    if (buf.length < 26) return null;
    return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  }
  if (type === 'webp') {
    if (buf.length < 30) return null;
    const tag = buf.subarray(12, 16).toString();
    if (tag === 'VP8 ') {
      return {
        w: buf.readUInt16LE(26) & 0x3fff,
        h: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (tag === 'VP8L') {
      const f0 = buf[21], f1 = buf[22], f2 = buf[23], f3 = buf[24];
      return {
        w: 1 + ((f0 | (f1 << 8)) & 0x3fff),
        h: 1 + (((f1 >> 6) | (f2 << 2) | (f3 << 10)) & 0x3fff),
      };
    }
    if (tag === 'VP8X') {
      return {
        w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      };
    }
    return null;
  }
  if (type === 'jpg') {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      const isSOF = (marker >= 0xc0 && marker <= 0xc3) ||
                    (marker >= 0xc5 && marker <= 0xc7) ||
                    (marker >= 0xc9 && marker <= 0xcb) ||
                    (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// ---------- Compression (sips) ----------
function hasSips() {
  try { execFileSync('sips', ['-h'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function compressIfNeeded(buf, type) {
  const size = parseSize(buf, type);
  if (!size) return buf;
  const long = Math.max(size.w, size.h);
  if (long <= 1568) return buf;
  if (!hasSips()) {
    process.stderr.write(`warn: long edge ${long}px > 1568 but sips unavailable; sending original\n`);
    return buf;
  }
  const tmp = path.join(os.tmpdir(), `vp-${crypto.randomBytes(6).toString('hex')}.${type === 'jpg' ? 'jpeg' : type}`);
  fs.writeFileSync(tmp, buf);
  try {
    execFileSync('sips', ['-Z', '1568', tmp], { stdio: 'ignore' });
    return fs.readFileSync(tmp);
  } catch (e) {
    // sips may fail on formats it cannot handle (e.g. webp on older macOS).
    // Degrade to the original bytes rather than hard-failing the whole call.
    process.stderr.write(`warn: sips compression failed (${e.message.split('\n')[0]}); sending original\n`);
    return buf;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ---------- Image loader (local + URL) ----------
async function readImage(src) {
  let buf, name;
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`download failed (${r.status}): ${src}`);
    buf = Buffer.from(await r.arrayBuffer());
    try { name = path.basename(new URL(src).pathname) || 'remote'; } catch { name = 'remote'; }
  } else {
    if (!fs.existsSync(src)) throw new Error(`image not found: ${src}`);
    buf = fs.readFileSync(src);
    name = path.basename(src);
  }
  if (buf.length === 0) throw new Error(`empty file: ${src}`);
  const meta = detectImage(buf);
  if (!meta) throw new Error(`unsupported image format: ${src} (head=${buf.subarray(0, 16).toString('hex')})`);
  return { buf, meta, name, src };
}

// ---------- API payload builders ----------
function buildOpenAIPayload(prompt, images, model, maxTokens) {
  return {
    urlSuffix: '/chat/completions',
    headers: () => ({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ${KEY}' }),
    body: {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.map(i => ({ type: 'image_url', image_url: { url: i.dataUri } })),
        ],
      }],
      max_tokens: maxTokens,
    },
  };
}
function buildAnthropicPayload(prompt, images, model, maxTokens) {
  return {
    urlSuffix: '/v1/messages',
    headers: () => ({
      'Content-Type': 'application/json',
      'x-api-key': '${KEY}',
      'anthropic-version': '2023-06-01',
    }),
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.meta.mime, data: i.b64 } })),
          { type: 'text', text: prompt },
        ],
      }],
    },
  };
}
function buildDashscopeNativePayload(prompt, images, model, maxTokens) {
  return {
    urlSuffix: '/api/v1/services/aigc/multimodal-generation/generation',
    headers: () => ({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ${KEY}' }),
    body: {
      model,
      input: {
        messages: [{
          role: 'user',
          content: [
            ...images.map(i => ({ image: i.dataUri })),
            { text: prompt },
          ],
        }],
      },
      parameters: { result_format: 'message', max_tokens: maxTokens },
    },
  };
}

// ---------- Helpers ----------
function detectFormat(base, hint) {
  if (hint && hint !== 'auto') return hint;
  const b = base.toLowerCase();
  if (b.includes('anthropic.com') || b.includes('/anthropic')) return 'anthropic';
  if (b.includes('dashscope.aliyuncs.com') && !b.includes('compatible-mode')) return 'dashscope';
  return 'openai';
}
function interpolate(s, key) {
  return s.replace('${KEY}', key);
}
function extractContent(format, json) {
  if (format === 'openai' || format === 'dashscope') {
    const c = json?.choices?.[0]?.message?.content ?? json?.output?.choices?.[0]?.message?.content;
    if (Array.isArray(c)) return c.map(x => x?.text || '').join('');
    if (typeof c === 'string') return c;
    return '';
  }
  if (format === 'anthropic') {
    const c = json?.content;
    if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text || '').join('');
    return '';
  }
  return '';
}

// Heuristic "the model claims it didn't see the image" — some gateway nodes
// silently drop image parts. The text still succeeds but the model hallucinates
// a refusal. Per spec §5.2: retry up to 4 times with 2s gaps.
const NO_IMAGE = /(no\s+image|haven'?t\s+seen|couldn'?t\s+see|can'?t\s+see\s+(the\s+)?image|didn'?t\s+see|没有\s*看到\s*图|没有\s*看到\s*图片|未\s*收到\s*图片|图片\s*未\s*送达|图像\s*未\s*到达|图像\s*未\s*提供|我\s*没有\s*收到\s*图)/i;

async function callOnce(spec) {
  const r = await fetch(spec.url, {
    method: 'POST',
    headers: spec.headers,
    body: JSON.stringify(spec.body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const err = new Error(`http ${r.status}: ${t.slice(0, 500)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// ---------- Main ----------
async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  // prompt resolution: --prompt-file > legacy positional last arg > ./vision-prompt.txt
  let prompt;
  if (opts.promptFile) {
    if (!fs.existsSync(opts.promptFile)) {
      process.stderr.write(`error: prompt file not found: ${opts.promptFile}\n`);
      process.exit(2);
    }
    prompt = fs.readFileSync(opts.promptFile, 'utf8');
  } else {
    const def = path.join(process.cwd(), 'vision-prompt.txt');
    if (fs.existsSync(def)) prompt = fs.readFileSync(def, 'utf8');
  }
  if (!prompt) {
    process.stderr.write('error: no prompt. Pass --prompt-file <file> or create ./vision-prompt.txt\n');
    process.exit(2);
  }

  const KEY = opts.apiKey || process.env.VISION_API_KEY;
  if (!KEY) {
    process.stderr.write('error: VISION_API_KEY not set (env or .env, or pass --api-key)\n');
    process.exit(2);
  }
  const BASE = (opts.apiBase || process.env.VISION_API_BASE || process.env.VISION_BASE_URL ||
                'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  const MODEL = opts.model || process.env.VISION_MODEL || 'qwen-vl-max';
  const FORMAT = detectFormat(BASE, opts.format || process.env.VISION_API_FORMAT || 'auto');
  const MAX_TOKENS = opts.maxTokens != null ? opts.maxTokens :
                     (process.env.VISION_MAX_TOKENS ? parseInt(process.env.VISION_MAX_TOKENS, 10) : 4096);

  // load + compress images
  const images = [];
  for (const src of opts.images) {
    const { buf, meta, name } = await readImage(src);
    const compressed = opts.compress ? compressIfNeeded(buf, meta.ext) : buf;
    const finalMeta = detectImage(compressed) || meta;
    const b64 = compressed.toString('base64');
    images.push({
      src, name, meta: finalMeta, b64,
      dataUri: `data:${finalMeta.mime};base64,${b64}`,
    });
  }

  // build spec
  let builder;
  if (FORMAT === 'openai') builder = buildOpenAIPayload;
  else if (FORMAT === 'anthropic') builder = buildAnthropicPayload;
  else builder = buildDashscopeNativePayload;
  const spec0 = builder(prompt, images, MODEL, MAX_TOKENS);
  const url = BASE + spec0.urlSuffix;
  const hdrs0 = spec0.headers();
  const headers = Object.fromEntries(Object.entries(hdrs0).map(([k, v]) => [k, interpolate(v, KEY)]));
  const spec = { url, headers, body: spec0.body };

  // retry loop
  const NO_IMAGE_MAX = 4;
  const TRANSIENT_MAX = 2;
  let noImageAttempt = 0;
  let transientAttempt = 0;
  while (true) {
    try {
      const json = await callOnce(spec);
      const content = extractContent(FORMAT, json);
      if (NO_IMAGE.test(content)) {
        if (noImageAttempt < NO_IMAGE_MAX - 1) {
          noImageAttempt++;
          process.stderr.write(`warn: model reports "no image"; retry ${noImageAttempt + 1}/${NO_IMAGE_MAX} in 2s\n`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        process.stderr.write('error: model keeps reporting "no image" after 4 retries.\n' +
                             '       Try a different VISION_API_FORMAT or provider.\n');
        process.exit(3);
      }
      if (!content) {
        process.stderr.write('error: empty response from model\n');
        process.exit(4);
      }
      process.stdout.write(content);
      return;
    } catch (e) {
      const retriable = e.status === 408 || e.status === 429 ||
                        (e.status >= 500 && e.status < 600) ||
                        // AbortSignal.timeout() throws TimeoutError on Node ≥ 17.3,
                        // AbortError on older runtimes — match both.
                        e.name === 'AbortError' || e.name === 'TimeoutError' ||
                        /ECONN|fetch failed|network/i.test(e.message);
      if (retriable && transientAttempt < TRANSIENT_MAX) {
        transientAttempt++;
        const delay = e.status === 429 ? 5000 : 2000;
        process.stderr.write(`warn: transient failure (${e.message.split('\n')[0]}); retry ${transientAttempt}/${TRANSIENT_MAX} in ${delay / 1000}s\n`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(1);
    }
  }
}

const USAGE = `vision.js — Route B vision channel (vision-proxy skill)

Usage:
  node vision.js <img1> [<img2> ...] [--prompt-file <file>] [--model <m>]
                 [--api-base <url>] [--api-key <k>] [--format <auto|openai|anthropic|dashscope>]
                 [--max-tokens <n>] [--no-compress] [--help]

Legacy positional (spec §5.2):
  node vision.js <img1> [<img2> ...] [prompt.txt]
  (model selection is flag/env only: --model or VISION_MODEL)

Environment (.env lookup: ./.env first, then <script-dir>/.env; env vars win):
  VISION_API_KEY      required (or pass --api-key)
  VISION_API_BASE     base URL (default: https://dashscope.aliyuncs.com/compatible-mode/v1)
  VISION_BASE_URL     alias of VISION_API_BASE
  VISION_MODEL        default: qwen-vl-max
  VISION_API_FORMAT   auto|openai|anthropic|dashscope (default: auto)
  VISION_MAX_TOKENS   default: 4096

.env file (KEY=VALUE, # comments, optional quotes):
  VISION_API_KEY=sk-xxxx
  VISION_MODEL=qwen-vl-max

Exit codes:
  0  success — stdout = structured text from the model
  1  hard failure (network / HTTP / unsupported image)
  2  usage error (bad args, missing prompt, missing key)
  3  model keeps reporting "no image" after 4 retries
  4  empty response from the model
`;

run().catch(e => {
  process.stderr.write(`fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
