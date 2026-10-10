#!/usr/bin/env node
/**
 * 演示视频旁白生成器
 *
 * 流程：
 *   1. 逐块调用 DashScope qwen3-tts-instruct-flash 合成 wav（Kai 音色 + 指令控制）
 *   2. 量每块实际时长，按章拼接（块间插静音）
 *   3. 每章用 atempo 缩放到与该章画面严格等长（含 2.4s 章节卡）
 *   4. 六章串成完整音轨；同步产出 ASS 硬字幕与时间码表
 *   5. 可选：把音轨混流进成片并烧字幕
 *
 * 用法：
 *   node narrate.mjs --check   # 只打印时长预算表，不调用 API
 *   node narrate.mjs --tts     # 合成 + 对齐 + 字幕 + 音轨
 *   node narrate.mjs --mux     # 混流 + 烧字幕（依赖 --tts 的产物）
 *   node narrate.mjs           # 全部执行
 */

import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NARRATION, BODY_DUR, CARD_SEC, VOICE, MODEL, INSTRUCTION, planReport } from './narration.mjs';

/* ───────────────────────── 配置 ───────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..', '..', '..');
const OUT = join(HERE, 'out');
const NAR = join(OUT, 'narration');
const RAW = join(NAR, 'raw');
const DOCS = join(WS, 'docs', 'demo');
const NARDOC = join(DOCS, 'narration');

const FF = process.env.DEMO_FFMPEG
  ?? 'C:/Users/yuan/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const FP = FF.replace(/ffmpeg\.exe$/, 'ffprobe.exe');

const SOURCE_MP4 = join(DOCS, '企业知识库-RAG全流程演示-2026-10-09.mp4');
const FINAL_MP4 = join(DOCS, '企业知识库-RAG全流程演示-配音版-2026-10-10.mp4');
const TRACK = join(NARDOC, 'narration.m4a');
const ASS = join(NAR, 'narration.ass');
const CHECK = process.argv.includes('--check');
const DO_TTS = process.argv.includes('--tts') || (!CHECK && !process.argv.includes('--mux'));
const DO_MUX = process.argv.includes('--mux') || (!CHECK && !process.argv.includes('--tts'));

/** 块间静音（秒） */
const GAP = 0.4;
/** 章节卡台词说完后留的尾巴（秒），让章节卡有呼吸 */
const CARD_TAIL = 0.35;
/** 采样率：与 DashScope 输出一致，避免中途重采样 */
const SR = 24000;
/** atempo 允许范围，超出说明讲稿字数控制失败，需要人工改稿 */
const ATEMPO_MIN = 0.85;
const ATEMPO_MAX = 1.18;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 工具 ───────────────────────── */

const sh = (args, label = 'ffmpeg') =>
  new Promise((res, rej) => {
    execFile(FF, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`\n❌ ${label} 失败：\n${String(stderr || '').split('\n').slice(-12).join('\n')}`);
        return rej(err);
      }
      res(String(stderr || ''));
    });
  });

const run = (bin, args, label) =>
  new Promise((res, rej) => {
    execFile(bin, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`\n❌ ${label} 失败：\n${String(stderr || '').split('\n').slice(-12).join('\n')}`);
        return rej(err);
      }
      res(String(stdout || ''));
    });
  });

async function duration(file) {
  const out = await run(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 'probe');
  return Number(out.trim()) || 0;
}

/** 载入 .env 中的 DashScope key */
function loadKey() {
  const env = join(WS, 'knowledge-hub-backend', '.env');
  if (!existsSync(env)) throw new Error(`未找到 ${env}`);
  for (const line of readFileSync(env, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^OPENAI_API_KEY=(.+)$/);
    if (m) return m[1].trim();
  }
  throw new Error('未在 .env 中找到 OPENAI_API_KEY');
}

const EP = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

/** 合成一段文本并落盘为 wav */
async function tts(text, dst, key) {
  if (existsSync(dst) && statSync(dst).size > 1000) return 'cached';
  const body = {
    model: MODEL,
    input: { text, voice: VOICE, language_type: 'Chinese', instructions: INSTRUCTION },
  };
  let json;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(EP, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      json = await r.json();
      if (r.ok && json?.output?.audio?.url) break;
      if (attempt === 4) {
        throw new Error(`TTS 失败 (${r.status}): ${JSON.stringify(json).slice(0, 260)}`);
      }
    } catch (e) {
      if (attempt === 4) throw e;
    }
    await sleep(1200 * attempt);
  }
  const url = json.output.audio.url;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(dst, buf);
  return 'ok';
}

