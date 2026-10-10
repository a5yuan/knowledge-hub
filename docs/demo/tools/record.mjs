#!/usr/bin/env node
/**
 * 企业知识库 · RAG 全流程演示视频录制器
 *
 * 用 Playwright 脚本驱动真实浏览器，按章节逐段录制，产出 WebM（后由 ffmpeg 转 MP4 拼接）。
 *
 * 设计要点：
 * - 每章一个独立 BrowserContext：context.close() 即落盘一段 WebM，单章失败可单独重录
 * - 真实操作，不 mock：登录 / 上传 / 审核 / 提问全部打到真实后端
 * - 字幕条由 addInitScript 注入，mode='app' 挤压应用视口（避免遮挡），mode='doc' 仅加顶部留白
 * - 等待策略：SSE 流式回答以「发送按钮回归 + 正文长度稳定」双条件判定结束，不靠固定 sleep 赌
 *
 * 用法：
 *   node record.mjs                 # 录制全部章节
 *   node record.mjs --only=ch3,ch4  # 只录指定章节
 *   node record.mjs --dry           # 不录视频，只跑流程并逐步截图（用于校验选择器）
 */

import { chromium } from 'playwright';
import {
  mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAPTER_META, TOTAL } from './chapters.mjs';

/* ───────────────────────────── 配置 ───────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..', '..', '..');
const BASE = process.env.DEMO_BASE ?? 'http://127.0.0.1:5173';
const API = process.env.DEMO_API ?? 'http://127.0.0.1:3000';
const USER = process.env.DEMO_USER ?? 'admin';
/** 留空则自动从登录页底部提示里解析（提示里写的就是演示账号） */
const PW_ENV = process.env.DEMO_PW ?? '';

const ASSETS = join(WS, 'docs', 'demo', 'assets');
const PDF = join(ASSETS, '钢铁行业数字化转型实施指南.pdf');
const STARTUP_HTML = pathToFileURL(join(ASSETS, 'startup.html')).href;

const OUT = join(HERE, 'out');
const RAW = join(OUT, 'webm');
const SHOTS = join(OUT, 'shots');
const W = 1440;
const H = 900;

/** 节奏参数（慢节奏：留白给观众看清每一步） */
const PACE = {
  afterNav: 1400,
  afterClick: 700,
  afterFill: 500,
  beforeSubmit: 900,
  typeDelay: 95,
  holdAnswer: 2600,
  chapterLead: 1500,
};

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) ?? '')
  .replace('--only=', '')
  .split(',')
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────────── 字幕条注入 ───────────────────────────── */

const BAR_CSS = `
#__demo_bar{position:fixed;top:0;left:0;right:0;height:48px;z-index:2147483647;
  display:flex;align-items:center;gap:14px;padding:0 22px;
  background:linear-gradient(90deg,#0a1120 0%,#12203a 60%,#16294a 100%);
  border-bottom:2px solid #1a66ff;color:#e8eefc;
  font:600 16px/1 "PingFang SC","Microsoft YaHei",sans-serif;letter-spacing:.3px;
  box-shadow:0 2px 16px rgba(0,0,0,.5)}
#__demo_bar .no{background:#1a66ff;border-radius:6px;padding:5px 11px;font-size:13.5px;
  white-space:nowrap;box-shadow:0 0 0 1px rgba(255,255,255,.12) inset}
#__demo_bar .ti{font-size:17px;white-space:nowrap}
#__demo_bar .tg{margin-left:auto;font-weight:400;font-size:12.5px;color:#8fb4ff;
  border:1px solid #2c4c85;background:#0c1a2e;border-radius:6px;padding:5px 13px;
  white-space:nowrap;font-family:"Cascadia Code",Consolas,monospace}
`;

