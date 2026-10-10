#!/usr/bin/env node
/**
 * 精简版演示视频（<=120s）画面剪辑
 *
 * 策略：不重录、不重跑浏览器。从六章原始录像里把「等待系统响应」的低信息密度区间
 * 抽出来单独加速（叠快进角标），其余操作段保持原速，再接上 1.2s 章节卡拼成主片。
 *
 * 切割边界来源：
 * - ch2 由 ffmpeg 场景检测实测（16.0s -> 36.6s 画面完全静止，等 MinerU 解析）
 * - ch3~ch6 由录制脚本的 PACE 常量反推（总时长 − 已知固定延时 = 等待段），
 *   这几章是渐进式文字渲染，场景检测抓不到
 *
 * 用法：node build-lite.mjs [--only=ch2,ch3] [--dry]
 */

import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..', '..', '..');
const DOCS = join(WS, 'docs', 'demo');
const RAW = join(WS, '.workbuddy', 'tools', 'demo-recorder', 'out');
const WEBM = join(RAW, 'webm');
const CARDS = join(RAW, 'cards');
const OUT = join(RAW, 'lite');
const FINAL = join(DOCS, '企业知识库-RAG全流程演示-精简版-2026-10-10.mp4');

const FF = process.env.DEMO_FFMPEG
  ?? 'C:/Users/yuan/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';

const W = 1440;
const H = 900;
const FPS = 25;
/** 精简版章节卡时长（原版 2.4s，压到 1.2s 省 7.2s） */
const CARD_SEC = 1.2;

/**
 * 每章的加速方案。
 * boost = { from, to, rate }：把 from~to 区间按 rate 倍速播放（叠快进角标）
 * boost = null：整章原速
 * dur 为原始正文时长（webm 实测），用于校验切点合法性
 */
const PLAN = [
  { id: 'ch1', no: 1, dur: 7.32, boost: null },
  { id: 'ch2', no: 2, dur: 47.32, boost: { from: 16.0, to: 36.6, rate: 8, tag: '解析中' } },
  { id: 'ch3', no: 3, dur: 26.32, boost: { from: 6.6, to: 17.7, rate: 6, tag: '生成中' } },
  { id: 'ch4', no: 4, dur: 38.40, boost: { from: 7.7, to: 29.7, rate: 6, tag: '检索中' } },
  { id: 'ch5', no: 5, dur: 51.60, boost: { from: 10.4, to: 43.0, rate: 6, tag: '生成中' } },
  { id: 'ch6', no: 6, dur: 20.24, boost: { from: 6.2, to: 14.9, rate: 6, tag: '生成中' } },
];

const ARGS = process.argv.slice(2);
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '').split(',').filter(Boolean);
const DRY = ARGS.includes('--dry');

const run = (args, label) =>
  new Promise((res, rej) => {
    execFile(FF, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`\n❌ ${label} 失败：\n${String(stderr || '').split('\n').slice(-12).join('\n')}`);
        return rej(err);
      }
      res(String(stderr || ''));
    });
  });

async function duration(file) {
  const FP = FF.replace(/ffmpeg\.exe$/, 'ffprobe.exe');
  return new Promise((res) => {
    execFile(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      (e, out) => res(Number(String(out).trim()) || 0));
  });
}

/**
 * 快进角标：右下角半透明黑底 + 白字，兼标状态文案
 *
 * ⚠️ 字体路径有两个坑（本机 ffmpeg 9.0.2-full_build 实测）：
 * 1. `font='Microsoft YaHei'` 走 fontconfig，但这套构建缺默认配置文件，
 *    会直接段错误（Fontconfig error: Cannot load default config file）。
 * 2. `fontfile=C:/Windows/Fonts/...` 裸写也不行，filtergraph 解析器会把盘符冒号
 *    当参数分隔符吃掉，报 `No option name near '/Windows/Fonts/...'`。
 * 唯一可行写法：**单引号包裹 + 冒号前反斜杠转义** → fontfile='C\:/Windows/...'
 * （对照实验：相对路径 fontfile=msyhbd.ttc + cwd 也可，但要多复制一份字体）
 */
const FONT = `fontfile='C\\:/Windows/Fonts/msyhbd.ttc'`;

function badge(rate, tag) {
  const text = `>> ${rate}x  ${tag}`;
  return [
    `drawtext=${FONT}`,
    `text='${text}'`,
    `fontsize=30`,
    `fontcolor=white@0.94`,
    `x=w-tw-42`,
    `y=h-th-42`,
    `box=1`,
    `boxcolor=black@0.52`,
    `boxborderw=16`,
  ].join(':');
}

