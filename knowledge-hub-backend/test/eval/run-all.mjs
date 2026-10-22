#!/usr/bin/env node
/**
 * 评测套件一键入口（工单 24）。
 *
 * 用法：
 *   EVAL_PASSWORD=xxx node test/eval/run-all.mjs
 *   EVAL_PASSWORD=xxx node test/eval/run-all.mjs --only s11,s12
 *   EVAL_PASSWORD=xxx node test/eval/run-all.mjs --with-degrade   # 追加降级矩阵（会起独立进程）
 *
 * 说明：
 * - 每项都先过 preflight（环境体检），体检不过直接中止，不产出半真半假的报告
 * - 产出 `results/suite-<ts>/`：`index.md` 汇总 + 每项 JSON + 失败明细
 * - 12 项指标固定列出，未实现的标「⬜ 未跑」，**不隐藏缺口**
 *
 * 当前进度（P0）：s11 预算拦截 / s12 重发布幂等已实现；
 * s10 降级、s07 TTFT 等按工单分阶段排在 P1/P2。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, preflight } from './lib/base.mjs';
import { createSuiteDir, writeIndex } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 12 项指标清单（工单 §指标定义表，顺序固定） */
const INDICATORS = [
  { id: 's01', name: '检索质量 Recall@K / MRR / Hit@K', phase: 'P2', script: 's01-retrieval.mjs' },
  { id: 's02', name: '生成质量 Faithfulness / Relevancy / Completeness', phase: 'P2', script: 's02-generation.mjs' },
  { id: 's03', name: '意图路由准确率', phase: 'P1', script: 's03-intent.mjs' },
  { id: 's04', name: '工具选择准确率', phase: 'P1', script: 's04-tools.mjs' },
  { id: 's05', name: '引用正确率（编号有效性 + 支撑性）', phase: 'P2', script: 's05-citation.mjs' },
  { id: 's06', name: '检索延迟分位', phase: 'P2', script: 's06-latency.mjs' },
  { id: 's07', name: '首 token 延迟 TTFT（双口径）', phase: 'P1', script: 's07-ttft.mjs' },
  { id: 's08', name: 'Agent 全链路延迟分位', phase: 'P1', script: 's08-agent-latency.mjs' },
  { id: 's09', name: 'Token 成本 / 单次问答成本', phase: 'P1', script: 's09-cost.mjs' },
  { id: 's10', name: '降级有效性（4 注入点）', phase: 'P0', script: 's10-degrade.mjs', needsSpawn: true },
  { id: 's11', name: '预算拦截有效性', phase: 'P0', script: 's11-budget.mjs' },
  { id: 's12', name: '重发布幂等性', phase: 'P0', script: 's12-idempotent.mjs' },
];

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i < 0) return null;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1] ?? null;
}
const onlyArg = argValue('--only');
const only = onlyArg
  ? onlyArg
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;
const withDegrade = argv.includes('--with-degrade');
/**
 * `--reuse`：目录里已有 `<id>-*.json` 就跳过执行，只重新汇总。
 * 为什么需要：s07 一轮 100 样本要 18 分钟，重新汇总 index.md 时不该再烧一遍。
 */
const reuse = argv.includes('--reuse');
/** `--suite-dir=<path>`：复用已有 suite 目录（配合 --reuse 做"只汇总"） */
const suiteDirArg = argValue('--suite-dir');

function selected(ind) {
  if (!ind.script) return false;
  if (ind.needsSpawn && !withDegrade) return false;
  if (only && !only.includes(ind.id)) return false;
  return true;
}

