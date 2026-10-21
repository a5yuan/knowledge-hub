#!/usr/bin/env node
/**
 * s10 · 降级有效性（工单 24 指标 #10）
 *
 * 补齐的空白：`rerank.service.ts` / `mem0.service.ts` / `redis.service.ts` 里写着「失败降级」，
 * 但从来没有一次**实际注入**验证过。本脚本把「代码写了降级」升级为「已验证降级」。
 *
 * ## 为什么必须重启进程
 * `RERANK_MODEL` / `RERANK_API_URL` / `MEM0_API_KEY` / `REDIS_HOST` 都是启动时经
 * `ConfigService` 读进闭包/字段的，运行期改环境变量无效。所以每个注入点 spawn 一个
 * **独立进程**（独立 PORT，避免和常驻的 :3000 抢），跑完 kill。
 *
 * ## 判定口径
 * 每个注入点都要同时满足：
 *   1. 进程能起来（`/auth/login` 返回 2xx）—— 起不来就不是「降级」，是「不可用」
 *   2. 对话返回 HTTP 200 且答案非空 —— 降级不能影响主链路
 *   3. 日志里出现**该类降级特有的关键字** —— 证明请求真的走到了降级分支，
 *      而不是恰好没触发那条路径
 *
 * 第 3 条最容易做假：只看「200 + 有答案」会得出「降级完美」的结论，
 * 哪怕请求根本没经过 rerank。所以日志片段必须落盘留证。
 *
 * 用法：
 *   EVAL_PASSWORD=xxx node test/eval/suite/s10-degrade.mjs
 *   DEGRADE_CASE=rerank-model ...        # 只跑某一组
 */
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuiteDir, writeItemJson, writeItemLog, EVAL_ROOT } from '../lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** EVAL_ROOT = test/eval → 再上两级才是后端根（eval → test → backend） */
const BACKEND_ROOT = join(EVAL_ROOT, '..', '..');
const ENTRY = join(BACKEND_ROOT, '.run-build', 'main.js');
const BASE_PORT = 3011;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 12 次请求摊到 4 组：知识库 / 无结果 / 闲聊 —— 覆盖「要检索」和「不检索」两条路径 */
const PROBES = [
  '加班餐补一个月最多能领多少？',
  '公司对员工养宠物有什么规定？',
  '你好，随便聊两句',
];

/**
 * 4 个注入点（工单 §s10 注入矩阵）。
 * `expectLog` 是该类降级**特有**的关键字，不能用通用的 "error" 代替。
 */
const CASES = [
  {
    id: 'rerank-model',
    label: 'Rerank 模型名不存在',
    env: { RERANK_MODEL: 'not-exist-model-v9' },
    // 注意：HTTP 非 200 走的是「重排接口响应异常」分支，**不带**「降级为 RRF 排序」字样
    // （只有响应格式异常/抛错才带）。所以这里要求同行出现注入的模型名，
    // 既证明配置注入生效，又证明失败被观测到。
    expectLog: /重排接口响应异常.*not-exist-model-v9/,
  },
  {
    id: 'rerank-url',
    label: 'Rerank 端点不可达',
    env: { RERANK_API_URL: 'http://127.0.0.1:9/rerank' },
    // 端口 9 立即 ECONNREFUSED → catch 分支，这句才带「降级为 RRF 排序」
    expectLog: /重排接口调用失败.*降级为 RRF 排序/,
    maxElapsedMs: 40000, // 黑洞端口应快速失败，不能卡到超时
  },
  {
    id: 'mem0-key',
    label: 'Mem0 凭据失效',
    env: { MEM0_API_KEY: 'invalid-key-for-eval' },
    // 必须是「降级」这条，不是任意含 Mem0 的行（否则启动日志也能蒙对）
    expectLog: /Mem0 (search|add) 降级/,
  },
  {
    id: 'redis',
    label: 'Redis 不可达',
    env: { REDIS_HOST: '127.0.0.1', REDIS_PORT: '6390' },
    // Redis 在对话热路径上（memory-cache.loadWindow 读滑动窗口），
    // 预期契约是「静默降级 PG 直读」（memory-cache.service.ts 头注释）。
    // 用「连接错误」而不是 /Redis/，否则 "Redis 已连接" 也能命中。
    expectLog: /Redis 连接错误/,
    note: '实测答案耗时明显高于其他组（见 probes.elapsed_ms），疑似 ioredis 重连退避 + 离线队列把命令挂起到重连，未修',
  },
];

