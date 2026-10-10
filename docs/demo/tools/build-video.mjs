#!/usr/bin/env node
/**
 * 演示视频后期合成
 *
 * 输入：out/webm/ch*.webm（record.mjs 逐章录制的原始片段）
 * 过程：
 *   1. 用 Playwright 渲染每章的「章节卡」PNG（与字幕条同一视觉语言）
 *   2. ffmpeg 把章节卡做成 2.4s 静帧片段（带淡入淡出）
 *   3. 每章归一化为 H.264 / 1440×900 / 25fps / yuv420p
 *   4. concat demuxer 顺序拼接为主片 MP4（+faststart，便于网页直接播放）
 * 输出：out/rag-demo.mp4 + out/各分段 mp4 + out/时长清单.txt
 *
 * 用法：node build-video.mjs [--no-cards] [--only=ch2,ch3]
 */

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import {
  mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAPTER_META } from './chapters.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..', '..', '..');
const OUT = join(HERE, 'out');
const RAW = join(OUT, 'webm');
const SEG = join(OUT, 'segments');
const CARDS = join(OUT, 'cards');
const FINAL = join(OUT, 'rag-demo.mp4');

const FF = process.env.DEMO_FFMPEG
  ?? 'C:/Users/yuan/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';

const ARGS = process.argv.slice(2);
const NO_CARDS = ARGS.includes('--no-cards');
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '').split(',').filter(Boolean);

const W = 1440;
const H = 900;
const CARD_SEC = 2.4;

const run = (args, label) =>
  new Promise((res, rej) => {
    execFile(FF, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`\n❌ ffmpeg ${label} 失败：\n${(stderr || '').split('\n').slice(-14).join('\n')}`);
        return rej(err);
      }
      res(String(stderr || ''));
    });
  });

/** 解析片段时长（秒） */
async function duration(file) {
  const out = await run(['-hide_banner', '-i', file, '-f', 'null', '-'], 'probe').catch(() => '');
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/* ─────────────────────── 章节卡渲染 ─────────────────────── */

function cardHtml(meta) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#070b11}
  body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#e8eefc;
       display:flex;align-items:center;justify-content:center;
       background:radial-gradient(1200px 620px at 22% 30%,#13223c 0%,#070b11 68%)}
  .wrap{padding:0 110px;width:100%}
  .no{font:700 150px/1 "Cascadia Code",Consolas,monospace;color:#1a66ff;opacity:.92;
      letter-spacing:-4px}
  .bar{width:132px;height:5px;background:#1a66ff;border-radius:3px;margin:26px 0 30px}
  h1{margin:0;font-size:60px;font-weight:700;letter-spacing:1px}
  .tag{margin-top:22px;font:400 22px/1.6 "Cascadia Code",Consolas,monospace;color:#8fb4ff}
  .foot{margin-top:56px;font-size:19px;color:#5d7191;letter-spacing:.6px}
  .foot b{color:#7f9cc4}
</style></head><body>
  <div class="wrap">
    <div class="no">${String(meta.no).padStart(2, '0')}</div>
    <div class="bar"></div>
    <h1>${meta.title}</h1>
    <div class="tag">${meta.tag}</div>
    <div class="foot"><b>企业知识库 · RAG 全流程演示</b>　|　共 6 章</div>
  </div>
</body></html>`;
}

async function renderCards(list) {
  mkdirSync(CARDS, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars'] });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const m of list) {
    const png = join(CARDS, `${m.id}.png`);
    await page.setContent(cardHtml(m), { waitUntil: 'load' });
    await page.screenshot({ path: png });
    console.log(`   ✔ 章节卡 ${m.id}.png`);
  }
  await browser.close();
}

/* ─────────────────────── 主流程 ─────────────────────── */

const todo = (ONLY.length ? CHAPTER_META.filter((m) => ONLY.includes(m.id)) : CHAPTER_META)
  .filter((m) => existsSync(join(RAW, `${m.id}.webm`)));

if (todo.length === 0) {
  console.error(`未找到任何原始片段（${RAW}）。请先运行 node record.mjs`);
  process.exit(1);
}
if (!existsSync(FF)) {
  console.error(`未找到 ffmpeg：${FF}\n可通过 DEMO_FFMPEG 环境变量指定路径。`);
  process.exit(1);
}

rmSync(SEG, { recursive: true, force: true });
mkdirSync(SEG, { recursive: true });

console.log(`\n▶ 合成 ${todo.length} 章${NO_CARDS ? '（无章节卡）' : ''}\n`);

if (!NO_CARDS) await renderCards(todo);

const segFiles = [];
const rows = [];

for (const m of todo) {
  const src = join(RAW, `${m.id}.webm`);
  const body = join(SEG, `${m.no}-body.mp4`);
  console.log(`[${m.id}] 转码 …`);
  await run([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-vf', `scale=${W}:${H}:flags=lanczos,fps=25,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-an', '-movflags', '+faststart',
    body,
  ], `${m.id} body`);

  let dur = await duration(body);
  rows.push({ id: m.id, title: m.title, kind: '正文', dur });
  segFiles.push(body);

  if (!NO_CARDS) {
    const card = join(SEG, `${m.no}-card.mp4`);
    await run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-loop', '1', '-t', String(CARD_SEC), '-i', join(CARDS, `${m.id}.png`),
      '-vf', `scale=${W}:${H},fps=25,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${CARD_SEC - 0.5}:d=0.5`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-an', '-movflags', '+faststart',
      card,
    ], `${m.id} card`);
    rows.push({ id: `${m.id}-card`, title: `${m.title}（章节卡）`, kind: '章节卡', dur: CARD_SEC });
    dur += CARD_SEC;
    // 章节卡排在正文之前
    segFiles.splice(segFiles.length - 1, 0, card);
  }
  console.log(`   ✔ 时长 ${dur.toFixed(1)}s`);
}

/* concat */
const listFile = join(SEG, 'concat.txt');
writeFileSync(listFile, segFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

console.log('\n▶ 拼接主片 …');
await run([
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', listFile,
  '-c', 'copy', '-movflags', '+faststart',
  FINAL,
], 'concat');

const total = await duration(FINAL);
const size = statSync(FINAL).size;

const report = [
  '企业知识库 · RAG 全流程演示视频 — 时长清单',
  `生成时间：${new Date().toLocaleString('zh-CN')}`,
  `规格：${W}×${H} / 25fps / H.264 (libx264 crf20) / 无音轨 / MP4(+faststart)`,
  '',
  '章节明细：',
  ...rows.map((r, i) => `  ${String(i + 1).padStart(2, '0')}. [${r.kind}] ${r.title.padEnd(22)} ${r.dur.toFixed(1)}s`),
  '',
  `总时长：${total.toFixed(1)}s（${Math.floor(total / 60)} 分 ${Math.round(total % 60)} 秒）`,
  `文件大小：${(size / 1024 / 1024).toFixed(1)} MB`,
  `输出路径：${FINAL}`,
].join('\n');
writeFileSync(join(OUT, '时长清单.txt'), report, 'utf8');

console.log(`\n✅ 完成：${FINAL}`);
console.log(`   总时长 ${total.toFixed(1)}s · ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`   分段目录：${SEG}`);