const assTime = (s) => {
  const v = Math.max(0, s);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = v % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};

/* ───────────────────────── 计划表 ───────────────────────── */

function printPlan() {
  const rows = planReport();
  console.log('\n旁白时长预算（语速基准 5.5 字/秒，块间静音 0.4s）\n');
  console.log('章节  块数  字数  预估时长  画面时长   占比   卡台词   卡余量');
  console.log('─'.repeat(78));
  let sumEst = 0;
  let sumTarget = 0;
  for (const r of rows) {
    sumEst += r.est;
    sumTarget += r.target;
    const flag = r.ratio > ATEMPO_MAX || r.ratio < ATEMPO_MIN ? ' ⚠' : '';
    console.log(
      `${r.id}   ${String(r.blocks).padStart(3)}  ${String(r.full).padStart(4)}  ` +
      `${String(r.est).padStart(7)}s  ${String(r.target).padStart(7)}s  ` +
      `${String(r.ratio).padStart(6)}  ${String(r.cardEst).padStart(6)}s  ` +
      `${String(r.cardSlack).padStart(6)}s${flag}`,
    );
  }
  console.log('─'.repeat(78));
  console.log(
    `合计   ${String(rows.reduce((a, b) => a + b.blocks, 0)).padStart(3)}  ` +
    `${String(rows.reduce((a, b) => a + b.full, 0)).padStart(4)}  ` +
    `${sumEst.toFixed(1).padStart(7)}s  ${sumTarget.toFixed(1).padStart(7)}s  ` +
    `${(sumEst / sumTarget).toFixed(3)}`,
  );
  console.log(
    `\natempo 允许区间 ${ATEMPO_MIN}~${ATEMPO_MAX}；占比 >${ATEMPO_MAX} 表示台词太长需删字，` +
    `<${ATEMPO_MIN} 表示台词太少需补字。`,
  );
  console.log(`卡余量为负表示章节卡台词超出 ${CARD_SEC}s（含 0.35s 尾巴），需要缩短。\n`);
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function buildTts() {
  for (const d of [NAR, RAW, NARDOC]) mkdirSync(d, { recursive: true });
  const key = loadKey();

  // 静音垫片
  const SIL = join(NAR, 'gap.wav');
  if (!existsSync(SIL)) {
    await sh(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `anullsrc=r=${SR}:cl=mono`, '-t', String(GAP), '-c:a', 'pcm_s16le', SIL], 'silence');
  }

  const chapters = [];
  let cursor = 0; // 成片绝对时间轴

  for (const ch of NARRATION) {
    const targetBody = BODY_DUR[ch.id];
    console.log(`\n[${ch.id}] ${ch.title}  （画面 ${targetBody}s）`);

    // ---- 章节卡台词 ----
    const cardFile = join(RAW, `${ch.id}-card.wav`);
    process.stdout.write('   章节卡 … ');
    await tts(ch.card, cardFile, key);
    let cardDur = await duration(cardFile);
    let cardTempo = 1;
    let cardFile2 = cardFile;
    if (cardDur + CARD_TAIL > CARD_SEC) {
      cardTempo = cardDur / (CARD_SEC - CARD_TAIL);
      const fixed = join(NAR, `${ch.id}-card-fixed.wav`);
      await sh(['-y', '-hide_banner', '-loglevel', 'error', '-i', cardFile,
        '-filter:a', `atempo=${cardTempo.toFixed(4)}`, '-ar', String(SR), '-ac', '1',
        '-c:a', 'pcm_s16le', fixed], `${ch.id} card atempo`);
      cardFile2 = fixed;
      cardDur = await duration(fixed);
    }
    console.log(`${cardDur.toFixed(2)}s${cardTempo !== 1 ? ` (加速 ${cardTempo.toFixed(2)}x)` : ''}`);

    // ---- 正文各块 ----
    const blocks = [];
    for (let i = 0; i < ch.blocks.length; i++) {
      const f = join(RAW, `${ch.id}-b${String(i + 1).padStart(2, '0')}.wav`);
      process.stdout.write(`   块 ${i + 1}/${ch.blocks.length} … `);
      const st = await tts(ch.blocks[i], f, key);
      const d = await duration(f);
      blocks.push({ text: ch.blocks[i], file: f, dur: d });
      console.log(`${d.toFixed(2)}s${st === 'cached' ? ' (缓存)' : ''}`);
    }

    // ---- 拼接（块间插静音）----
    const listFile = join(NAR, `${ch.id}-list.txt`);
    const parts = [];
    blocks.forEach((b, i) => {
      parts.push(b.file);
      if (i < blocks.length - 1) parts.push(SIL);
    });
    writeFileSync(listFile, parts.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
    const joined = join(NAR, `${ch.id}-joined.wav`);
    await sh(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
      '-i', listFile, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', joined], `${ch.id} concat`);

    const joinedDur = await duration(joined);
    const tempo = joinedDur / targetBody;

    // ---- 每块在缩放前的时间轴 ----
    let t = 0;
    for (const b of blocks) {
      b.startRaw = t;
      t += b.dur + GAP;
    }

    console.log(
      `   拼接 ${joinedDur.toFixed(2)}s → 目标 ${targetBody}s   atempo ${tempo.toFixed(4)}x` +
      (tempo > ATEMPO_MAX || tempo < ATEMPO_MIN ? '  ⚠ 超出安全区' : ''),
    );

    // ---- atempo + 补/裁到精确长度 ----
    const bodyFile = join(NAR, `${ch.id}-body.wav`);
    await sh(['-y', '-hide_banner', '-loglevel', 'error', '-i', joined,
      '-filter:a', `atempo=${tempo.toFixed(6)}`, '-ar', String(SR), '-ac', '1',
      '-c:a', 'pcm_s16le', bodyFile], `${ch.id} atempo`);

    // ---- 章节卡 + 正文 合成整章 ----
    const chFile = join(NAR, `${ch.id}.wav`);
    const padFile = join(NAR, `${ch.id}-pad.wav`);
    await sh(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `anullsrc=r=${SR}:cl=mono`, '-t', String(Math.max(0, CARD_SEC - cardDur)),
      '-c:a', 'pcm_s16le', padFile], `${ch.id} pad`);
    const chList = join(NAR, `${ch.id}-chlist.txt`);
    writeFileSync(chList, [cardFile2, padFile, bodyFile]
      .map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
    await sh(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
      '-i', chList, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', chFile], `${ch.id} assembly`);

    // ---- 记录绝对时间码（用于字幕）----
    const chStart = cursor;
    const bodyStart = chStart + CARD_SEC;
    const subs = blocks.map((b) => ({
      text: b.text,
      start: bodyStart + b.startRaw / tempo,
      end: bodyStart + (b.startRaw + b.dur) / tempo,
    }));
    chapters.push({ id: ch.id, no: ch.no, title: ch.title, start: chStart, bodyStart, dur: CARD_SEC + targetBody, subs });
    cursor += CARD_SEC + targetBody;
  }

  // ---- 六章串成完整音轨 ----
  const trackList = join(NAR, 'track-list.txt');
  writeFileSync(trackList, chapters.map((c) => `file '${join(NAR, `${c.id}.wav`).replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const trackWav = join(NAR, 'narration.wav');
  await sh(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
    '-i', trackList, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', trackWav], 'track concat');
  const trackDur = await duration(trackWav);
  console.log(`\n▶ 完整音轨 ${trackDur.toFixed(2)}s`);

  // ---- 导出 m4a ----
  await sh(['-y', '-hide_banner', '-loglevel', 'error', '-i', trackWav,
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', TRACK], 'm4a');
  console.log(`   ✔ ${TRACK}`);

  // ---- 生成 ASS 字幕 ----
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1440',
    'PlayResY: 900',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: NARR,Microsoft YaHei,33,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,0,0,0,0,100,100,0.4,0,1,2.6,0.8,2,70,70,48,134',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
  const events = [];
  for (const c of chapters) {
    for (const s of c.subs) {
      if (s.end - s.start < 0.35) continue;
      events.push(`Dialogue: 0,${assTime(s.start)},${assTime(s.end)},NARR,,0,0,0,,${s.text}`);
    }
  }
  writeFileSync(ASS, header + '\n' + events.join('\n') + '\n', 'utf8');
  console.log(`   ✔ ${ASS}  （${events.length} 条字幕）`);

  // ---- 时间码表 ----
  const lines = [
    '企业知识库 · RAG 全流程演示（配音版）— 旁白时间码表',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    `音色：${VOICE}   模型：${MODEL}`,
    `音轨总长：${trackDur.toFixed(2)}s（无音轨原片 205.60s）`,
    '',
  ];
  for (const c of chapters) {
    lines.push(`【第 ${c.no} 章】${c.title}    章节区间 ${c.start.toFixed(2)}s - ${(c.start + c.dur).toFixed(2)}s`);
    lines.push(`   ${c.start.toFixed(2)}s - ${(c.start + CARD_SEC).toFixed(2)}s  [章节卡]`);
    for (const s of c.subs) {
      lines.push(`   ${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s  ${s.text}`);
    }
    lines.push('');
  }
  const tcFile = join(DOCS, '旁白时间码表.txt');
  writeFileSync(tcFile, lines.join('\n'), 'utf8');
  console.log(`   ✔ ${tcFile}`);

  // ---- 讲稿 Markdown ----
  const md = [
    '# 演示视频旁白讲稿',
    '',
    `- 音色：\`${VOICE}\`　模型：\`${MODEL}\``,
    '- 指令：' + INSTRUCTION,
    `- 语速基准：5.5 字/秒（实测口径）　块间静音：${GAP}s`,
    `- 全长：${trackDur.toFixed(2)}s，与原片 205.60s 严格等长（画面零改动）`,
    '',
  ];
  for (const c of NARRATION) {
    const ch = chapters.find((x) => x.id === c.id);
    md.push(`## 第 ${c.no} 章 · ${c.title}`);
    md.push('');
    md.push(`> 画面区间 ${ch.start.toFixed(2)}s - ${(ch.start + ch.dur).toFixed(2)}s`);
    md.push('');
    md.push(`**章节卡（${CARD_SEC}s）**：${c.card}`);
    md.push('');
    for (const s of ch.subs) {
      md.push(`- \`${s.start.toFixed(2)}s\` ${s.text}`);
    }
    md.push('');
  }
  const mdFile = join(NARDOC, '讲稿.md');
  writeFileSync(mdFile, md.join('\n'), 'utf8');
  console.log(`   ✔ ${mdFile}`);

  return { trackDur, chapters, trackWav };
}

async function mux() {
  if (!existsSync(TRACK)) throw new Error(`未找到音轨 ${TRACK}，请先运行 --tts`);
  if (!existsSync(SOURCE_MP4)) throw new Error(`未找到原片 ${SOURCE_MP4}`);
  if (!existsSync(ASS)) throw new Error(`未找到字幕 ${ASS}`);

  console.log('\n▶ 混流 + 烧字幕 …');
  // subtitles 滤镜会把「盘符冒号」当成参数分隔符，因此把工作目录切到字幕所在目录、
  // 只用裸文件名引用，彻底绕开路径转义问题。
  await new Promise((res, rej) => {
    execFile(FF, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', SOURCE_MP4,
      '-i', TRACK,
      '-vf', 'subtitles=narration.ass',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      // TTS 原始输出平均只有 −25 dBFS、且有轻微削波，这里归一到视频旁白常规响度
      // （−16 LUFS / 真峰 −1.5 dBTP），避免观众要手动调大音量
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-map', '0:v:0', '-map', '1:a:0',
      '-shortest', '-movflags', '+faststart',
      FINAL_MP4,
    ], { maxBuffer: 1 << 24, cwd: NAR }, (err, stdout, stderr) => {
      if (err) {
        console.error(`\n❌ mux 失败：\n${String(stderr || '').split('\n').slice(-14).join('\n')}`);
        return rej(err);
      }
      res();
    });
  });

  const d = await duration(FINAL_MP4);
  const sz = statSync(FINAL_MP4).size;
  console.log(`\n✅ 完成：${FINAL_MP4}`);
  console.log(`   ${d.toFixed(2)}s · ${(sz / 1024 / 1024).toFixed(1)} MB`);
}

/* ───────────────────────── 入口 ───────────────────────── */

if (CHECK) {
  printPlan();
} else {
  console.log('='.repeat(60));
  console.log('演示视频旁白生成');
  console.log(`音色 ${VOICE} · 模型 ${MODEL}`);
  console.log('='.repeat(60));
  if (DO_TTS) {
    printPlan();
    await buildTts();
  }
  if (DO_MUX) await mux();
  console.log('\n全部完成。');
}
