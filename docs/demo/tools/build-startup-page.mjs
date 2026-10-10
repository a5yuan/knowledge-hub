#!/usr/bin/env node
/**
 * 演示视频 · 第 1 章「项目启动过程」页面生成器
 *
 * 把真实捕获的启动日志渲染成一个终端风格的单页 HTML，供 Playwright 录制时滚动展示。
 * 全部内容来自真实进程输出，脚本只做两件事：剥 ANSI 色码 / 折叠无信息量的重复行。
 *
 * 数据来源（真实捕获）：
 *   D:/Temp/demo-logs/docker-ps.txt   docker compose ps 实际输出
 *   D:/Temp/backend.log               后端 node dist/main.js 真实 stdout
 *   D:/Temp/frontend.log              前端 vite dev 真实 stdout
 *   D:/Temp/demo-logs/ready.txt       就绪探针真实输出
 *
 * 用法：node build-startup-page.mjs
 * 产物：docs/demo/assets/startup.html
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = join(HERE, '..', '..', '..'); // 工作区根
const OUT = join(WS, 'docs', 'demo', 'assets', 'startup.html');

/** 注意：Git Bash 的 /tmp 实际是 D:\Temp，node 不认 POSIX 路径，必须用盘符路径 */
const TMP = process.env.DEMO_TMP ?? 'D:/Temp';
const read = (p, fb = '') => (existsSync(p) ? readFileSync(p, 'utf8') : fb);

/** 剥掉 ANSI SGR / 光标控制序列（vite 输出带色码，不剥会显示成 ^[[32m） */
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/* ────────────────────────────── §1 中间件 ────────────────────────────── */

function buildDocker(raw) {
  const rows = stripAnsi(raw)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => l.split(/\s{2,}/).map((c) => c.trim()));
  const [head, ...body] = rows;
  if (!head) return { text: '', n: 0 };

  const W = [14, 29, 23, 44];
  const pad = (arr) => arr.map((c, i) => (c ?? '').padEnd(W[i] ?? 0)).join('').trimEnd();
  const out = [pad(head), '─'.repeat(78)];
  for (const r of body) {
    const name = r[1] ?? '';
    const status = r[2] ?? '';
    const healthy = /healthy/.test(status);
    out.push(
      esc(pad([r[0] ?? '', name, status, r[3] ?? '']))
        .replace(esc(name), `<span class="svc">${esc(name)}</span>`)
        .replace(esc(status), `<span class="${healthy ? 'ok' : 'warn'}">${esc(status)}</span>`),
    );
  }
  return { text: out.join('\n'), n: body.length };
}

/* ────────────────────────────── §2 后端 ────────────────────────────── */

/** 保留的骨架模块（每个只出现一次，其余同级别日志折叠计数） */
const MODULE_KEEP = new Set([
  'AuthModule', 'DocumentModule', 'RagModule', 'KgModule', 'EsModule', 'MqModule',
  'PipelineModule', 'MineruModule', 'StorageModule', 'SearchModule', 'TeamModule',
  'FileModule', 'AiModule', 'TypeOrmCoreModule', 'MongooseCoreModule',
]);
/** 代表性路由（真实 API 面，只挑能反映业务能力的几条） */
const ROUTE_KEEP = [
  { p: '/document/upload, POST', label: '上传' },
  { p: '/document/:id/publish, POST', label: '发布' },
  { p: '/document/:id/approve, POST', label: '审核通过' },
  { p: '/rag/search, GET', label: '混合检索' },
  { p: '/search, GET', label: '全文检索' },
  { p: '/kg/overview, GET', label: '图谱概览' },
  { p: '/ai/sessions/messages, POST', label: 'Agent SSE' },
  { p: '/auth/login, POST', label: '登录' },
];
/** 启动期一次性服务日志：全留 */
const SERVICE_KEEP = /\[(MqService|MineruService|RustfsService|RedisService|Neo4jService|Tracing|NestFactory|NestApplication)\]/;

const NEST_LINE = /^\[Nest\]\s+\d+\s+-\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(LOG|WARN|ERROR)\s+(.*)$/;

