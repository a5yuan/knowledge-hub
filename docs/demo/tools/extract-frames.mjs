#!/usr/bin/env node
/** 抽帧验收：从成片按时间点导出 PNG，人工核对章节卡与关键画面 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FF = process.env.DEMO_FFMPEG
  ?? 'C:/Users/yuan/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe';
const SRC = join(HERE, 'out', 'rag-demo.mp4');
const DIR = join(HERE, 'out', 'verify');
mkdirSync(DIR, { recursive: true });

const POINTS = [
  [1.2, 'ch1-card'], [6.0, 'ch1-log'],
  [11.0, 'ch2-card'], [20.0, 'ch2-upload'], [40.0, 'ch2-parse'], [55.0, 'ch2-published'],
  [60.5, 'ch3-card'], [78.0, 'ch3-answer'],
  [89.5, 'ch4-card'], [120.0, 'ch4-answer'],
  [130.5, 'ch5-card'], [165.0, 'ch5-answer'],
  [184.0, 'ch6-card'], [198.0, 'ch6-answer'],
];

const one = (t, name) => new Promise((res) => {
  execFile(FF, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(t), '-i', SRC, '-frames:v', '1', '-q:v', '2',
    join(DIR, `${name}.png`),
  ], (e) => res(!e));
});

for (const [t, name] of POINTS) {
  const ok = await one(t, name);
  console.log(`${ok ? '✔' : '✘'} ${String(t).padStart(6)}s  ${name}.png`);
}