function subtitleScript({ no, total, title, tag, mode }) {
  const layout =
    mode === 'doc'
      ? 'body{padding-top:48px !important}'
      : `html{overflow:hidden !important}
         body{height:100vh !important;padding-top:48px !important;box-sizing:border-box !important}
         #app{height:100% !important}`;
  return `(() => {
    const D = ${JSON.stringify({ no, total, title, tag })};
    const CSS = ${JSON.stringify(BAR_CSS)} + ${JSON.stringify(layout)};
    const apply = () => {
      if (!document.head || !document.body) return;
      let s = document.getElementById('__demo_style');
      if (!s) { s = document.createElement('style'); s.id = '__demo_style'; document.head.appendChild(s); }
      s.textContent = CSS;
      let b = document.getElementById('__demo_bar');
      if (!b) {
        b = document.createElement('div');
        b.id = '__demo_bar';
        b.innerHTML = '<span class="no">第 ' + D.no + ' / ' + D.total + ' 章</span>'
          + '<span class="ti">' + D.title + '</span>'
          + '<span class="tg">' + D.tag + '</span>';
        document.body.appendChild(b);
      } else {
        b.querySelector('.no').textContent = '第 ' + D.no + ' / ' + D.total + ' 章';
        b.querySelector('.ti').textContent = D.title;
        b.querySelector('.tg').textContent = D.tag;
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply);
      setTimeout(apply, 60); setTimeout(apply, 300);
    } else { apply(); setTimeout(apply, 60); }
  })();`;
}

/* ───────────────────────────── 通用动作 ───────────────────────────── */

async function shot(page, name) {
  if (!DRY) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  console.log(`   📸 ${name}.png`);
}

/** 平滑滚动整页（用于启动日志页） */
async function scrollThrough(page, { step = 150, pause = 28, leadIn = 1200, tail = 2200 } = {}) {
  await sleep(leadIn);
  let y = 0;
  for (;;) {
    const { h, vh } = await page.evaluate(() => ({
      h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      vh: window.innerHeight,
    }));
    if (y >= h - vh) break;
    y = Math.min(y + step, h - vh);
    await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'auto' }), y);
    await sleep(pause);
  }
  await sleep(tail);
}

/** 等 SSE 流式回答结束：发送按钮回归 + 正文长度稳定 */
async function waitAnswer(page, { timeout = 180000, stableMs = 2500 } = {}) {
  const t0 = Date.now();
  // 第一段：必须看到「停止」按钮。刚点完发送时 DOM 可能还没切到流式态，
  // 直接判「发送按钮在 → 已结束」会当场返回、把回答截断。
  await page
    .waitForFunction(
      () => /停止/.test(document.querySelector('.send-btn')?.textContent ?? ''),
      null,
      { timeout: 15000 },
    )
    .catch(() => console.log('   ⚠ 未观察到流式态（回答可能极短），继续等待'));
  // 第二段：流式结束 —— 按钮回到「发送」
  await page.waitForFunction(
    () => /发送/.test(document.querySelector('.send-btn')?.textContent ?? ''),
    null,
    { timeout },
  );
  let last = -1;
  let sameSince = Date.now();
  for (;;) {
    const len = await page.evaluate(
      () => (document.querySelector('.msg-flow')?.textContent ?? '').length,
    );
    if (len !== last) {
      last = len;
      sameSince = Date.now();
    } else if (Date.now() - sameSince >= stableMs) break;
    if (Date.now() - t0 > timeout) break;
    await sleep(300);
  }
}

/** 在聊天区提问并等回答 */
async function ask(page, question, { needle } = {}) {
  const box = page.locator('.input-bar textarea');
  await box.click();
  await sleep(300);
  await box.pressSequentially(question, { delay: PACE.typeDelay });
  await sleep(PACE.beforeSubmit);
  await page.locator('.send-btn').click();
  await waitAnswer(page);
  await sleep(900);
  if (needle) {
    // 等关键结论渲染出来再继续，避免录到一半内容
    await page
      .waitForFunction(
        (t) => (document.querySelector('.msg-flow')?.textContent ?? '').includes(t),
        needle,
        { timeout: 30000 },
      )
      .catch(() => console.log(`   ⚠ 未等到关键字「${needle}」，继续`));
  }
  await sleep(PACE.holdAnswer);
}