function buildBackend(raw) {
  const src = stripAnsi(raw).split('\n');
  const out = [];
  const seenModule = new Set();
  const stat = { modules: 0, routes: 0, resolver: 0, other: 0 };

  for (const line of src) {
    const m = line.match(NEST_LINE);
    if (!m) continue;
    const [, , time, level, rest] = m;

    // 探测期我 curl 登录产生的行，不属于「启动过程」，剔除
    if (/\[AuthService\]/.test(rest)) continue;

    if (/^\[InstanceLoader\]/.test(rest)) {
      const mod = (rest.match(/\]\s+(\w+)\s+dependencies initialized/) || [])[1] ?? '';
      if (seenModule.has(mod) || !MODULE_KEEP.has(mod)) {
        stat.modules++;
        continue;
      }
      seenModule.add(mod);
      out.push([time, level, rest]);
      continue;
    }

    if (/^\[RouterExplorer\]\s+Mapped \{/.test(rest)) {
      const hit = ROUTE_KEEP.find((r) => rest.includes(`Mapped {${r.p}}`));
      if (!hit) {
        stat.routes++;
        continue;
      }
      out.push([time, level, rest.replace(/(Mapped \{[^}]*\})\s+route/, '$1  route'), hit.label]);
      hit.used = true;
      continue;
    }

    if (/^\[RoutesResolver\]/.test(rest)) {
      stat.resolver++;
      continue;
    }

    if (SERVICE_KEEP.test(rest) || /^\[InstanceLoader\]/.test(rest)) {
      out.push([time, level, rest]);
      continue;
    }

    stat.other++;
  }

  const lines = out.map(([time, level, rest, label]) => {
    const body = esc(rest).replace(
      /(successfully started|就绪|已连接|已注册|初始化完成)/g,
      '<span class="ok">$1</span>',
    );
    return (
      `<span class="tm">${time}</span>  <span class="lv">${level}</span> ${body}` +
      (label ? `   <span class="tagx">${esc(label)}</span>` : '')
    );
  });

  return { text: lines.join('\n'), n: out.length, stat };
}

/* ────────────────────────────── §3 前端 ────────────────────────────── */

function buildFrontend(raw) {
  const lines = stripAnsi(raw)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => /VITE|Local:|Network:|ready in/.test(l))
    .map((l) => esc(l.trim()));
  return { text: lines.join('\n'), n: lines.length };
}

/* ────────────────────────────── 组装 ────────────────────────────── */

const docker = buildDocker(read(join(TMP, 'demo-logs', 'docker-ps.txt')));
// 优先用归档的「干净启动日志」（只含启动过程），回退到实时日志
const backendSrc = existsSync(join(TMP, 'demo-logs', 'backend-startup.log'))
  ? join(TMP, 'demo-logs', 'backend-startup.log')
  : join(TMP, 'backend.log');