/** 起一个带注入 env 的后端进程，返回 { child, logs(), port } */
function startServer(port, extraEnv) {
  const chunks = [];
  const child = spawn(process.execPath, [ENTRY], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, ...extraEnv, PORT: String(port), LANGFUSE_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => chunks.push(d.toString()));
  child.stderr.on('data', (d) => chunks.push(d.toString()));
  return {
    child,
    port,
    logs: () => chunks.join(''),
  };
}

/** 轮询登录接口判断是否就绪；返回 true/false */
async function waitReady(port, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: process.env.EVAL_PASSWORD }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.accessToken) return { ok: true, token: j.accessToken, waited: Date.now() - t0 };
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(1500);
  }
  return { ok: false, waited: Date.now() - t0 };
}

/** 打一次 SSE，返回 { status, answer, elapsed } */
async function probeChat(port, token, content) {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ai/sessions/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      return { status: res.status, answer: '', elapsed: Date.now() - t0 };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let answer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'text-delta') answer += evt.data?.delta ?? '';
        } catch {
          /* 半包 */
        }
      }
    }
    return { status: 200, answer, elapsed: Date.now() - t0 };
  } catch (err) {
    return {
      status: 0,
      answer: '',
      elapsed: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Windows 上 kill 要连子进程一起，否则端口不释放 */
function killServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    const pid = child.pid;
    const done = () => resolve();
    child.once('exit', done);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    // 兜底：2 秒后强杀整棵树
    setTimeout(() => {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
      resolve();
    }, 2000);
  });
}

