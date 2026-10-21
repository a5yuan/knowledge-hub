/**
 * 评测报告落盘（工单 24）。
 *
 * 约定：
 * - 每次运行产出独立目录 `results/suite-<YYYYMMDD-HHmm>/`，不覆盖历史
 * - `index.md` 只放「一行一项 + 一句结论」，明细进各自 JSON
 * - 断言失败时顶部必须先出现失败清单，且结尾**不得**写「全部通过」
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVAL_ROOT = join(HERE, '..');
export const RESULTS_ROOT = join(EVAL_ROOT, 'results');

/** 生成形如 suite-20261020-1730 的目录并创建，返回绝对路径 */
export function createSuiteDir(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const dir = join(RESULTS_ROOT, `suite-${ts}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** markdown 表格（单元格内的 | 会被转义，避免破坏表结构） */
export function mdTable(headers, rows) {
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${headers.map(esc).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(esc).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** 写单项 JSON（明细） */
export function writeItemJson(dir, id, payload) {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

/** 写纯文本日志（降级注入的日志片段等） */
export function writeItemLog(dir, id, text) {
  writeFileSync(join(dir, `${id}.log`), text, 'utf8');
}

/**
 * 写 index.md。
 *
 * @param {string} dir
 * @param {{
 *   env: Record<string, string>,
 *   startedAt: Date,
 *   endedAt: Date,
 *   items: Array<{ id: string, name: string, status: 'pass'|'fail'|'skip'|'todo', metric: string, conclusion: string, target?: string, detail?: string }>,
 *   failures?: Array<{ id: string, name: string, reason: string }>,
 * }} opts
 */
export function writeIndex(dir, opts) {
  const { env, startedAt, endedAt, items, failures = [] } = opts;
  const p = (n) => String(n).padStart(2, '0');
  const fmt = (d) =>
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const dur = Math.round((endedAt - startedAt) / 1000);

  const lines = [];
  lines.push('# 评测套件报告');
  lines.push('');
  lines.push(`- 开始：${fmt(startedAt)}`);
  lines.push(`- 结束：${fmt(endedAt)}（耗时 ${dur}s）`);
  for (const [k, v] of Object.entries(env)) lines.push(`- ${k}：${v}`);
  lines.push('');

  // 失败清单必须在顶部
  const failed = items.filter((i) => i.status === 'fail');
  if (failed.length || failures.length) {
    lines.push('## ❌ 失败清单');
    lines.push('');
    const rows = [];
    for (const f of failures) rows.push([f.id, f.name, f.reason]);
    for (const i of failed) rows.push([i.id, i.name, i.detail ?? i.conclusion]);
    lines.push(mdTable(['#', '项目', '失败原因'], rows));
    lines.push('');
  }

  lines.push('## 指标汇总');
  lines.push('');
  lines.push(
    mdTable(
      ['#', '指标', '状态', '数值', '目标', '结论'],
      items.map((i) => [
        i.id,
        i.name,
        i.status === 'pass' ? '✅ 通过' : i.status === 'fail' ? '❌ 失败' : i.status === 'skip' ? '⏭ 跳过' : '⬜ 未跑',
        i.metric,
        i.target ?? '—',
        i.conclusion,
      ]),
    ),
  );
  lines.push('');

  const ran = items.filter((i) => i.status !== 'todo');
  const passed = ran.filter((i) => i.status === 'pass');
  lines.push('## 结论');
  lines.push('');
  if (failed.length) {
    lines.push(`**${failed.length} 项失败**，共跑 ${ran.length} 项，通过 ${passed.length} 项。详见上方失败清单与各项 JSON。`);
  } else if (ran.length === items.length) {
    lines.push(`全部 ${ran.length} 项通过。`);
  } else {
    lines.push(
      `已跑 ${ran.length} 项，通过 ${passed.length} 项；另有 ${items.length - ran.length} 项未跑（见状态列「⬜ 未跑」）。**不构成全量结论。**`,
    );
  }
  lines.push('');

  writeFileSync(join(dir, 'index.md'), lines.join('\n'), 'utf8');
  return join(dir, 'index.md');
}