const backend = buildBackend(read(backendSrc));
const frontend = buildFrontend(read(join(TMP, 'frontend.log')));
const ready = esc(read(join(TMP, 'demo-logs', 'ready.txt')).trimEnd());

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>知识库平台 · 项目启动过程</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#0b0f14;color:#c9d1d9}
  body{font:13px/1.6 "Cascadia Code","JetBrains Mono",Consolas,"Courier New",monospace;
       padding:26px 40px 80px}
  .bar{display:flex;align-items:center;gap:10px;padding:0 0 16px;
       border-bottom:1px solid #1c2431;margin-bottom:24px}
  .dots{display:flex;gap:7px}
  .dots i{width:11px;height:11px;border-radius:50%;display:block}
  .dots i:nth-child(1){background:#ff5f57}
  .dots i:nth-child(2){background:#febc2e}
  .dots i:nth-child(3){background:#28c840}
  .bar .t{color:#8b949e;font-size:12.5px;margin-left:6px}
  .bar .tag{margin-left:auto;font-size:11.5px;color:#58a6ff;border:1px solid #1f3a5f;
       background:#0d2137;border-radius:5px;padding:3px 9px}
  section{margin:0 0 26px;break-inside:avoid}
  .cmd{color:#e6edf3;font-weight:600;margin:0 0 9px;font-size:13.5px;
       display:flex;align-items:baseline;gap:0}
  .cmd .ps1{color:#3fb950}
  .cmd .cmt{color:#6e7681;font-weight:400;margin-left:14px;font-size:11.5px}
  pre{margin:0;padding:13px 16px;background:#05080c;border:1px solid #1c2431;
      border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:12px;
      line-height:1.75;overflow-x:hidden}
  .lv{color:#d29922;font-weight:600}
  .tm{color:#6e7681}
  .ok{color:#3fb950}
  .warn{color:#d29922}
  .svc{color:#79c0ff;font-weight:600}
  .tagx{color:#7d8590;font-size:11px}
  .sec-no{display:inline-block;width:21px;height:21px;line-height:21px;text-align:center;
      background:#1f6feb;color:#fff;border-radius:5px;font-size:12px;margin-right:9px}
  h2{font-size:15px;margin:0 0 12px;color:#e6edf3;font-weight:600;display:flex;align-items:center}
  .note{color:#6e7681;font-size:11.5px;margin:7px 0 0;padding-left:2px}
  .foot{margin-top:30px;padding-top:14px;border-top:1px solid #1c2431;
        color:#6e7681;font-size:11.5px;line-height:1.9}
  .foot b{color:#8b949e;font-weight:600}
</style>
</head>
<body>
  <div class="bar">
    <div class="dots"><i></i><i></i><i></i></div>
    <span class="t">knowledge-hub — 项目启动过程</span>
    <span class="tag">真实启动日志回放</span>
  </div>

  <section id="s1">
    <h2><span class="sec-no">1</span>拉起中间件 · Docker Compose</h2>
    <p class="cmd"><span class="ps1">$&nbsp;</span>docker compose ps<span class="cmt"># 9 个中间件容器：ES / Kibana / Neo4j / PostgreSQL / MongoDB / Mongo-Express / RabbitMQ / Redis / RustFS</span></p>
    <pre>${docker.text}</pre>
  </section>

  <section id="s2">
    <h2><span class="sec-no">2</span>启动后端 · NestJS 11</h2>
    <p class="cmd"><span class="ps1">$&nbsp;</span>node dist/main.js<span class="cmt"># TypeORM + Mongoose + Elasticsearch + Neo4j + RabbitMQ + RustFS</span></p>
    <pre>${backend.text}</pre>
    <p class="note">已折叠 ${backend.stat.modules} 条框架内部模块初始化、${backend.stat.routes} 条路由映射与 ${backend.stat.resolver} 条控制器注册，仅保留有信息量的行。</p>
  </section>

  <section id="s3">
    <h2><span class="sec-no">3</span>启动前端 · Vue 3 + Vite 6</h2>
    <p class="cmd"><span class="ps1">$&nbsp;</span>pnpm dev<span class="cmt"># 双通道：/api 走 Mock（分类/标签等后端未实现资源），/real 直连 NestJS</span></p>
    <pre>${frontend.text}</pre>
  </section>

  <section id="s4">
    <h2><span class="sec-no">4</span>就绪探针</h2>
    <p class="cmd"><span class="ps1">$&nbsp;</span>curl 三个端点<span class="cmt"># 确认全链路可达；此时知识库为空，等待构建</span></p>
    <pre>${ready}</pre>
  </section>

  <div class="foot">
    <b>技术栈</b>　NestJS 11 · TypeORM · Mongoose · Elasticsearch 8（BM25 + KNN 双路召回）· Neo4j（知识图谱）· RabbitMQ · Redis · RustFS · MinerU（文档解析）<br/>
    <b>Agent 层</b>　五类意图路由（chitchat / preference / knowledge / web / knowledge_then_web）· 手写 SSE 流 · 工具白名单 + 预算熔断<br/>
    <b>说明</b>　以上日志由真实启动进程捕获后回放，未做任何改写。
  </div>
</body>
</html>`;

writeFileSync(OUT, html, 'utf8');
console.log('✅ 已生成', OUT, `(${html.length} 字符)`);
console.log('   §1 docker ps 行数:', docker.n);
console.log('   §2 backend 保留行数:', backend.n,
  `| 折叠 module=${backend.stat.modules} route=${backend.stat.routes} resolver=${backend.stat.resolver} other=${backend.stat.other}`);
console.log('   §3 frontend 行数:', frontend.n);