async function main() {
  const suiteDir = process.env.SUITE_DIR ?? createSuiteDir();
  if (process.env.SUITE_DIR) mkdirSync(suiteDir, { recursive: true });
  const onlyCase = process.env.DEGRADE_CASE;

  console.log('s10 · 降级有效性（进程级注入）');
  console.log('='.repeat(70));

  if (!existsSync(ENTRY)) {
    console.log(`  ❌ 缺少编译产物 ${ENTRY}，先跑 tsc --outDir ./.run-build`);
    writeItemJson(suiteDir, 's10-degrade', { status: 'skip', reason: '缺少 .run-build/main.js' });
    process.exitCode = 2;
    return;
  }
  if (!process.env.EVAL_PASSWORD) {
    console.log('  ❌ 缺少 EVAL_PASSWORD');
    process.exitCode = 2;
    return;
  }

  const cases = onlyCase ? CASES.filter((c) => c.id === onlyCase) : CASES;
  const results = [];
  const logSections = [];

  for (const [i, c] of cases.entries()) {
    const port = BASE_PORT + i;
    console.log('-'.repeat(70));
    console.log(`▶ ${c.id} —— ${c.label}（PORT=${port}）`);
    console.log(`  注入：${JSON.stringify(c.env)}`);

    const server = startServer(port, c.env);
    let record = { id: c.id, label: c.label, env: c.env, port, note: c.note ?? null };

    try {
      const ready = await waitReady(port);
      record.ready = ready.ok;
      record.ready_waited_ms = ready.waited;

      if (!ready.ok) {
        writeFileSync(join(suiteDir, `s10-${c.id}-full.log`), server.logs(), 'utf8');
        console.log(`  ❌ 进程 ${ready.waited}ms 内未就绪 —— 这不是「降级」，是「起不来」`);
        record.verdict = 'server_not_ready';
        record.passed = false;
      } else {
        console.log(`  ✅ 就绪（${ready.waited}ms）`);
        const probes = [];
        for (const q of PROBES) {
          const r = await probeChat(port, ready.token, q);
          probes.push({
            question: q,
            status: r.status,
            answer_len: r.answer.trim().length,
            empty: r.answer.trim().length === 0,
            elapsed_ms: r.elapsed,
            error: r.error ?? null,
            slow: c.maxElapsedMs ? r.elapsed > c.maxElapsedMs : false,
          });
          console.log(
            `    HTTP ${r.status}　${(r.elapsed / 1000).toFixed(1)}s　答案 ${r.answer.trim().length} 字` +
              (r.answer.trim().length === 0 ? '　❌ 空' : ''),
          );
        }
        record.probes = probes;

        const allOk = probes.every((p) => p.status === 200 && !p.empty);
        const allFast = probes.every((p) => !p.slow);
        record.all_ok = allOk;
        record.all_fast = allFast;

        // 关键：日志里是否真的出现了该类降级的特有标记
        const logs = server.logs();
        // 全量落盘，便于事后核对「到底有没有走到那条路径」（比对仅留命中行更容易翻案）
        writeFileSync(join(suiteDir, `s10-${c.id}-full.log`), logs, 'utf8');
        const hit = c.expectLog.test(logs);
        record.log_matched = hit;
        record.expect_log = String(c.expectLog);
        const matchedLines = logs
          .split(/\r?\n/)
          .filter((l) => c.expectLog.test(l))
          .slice(0, 5);
        record.log_samples = matchedLines;

        console.log(`  ${hit ? '✅' : '❌'} 日志出现降级标记 ${c.expectLog}`);
        for (const l of matchedLines) console.log(`      ${l.trim().slice(0, 150)}`);
        console.log(`  ${allOk ? '✅' : '❌'} 主链路正常（HTTP 200 + 答案非空）`);
        if (c.maxElapsedMs) {
          console.log(`  ${allFast ? '✅' : '❌'} 未超过 ${c.maxElapsedMs}ms（实际最慢 ${Math.max(...probes.map((p) => p.elapsed_ms))}ms）`);
        }

        record.verdict = allOk && hit && allFast ? 'degraded_ok' : 'fail';
        record.passed = record.verdict === 'degraded_ok';

        logSections.push(
          `===== ${c.id}（${c.label}）=====\n注入：${JSON.stringify(c.env)}\n` +
            `就绪：${record.ready}（${record.ready_waited_ms}ms）\n` +
            `命中降级标记：${hit}\n${matchedLines.join('\n')}\n`,
        );
      }
    } finally {
      await killServer(server.child);
      await sleep(800); // 等端口释放
    }

    results.push(record);
    console.log('');
  }

  const passed = results.filter((r) => r.passed).length;
  const status = passed === results.length ? 'pass' : 'fail';
  const failedIds = results.filter((r) => !r.passed).map((r) => r.id);

  const payload = {
    id: 's10',
    name: '降级有效性（4 注入点）',
    status,
    metric: `${passed}/${results.length} 注入点验证通过`,
    target: '每点都满足：进程就绪 + 200 非空 + 日志命中降级标记',
    conclusion:
      status === 'pass'
        ? `${results.length} 个注入点在故障下均保持主链路可用，且日志证实降级分支被实际走到`
        : `失败注入点：${failedIds.join(', ')} —— 详见各项 verdict`,
    cases: results,
    observations: results
      .filter((r) => r.note)
      .map((r) => ({ id: r.id, note: r.note })),
    caveats: [
      '每个注入点起独立进程（独立 PORT），避免污染常驻的 :3000',
      '判定要求「日志命中该类降级特有标记」，只看「200+有答案」会把没走到降级分支的情况误判为通过',
      'rerank 的两条分支文案不同：HTTP 非 200 → 「重排接口响应异常」（无「降级」字样）；抛错/超时 → 「重排接口调用失败…降级为 RRF 排序」。匹配串必须先读代码再定',
      'Redis 注入若导致进程起不来，判定为 server_not_ready 而非「降级失败」——起不来说明没有降级设计',
    ],
  };
  writeItemJson(suiteDir, 's10-degrade', payload);
  if (logSections.length) writeItemLog(suiteDir, 's10-degrade', logSections.join('\n'));

  console.log('='.repeat(70));
  console.log(`结论：${payload.conclusion}`);
  console.log(`状态：${status === 'pass' ? '✅ 通过' : '❌ 失败'}`);
  console.log(`明细：${join(suiteDir, 's10-degrade.json')}`);
  console.log(`日志：${join(suiteDir, 's10-degrade.log')}`);
  if (status !== 'pass') process.exitCode = 1;
}

main().catch((err) => {
  console.error('s10 执行失败:', err);
  process.exitCode = 1;
});