/** 滚到聊天内容底部（展示正文与引用来源） */
async function scrollChatToBottom(page, { steps = 8, pause = 420 } = {}) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => {
      const el = document.querySelector('.msg-flow');
      if (el) el.scrollTop = el.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(pause);
  }
}

/* ───────────────────────────── 登录态 ───────────────────────────── */

let PASSWORD = PW_ENV;

async function apiLogin(pw) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: pw }),
  });
  if (!r.ok) return null;
  return r.json();
}

async function resolvePassword(browser) {
  if (PASSWORD) {
    const ok = await apiLogin(PASSWORD);
    if (ok) return PASSWORD;
    console.log('   ⚠ DEMO_PW 登录失败，回退到从登录页解析');
  }
  // 缓存（reset-corpus.mjs 复用，避免重复解析）
  const cacheFile = 'D:/Temp/demo-logs/.admin-pw';
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile, 'utf8').trim();
    if (cached && (await apiLogin(cached))) {
      console.log('   ✔ 使用缓存的账号密码');
      return cached;
    }
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-tip', { timeout: 20000 });
  const tip = await page.locator('.login-tip').innerText();
  await ctx.close();
  const m = tip.match(new RegExp(`${USER}\\s*[/／]\\s*([^\\s（(]+)`));
  if (!m) throw new Error(`无法从登录页提示解析密码：${tip}`);
  const pw = m[1];
  if (!(await apiLogin(pw))) throw new Error('从登录页解析到的密码无法登录');
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, pw, 'utf8');
  console.log(`   ✔ 从登录页提示解析到 ${USER} 的密码（长度 ${pw.length}）并已缓存`);
  return pw;
}

/** ch3-ch6 跳过登录 UI：直接注入 token */
function authInitScript(auth) {
  return `(() => {
    try {
      localStorage.setItem('kh_session_v', '1');
      localStorage.setItem('kh_token', ${JSON.stringify(auth.accessToken)});
      localStorage.setItem('kh_refresh_token', ${JSON.stringify(auth.refreshToken)});
      localStorage.setItem('kh_token_exp', ${JSON.stringify(String(auth.expiresIn ?? 7200))});
    } catch (e) {}
  })();`;
}

/* ───────────────────────────── 章节 ───────────────────────────── */

/** 第 1 章：项目启动过程（终端风真实日志回放 + 滚动） */
async function ch1(ctx, page) {
  await page.goto(STARTUP_HTML, { waitUntil: 'load' });
  await sleep(PACE.chapterLead);
  await shot(page, 'ch1-01-top');
  await scrollThrough(page, { step: 130, pause: 30 });
  await shot(page, 'ch1-02-bottom');
  await sleep(1200);
}