/** 构建单章的精简 filter_complex */
function chapterFilter(ch) {
  const scaleTail = `scale=${W}:${H}:flags=lanczos,fps=${FPS},format=yuv420p`;

  if (!ch.boost) {
    return {
      filter: `[0:v]setpts=PTS-STARTPTS,${scaleTail}[vout]`,
      map: '[vout]',
      expects: ch.dur,
    };
  }

  const { from, to, rate, tag } = ch.boost;
  const head = `[0:v]trim=start=0:end=${from},setpts=PTS-STARTPTS,fps=${FPS}[v1]`;
  const mid = `[0:v]trim=start=${from}:end=${to},setpts=(PTS-STARTPTS)/${rate},${badge(rate, tag)},fps=${FPS}[v2]`;
  const tail = `[0:v]trim=start=${to},setpts=PTS-STARTPTS,fps=${FPS}[v3]`;
  const cat = `[v1][v2][v3]concat=n=3:v=1:a=0,${scaleTail}[vout]`;
  return {
    filter: [head, mid, tail, cat].join(';'),
    map: '[vout]',
    expects: from + (to - from) / rate + (ch.dur - to),
  };
}

/* ─────────────────────── 主流程 ─────────────────────── */

const todo = (ONLY.length ? PLAN.filter((p) => ONLY.includes(p.id)) : PLAN)
  .filter((p) => existsSync(join(WEBM, `${p.id}.webm`)));

if (todo.length === 0) {
  console.error(`未找到原始片段（${WEBM}）。webm 录像保存在 .workbuddy 下，若已清理需重新录制。`);
  process.exit(1);
}
if (!existsSync(FF)) {
  console.error(`未找到 ffmpeg：${FF}`);
  process.exit(1);
}

// 预算表
console.log('\n▶ 精简版时间预算\n');
console.log('章   原长     加速段       倍率   加速后   精简后');
console.log('─'.repeat(62));
let sumBody = 0;
for (const p of PLAN) {
  const b = p.boost;
  const bLen = b ? b.to - b.from : 0;
  const after = b ? bLen / b.rate : 0;
  const lite = p.dur - bLen + after;
  sumBody += lite;
  console.log(
    `${p.id}  ${String(p.dur).padStart(6)}s  ` +
    `${b ? `${b.from}-${b.to}s`.padEnd(13) : '—'.padEnd(13)}  ` +
    `${b ? `${b.rate}x`.padStart(4) : ' — '.padStart(4)}  ` +
    `${after.toFixed(1).padStart(6)}s  ${lite.toFixed(2).padStart(7)}s`,
  );
}
console.log('─'.repeat(62));
const total = sumBody + todo.length * CARD_SEC;
console.log(`正文合计 ${sumBody.toFixed(1)}s + 章节卡 ${(todo.length * CARD_SEC).toFixed(1)}s = ${total.toFixed(1)}s`);
console.log(total <= 120 ? `✓ 在 120s 目标内（余量 ${(120 - total).toFixed(1)}s）` : `⚠ 超出 120s 目标 ${(total - 120).toFixed(1)}s`);

// 逐章校验切点
for (const p of PLAN) {
  if (p.boost && (p.boost.from < 0 || p.boost.to > p.dur)) {
    console.error(`\n❌ ${p.id} 加速区间 ${p.boost.from}-${p.boost.to} 超出正文长度 ${p.dur}s`);
    process.exit(1);
  }
}