async function main() {
  const suiteDir = suiteDirArg ?? createSuiteDir();
  mkdirSync(suiteDir, { recursive: true });
  const startedAt = new Date();

  console.log('评测套件 run-all');
  console.log('='.repeat(70));
  console.log(`输出目录：${suiteDir}\n`);

  /**
   * 全局体检：任一不通过就不跑分项，避免产出一份「数字看着正常但环境已降级」的报告。
   *
   * 但 `--reuse` 模式例外（2026-10-22 踩过）：它一个分项都不执行，只是复用已有 JSON 重出汇总。
   * 此时若还按体检拦下来，会把**已经跑好的结果**全部标成「未跑」并覆盖 index.md ——
   * 体检失败反而毁掉报告，方向完全反了。所以 reuse 下降级为警告。
   */
  const token = await login();
  const issues = await preflight(token);
  if (issues.length && argv.includes('--reuse')) {
    console.log('⚠️ 环境体检未通过，但 --reuse 只复用已有结果、不请求后端，继续生成汇总：');
    for (const i of issues) console.log('   - ' + i);
  } else if (issues.length) {
    console.log('❌ 环境体检未通过，中止：');
    for (const i of issues) console.log('   - ' + i);
    const endedAt = new Date();
    writeIndex(suiteDir, {
      env: { 环境体检: '未通过' },
      startedAt,
      endedAt,
      items: INDICATORS.map((i) => ({
        id: i.id,
        name: i.name,
        status: 'todo',
        metric: '—',
        conclusion: '环境体检未通过，未执行',
      })),
      failures: issues.map((reason) => ({ id: 'preflight', name: '环境体检', reason })),
    });
    console.log(`\n已写出空报告：${join(suiteDir, 'index.md')}`);
    process.exitCode = 2;
    return;
  }
  console.log('✅ 环境体检通过\n');

  const ranResults = new Map();

  for (const ind of INDICATORS) {
    if (!selected(ind)) continue;
    console.log('-'.repeat(70));
    console.log(`▶ ${ind.id} ${ind.name}`);
    console.log('-'.repeat(70));
    const scriptPath = join(HERE, 'suite', ind.script);
    if (!existsSync(scriptPath)) {
      console.log(`  ⚠️ 脚本不存在：${ind.script}`);
      continue;
    }
    // --reuse：该目录里已有本项结果就跳过执行，只参与汇总
    // （s07 一轮 100 样本要 18 分钟，重新生成 index.md 时不该再烧一遍）
    const already = readdirSync(suiteDir).filter(
      (f) => f.startsWith(`${ind.id}-`) && f.endsWith('.json'),
    );
    if (reuse && already.length) {
      console.log(`  ⏭ 复用已有结果：${already[0]}`);
      try {
        ranResults.set(ind.id, JSON.parse(readFileSync(join(suiteDir, already[0]), 'utf8')));
      } catch {
        /* 解析失败则当作未跑 */
      }
      continue;
    }
    try {
      execFileSync(process.execPath, [scriptPath], {
        stdio: 'inherit',
        env: { ...process.env, SUITE_DIR: suiteDir },
      });
    } catch (err) {
      // 单项失败不中断整套（失败信息由该脚本自己的 JSON 承载）
      console.log(`  ⚠️ ${ind.id} 退出码非 0（详见 ${ind.id}.json）`);
    }
    // 读回该脚本产出的 JSON：按 `<id>-*.json` 前缀匹配，避免为每个脚本维护文件名清单
    try {
      const produced = readdirSync(suiteDir).filter(
        (f) => f.startsWith(`${ind.id}-`) && f.endsWith('.json'),
      );
      if (produced.length) {
        ranResults.set(ind.id, JSON.parse(readFileSync(join(suiteDir, produced[0]), 'utf8')));
      }
    } catch {
      /* 读回失败不影响后续项 */
    }
  }

  const endedAt = new Date();

  const items = INDICATORS.map((ind) => {
    const r = ranResults.get(ind.id);
    if (r) {
      return {
        id: ind.id,
        name: ind.name,
        status: r.status ?? 'todo',
        metric: r.metric ?? '—',
        target: r.target,
        conclusion: r.conclusion ?? '',
        detail: r.reason,
      };
    }
    return {
      id: ind.id,
      name: ind.name,
      status: 'todo',
      metric: '—',
      conclusion: `未跑（排期 ${ind.phase}）`,
    };
  });

  const env = {
    后端: process.env.EVAL_BASE_URL ?? 'http://localhost:3000',
    轻量模型: process.env.MEMORY_LLM_MODEL ?? '(代码默认 qwen-turbo)',
    主模型: process.env.LLM_MODEL ?? '(代码默认)',
    样本量: 's01/s02 复用 14 条标注集评测；s06 复用历史压测（见采集日期）；s11×1 条压力查询；s12×3 轮发布',
    说明: '本报告仅覆盖已实现的分项，未跑项不代表通过',
  };

  const indexPath = writeIndex(suiteDir, { env, startedAt, endedAt, items });

  console.log('\n' + '='.repeat(70));
  const passed = items.filter((i) => i.status === 'pass').length;
  const failed = items.filter((i) => i.status === 'fail').length;
  const ran = items.filter((i) => i.status !== 'todo').length;
  console.log(`已跑 ${ran}/12 项：通过 ${passed}，失败 ${failed}，未跑 ${12 - ran}`);
  console.log(`报告：${indexPath}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('run-all 失败:', err);
  process.exitCode = 1;
});