/** 第 2 章：知识库构建（登录 → 上传 → 解析 → 提审 → 审核发布 → ES 切片） */
async function ch2(ctx, page) {
  // 登录
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.login-card');
  await sleep(PACE.chapterLead);
  await shot(page, 'ch2-01-login');

  const u = page.locator('input[placeholder="用户名"]');
  const p = page.locator('input[placeholder="密码"]');
  await u.click();
  await u.pressSequentially(USER, { delay: PACE.typeDelay });
  await sleep(PACE.afterFill);
  await p.click();
  await p.pressSequentially(PASSWORD, { delay: PACE.typeDelay });
  await sleep(PACE.beforeSubmit);
  await page.locator('.login-btn').click();
  await page.waitForURL(/dashboard/, { timeout: 30000 });
  await sleep(2200);
  await shot(page, 'ch2-02-dashboard');

  // 文档管理
  await page.goto(`${BASE}/documents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.doc-table', { timeout: 30000 }).catch(() => {});
  await sleep(PACE.afterNav);
  await shot(page, 'ch2-03-documents-empty');

  // 上传
  await page.locator('button:has-text("批量上传")').first().click();
  await page.waitForSelector('.el-dialog', { timeout: 15000 });
  await sleep(900);
  await page.setInputFiles('.el-dialog input[type="file"]', PDF);
  await sleep(1400);
  await shot(page, 'ch2-04-dialog-file');

  // 分类（必填）
  await page.locator('.el-dialog .el-select').first().click();
  await sleep(700);
  await page.locator('.el-select-dropdown__item:visible').first().click();
  await sleep(700);

  // 可见范围 → 公司可见
  await page.locator('.el-dialog .el-radio:has-text("公司可见")').first().click();
  await sleep(600);
  await shot(page, 'ch2-05-dialog-meta');

  await page.locator('.el-dialog__footer button:has-text("开始上传")').click();
  await page.waitForSelector('.el-message--success', { timeout: 90000 });
  await sleep(2200);
  await shot(page, 'ch2-06-uploaded');

  // 等解析完成（列表里出现「解析完成」标签）
  await page
    .waitForFunction(
      () => document.body.textContent?.includes('解析完成'),
      null,
      { timeout: 240000 },
    )
    .catch(() => console.log('   ⚠ 未在 4 分钟内看到「解析完成」，继续'));
  await sleep(1600);
  await shot(page, 'ch2-07-parsed');

  // 提交审核
  await page.locator('.doc-table tbody tr').first().locator('button:has(.el-icon)').last().click();
  await sleep(800);
  await page.locator('.el-dropdown-menu__item:has-text("提交审核")').click();
  await sleep(2200);
  await shot(page, 'ch2-08-submitted');

  // 审核工作台 → 通过
  await page.goto(`${BASE}/documents/reviews`, { waitUntil: 'domcontentloaded' });
  await sleep(PACE.afterNav);
  await page
    .waitForSelector('button:has-text("通过")', { timeout: 40000 })
    .catch(() => console.log('   ⚠ 审核列表未出现「通过」按钮'));
  await sleep(900);
  await shot(page, 'ch2-09-reviews');
  await page.locator('button:has-text("通过")').first().click();
  await sleep(900);
  await page.locator('.el-message-box__btns button:has-text("通过")').click();
  await page.waitForSelector('.el-message--success', { timeout: 60000 }).catch(() => {});
  await sleep(2600);
  await shot(page, 'ch2-10-approved');

  // 回列表看最终状态：已发布
  await page.goto(`${BASE}/documents`, { waitUntil: 'domcontentloaded' });
  await sleep(PACE.afterNav + 800);
  await shot(page, 'ch2-11-published');
  await sleep(1200);
}

/** 通用：进入 AI 问答页 */
async function gotoAi(page) {
  await page.goto(`${BASE}/ai-qa`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.input-bar textarea', { timeout: 40000 });
  await sleep(PACE.afterNav + 600);
}

/** 点「新建对话」：清空选中会话，下一条消息自动开新会话（保证「每章只跑一轮」） */
async function newChat(page) {
  await page.locator('button.nav-item.create').click().catch(() => {});
  await sleep(900);
}

const ch3 = async (ctx, page) => {
  await gotoAi(page);
  await shot(page, 'ch3-01-idle');
  await ask(page, '钢铁行业数字化转型的发展目标里，关键工序数控化率要达到多少？', { needle: '80%' });
  await shot(page, 'ch3-02-answered');
  await scrollChatToBottom(page);
  await shot(page, 'ch3-03-sources');
  await sleep(1600);
};

const ch4 = async (ctx, page) => {
  await gotoAi(page);
  await newChat(page);
  await sleep(1000);
  await ask(page, '2026 年钢铁行业数字化转型有哪些最新政策？');
  await shot(page, 'ch4-01-answered');
  await scrollChatToBottom(page);
  await shot(page, 'ch4-02-sources');
  await sleep(1600);
};

const ch5 = async (ctx, page) => {
  await gotoAi(page);
  await newChat(page);
  await sleep(1000);
  await ask(
    page,
    '我们知识库里的钢铁行业数字化转型指南提出了哪些重点任务？另外工信部近期还发布了哪些相关配套政策？',
  );
  await shot(page, 'ch5-01-answered');
  await scrollChatToBottom(page);
  await shot(page, 'ch5-02-sources');
  await sleep(1600);
};

const ch6 = async (ctx, page) => {
  await gotoAi(page);
  await newChat(page);
  await sleep(1000);
  await ask(page, '你好，你是谁？');
  await shot(page, 'ch6-01-chitchat');
  await sleep(1600);
};

/** 章节实现按 id 挂到共享元数据上（元数据见 chapters.mjs，后期脚本复用） */
const RUNS = { ch1, ch2, ch3, ch4, ch5, ch6 };
/** 需要预先注入 token 的章节（跳过登录 UI） */
const NEEDS_AUTH = new Set(['ch3', 'ch4', 'ch5', 'ch6']);

const CHAPTERS = CHAPTER_META.map((m) => ({
  ...m,
  run: RUNS[m.id],
  auth: NEEDS_AUTH.has(m.id),
}));

/* ───────────────────────────── 主流程 ───────────────────────────── */

async function main() {
  // --only 支持自定义顺序（如 ch2 先建库、ch3-6 再提问、ch1 独立最后）
  const todo = ONLY.length
    ? ONLY.map((id) => CHAPTERS.find((c) => c.id === id)).filter(Boolean)
    : CHAPTERS;
  if (todo.length === 0) throw new Error(`--only 未匹配到章节：${ONLY.join(',')}`);

  mkdirSync(RAW, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'],
  });

  PASSWORD = await resolvePassword(browser);
  const auth = await apiLogin(PASSWORD);
  if (!auth) throw new Error('API 登录失败，无法注入会话');

  console.log(`\n▶ 录制 ${todo.length} 章 · 视口 ${W}×${H}${DRY ? ' · DRY 模式（不录视频）' : ''}\n`);

  for (const ch of todo) {
    console.log(`[${ch.id}] ${ch.title} …`);
    const before = new Set(readdirSync(RAW));
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
      ...(DRY ? {} : { recordVideo: { dir: RAW, size: { width: W, height: H } } }),
    });
    if (ch.auth) await ctx.addInitScript(authInitScript(auth));
    await ctx.addInitScript(
      subtitleScript({ no: ch.no, total: TOTAL, title: ch.title, tag: ch.tag, mode: ch.mode }),
    );
    const page = await ctx.newPage();
    try {
      await ch.run(ctx, page);
    } catch (err) {
      console.log(`   ❌ ${ch.id} 失败：${err instanceof Error ? err.message : err}`);
      await page.screenshot({ path: join(SHOTS, `${ch.id}-FAIL.png`) }).catch(() => {});
    }
    const video = page.video();
    await sleep(900); // 让末尾画面进 screencast，避免 "Page did not produce any video frames"
    await ctx.close();
    if (video) {
      try {
        const src = await video.path();
        const dst = join(RAW, `${ch.id}.webm`);
        if (existsSync(src)) {
          renameSync(src, dst);
          console.log(`   ✔ ${ch.id}.webm`);
        } else {
          console.log(`   ⚠ ${ch.id} 未产出视频文件`);
        }
      } catch (err) {
        console.log(`   ⚠ ${ch.id} 取视频失败：${err instanceof Error ? err.message : err}`);
      }
    }
    const after = readdirSync(RAW).filter((f) => !before.has(f));
    if (after.length > 0 && !DRY) console.log(`   (新增原始片段: ${after.join(', ')})`);
  }

  await browser.close();
  console.log(`\n✅ 录制结束，产物目录：${RAW}`);
}

main().catch((err) => {
  console.error('录制失败：', err);
  process.exit(1);
});