// 总时长随各章实际加速后时长变化，这里用估算值做初判
if (DRY) {
  console.log('\n（--dry：只打印预算，不生成）');
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const segFiles = [];
const rows = [];

for (const ch of todo) {
  const src = join(WEBM, `${ch.id}.webm`);
  console.log(`\n[${ch.id}] 切割 + 加速 …`);
  const { filter, map, expects } = chapterFilter(ch);
  const body = join(OUT, `${ch.no}-body.mp4`);
  await run([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-filter_complex', filter,
    '-map', map,
    '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-r', String(FPS), '-movflags', '+faststart',
    body,
  ], `${ch.id} body`);
  const dur = await duration(body);
  const delta = dur - expects;
  console.log(`   ✔ 正文 ${dur.toFixed(2)}s（预期 ${expects.toFixed(2)}s，偏差 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}s）`);
  rows.push({ id: ch.id, kind: '正文', dur });
  segFiles.push(body);

  // 章节卡 1.2s
  const cardPng = join(CARDS, `${ch.id}.png`);
  if (!existsSync(cardPng)) {
    console.error(`   ❌ 缺少章节卡 ${cardPng}`);
    process.exit(1);
  }
  const card = join(OUT, `${ch.no}-card.mp4`);
  await run([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-loop', '1', '-t', String(CARD_SEC), '-i', cardPng,
    '-vf', `scale=${W}:${H},fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.25,fade=t=out:st=${CARD_SEC - 0.25}:d=0.25`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-an', '-movflags', '+faststart',
    card,
  ], `${ch.id} card`);
  rows.push({ id: `${ch.id}-card`, kind: '章节卡', dur: CARD_SEC });
  // 章节卡排在正文之前
  segFiles.splice(segFiles.length - 1, 0, card);
}

/* concat */
const listFile = join(OUT, 'concat.txt');
writeFileSync(listFile, segFiles.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');

console.log('\n▶ 拼接主片 …');
const liteRaw = join(OUT, 'lite-nocap.mp4');
await run([
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', listFile,
  '-c', 'copy', '-movflags', '+faststart',
  liteRaw,
], 'concat');

const totalDur = await duration(liteRaw);
const size = statSync(liteRaw).size;

/*
 * 输出「实际时长清单」，供 narrate.mjs --lite 做逐章 atempo 对齐。
 * 必须用实测值而不是预算值：ffmpeg 的 trim/setpts 会带来 ±0.03s 级别偏差，
 * 逐章累计起来就能让音画错位。
 */
const MANIFEST_DIR = join(HERE, 'out', 'lite');
mkdirSync(MANIFEST_DIR, { recursive: true });
const segments = PLAN
  .filter((p) => todo.some((t) => t.id === p.id))
  .map((p) => {
    const body = rows.find((r) => r.id === p.id);
    const card = rows.find((r) => r.id === `${p.id}-card`);
    return { id: p.id, no: p.no, card: card ? card.dur : CARD_SEC, body: body ? body.dur : p.dur };
  });
writeFileSync(join(MANIFEST_DIR, 'segments.json'), JSON.stringify(segments, null, 2), 'utf8');
console.log(`   ✔ 时长清单 ${join(MANIFEST_DIR, 'segments.json')}`);

/* 若超出 120s，提示但不自动改（改倍率需人工决策） */
const report = [
  '企业知识库 · RAG 全流程演示视频（精简版）— 时长清单',
  `生成时间：${new Date().toLocaleString('zh-CN')}`,
  `规格：${W}×${H} / ${FPS}fps / H.264 (libx264 crf20) / 无音轨 / MP4(+faststart)`,
  '',
  '分段明细（章节卡在正文之前）：',
  ...rows.map((r, i) => `  ${String(i + 1).padStart(2, '0')}. [${r.kind}] ${r.id.padEnd(10)} ${r.dur.toFixed(2)}s`),
  '',
  `总时长：${totalDur.toFixed(2)}s（${Math.floor(totalDur / 60)} 分 ${(totalDur % 60).toFixed(1)} 秒）`,
  `目标：<= 120s  ${totalDur <= 120 ? '✓ 达标' : `✗ 超出 ${(totalDur - 120).toFixed(1)}s`}`,
  `文件大小：${(size / 1024 / 1024).toFixed(1)} MB`,
  '',
  '加速段明细：',
  ...PLAN.filter((p) => p.boost).map((p) =>
    `  ${p.id}  ${p.boost.from}s-${p.boost.to}s（${(p.boost.to - p.boost.from).toFixed(1)}s）÷${p.boost.rate} => ${((p.boost.to - p.boost.from) / p.boost.rate).toFixed(1)}s`),
].join('\n');
writeFileSync(join(OUT, '时长清单-精简版.txt'), report, 'utf8');

/* 把无音轨成片挪到 docs，供 narrate 混流 */
const { copyFileSync } = await import('node:fs');
copyFileSync(liteRaw, join(DOCS, '企业知识库-RAG全流程演示-精简版-无声-2026-10-10.mp4'));

console.log(`\n✅ 精简版画面完成：${totalDur.toFixed(2)}s · ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`   中间产物：${OUT}`);
console.log(`   无声成片：${join(DOCS, '企业知识库-RAG全流程演示-精简版-无声-2026-10-10.mp4')}`);
if (totalDur > 120) console.log(`\n⚠ 超出 120s 目标 ${(totalDur - 120).toFixed(1)}s，需要调高倍率或加长加速区间。`);
