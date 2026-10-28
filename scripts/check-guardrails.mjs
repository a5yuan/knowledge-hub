#!/usr/bin/env node
/**
 * 护栏检查 —— 把 AGENTS.md 的红线与文档约定变成可执行断言。
 *
 * 为什么需要它：写在文档里的规则只是「声明」，AI 读没读、守没守，肉眼看不出。
 * 这个脚本把能静态检测的部分变成 PASS/FAIL，让「文档是否有效」从主观变成可复现。
 *
 * 用法：node scripts/check-guardrails.mjs [--json]
 * 退出码：0 全通过 / 1 有失败
 *
 * ⚠️ 设计教训（2026-10-27 实测踩过）：所有代码类检查必须**先剥离注释**。
 *    首版未剥离时，`stats.controller.ts` 注释里的「没有 @Get(':id')」被当成真实路由，
 *    `department.controller.ts` 注释里的示例被当成声明顺序错误 —— 一次跑出 4 条假阳性。
 *    满是误报的检查等于没做，AI 会直接忽略它。
 *
 * 不在本脚本范围内的红线（无法静态检测，只能靠实测/评审）：
 *   - 雪花 ID 转字符串（需要类型流分析）
 *   - 时间边界两套时钟（需要看懂语义）
 *   - 不要跑 pnpm run lint（行为约束，不是代码属性）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, basename } from 'node:path'

const ROOT = process.cwd()
const results = []
const add = (name, ok, details = []) => results.push({ name, ok, details })

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-ssr', 'build', 'volumes', '.git', '.run-build', '.vite-demo'])
const read = (p) => readFileSync(p, 'utf8')
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(join(dir, ent.name), filter, out)
    } else if (filter(ent.name)) out.push(join(dir, ent.name))
  }
  return out
}

/** 用等量换行替换被删内容，保证行号不偏移 */
const blankOut = (m) => m.replace(/[^\n]/g, ' ')

/** 剥离 TS/JS 注释（保留行号） */
const stripTs = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, blankOut)
    .replace(/(^|[^:\w])\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))

/** 剥离 HTML 注释（.vue 用） */
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, blankOut)

const stripCode = (s, isVue = false) => (isVue ? stripHtml(stripTs(s)) : stripTs(s))

// ── 1. 入口文件行数（AGENTS.md §5 自定上限 80）─────────────────
{
  const p = join(ROOT, 'AGENTS.md')
  if (!existsSync(p)) add('入口文件存在', false, ['AGENTS.md 不存在'])
  else {
    const n = read(p).trimEnd().split(/\r?\n/).length
    add('AGENTS.md 行数 ≤ 80', n <= 80, n > 80 ? [`实际 ${n} 行，超限 ${n - 80} 行`] : [`${n}/80`])
  }
}

// ── 2. 路由表断链（AGENTS.md 引用的路径必须存在）────────────────
{
  const p = join(ROOT, 'AGENTS.md')
  if (existsSync(p)) {
    // 先剥离 fenced code block，否则代码块里的路径会被误当成路由引用
    const text = read(p).replace(/```[\s\S]*?```/g, blankOut)
    const cands = [...text.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1].trim())
      .filter((s) => (s.includes('/') || s.endsWith('.md')) && !/[*<>$|(){}\s]/.test(s))
    // 相对语境解析：`src/` 这类写法是相对子项目的，不是相对仓库根。只放行真正能落到文件的路径，
    // 裸文件名（code-standards.md / spec.md）在任何前缀下都不存在，仍会被判为断链 —— 这是要的信号。
    const resolves = (s) =>
      [s, `knowledge-hub-backend/${s}`, `knowledge-hub-front/${s}`].some((p) => existsSync(join(ROOT, p)))
    const broken = [...new Set(cands)].filter((s) => !resolves(s))
    add('路由表无断链', broken.length === 0, broken.map((s) => `引用了不存在的路径：${s}`))
  }
}

// ── 3. docs/engineering 下文档必须带 status frontmatter ─────────
{
  const files = walk(join(ROOT, 'docs/engineering'), (n) => n.endsWith('.md'))
  const bad = files.filter((f) => !/^---\r?\nstatus:\s*(current|evolving|historical)/.test(read(f)))
  add('二级文档带 status frontmatter', bad.length === 0, bad.map((f) => `缺 frontmatter：${rel(f)}`))
}

// ── 4. 红线2：后端不得引入 Repository 抽象层 / 拦截器 / 响应包装 ──
{
  const files = walk(join(ROOT, 'knowledge-hub-backend/src'), (n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'))
  const byName = files.filter((f) => /\.(repository|interceptor|exception-filter)\.ts$/.test(basename(f)))
  const byClass = files.filter((f) =>
    /class\s+\w*(ResponseWrapper|TransformInterceptor|HttpExceptionFilter)/.test(stripCode(read(f))),
  )
  add('红线2 无 Repository/拦截器/响应包装', byName.length + byClass.length === 0, [...byName, ...byClass].map(rel))
}

// ── 5. 红线3：同段数静态路由必须在同段数动态路由之前 ─────────────
{
  const ctls = walk(join(ROOT, 'knowledge-hub-backend/src'), (n) => n.endsWith('.controller.ts'))
  const bad = []
  for (const f of ctls) {
    const routes = []
    stripCode(read(f))
      .split(/\r?\n/)
      .forEach((line, i) => {
        const m = line.match(/@(Get|Post|Put|Patch|Delete)\(\s*['"]([^'"]+)['"]/)
        if (!m) return
        const segs = m[2].split('/').filter(Boolean)
        routes.push({ i, method: m[1], path: m[2], segs: segs.length, dynamic: m[2].includes(':') })
      })
    for (const dyn of routes.filter((r) => r.dynamic)) {
      for (const st of routes.filter((r) => !r.dynamic && r.method === dyn.method && r.segs === dyn.segs)) {
        if (st.i > dyn.i) {
          bad.push(`${rel(f)}:${st.i + 1} 「${st.method} ${st.path}」在「${dyn.method} ${dyn.path}」(第${dyn.i + 1}行) 之后，会被吞`)
        }
      }
    }
  }
  add('红线3 静态路由在 :id 之前', bad.length === 0, bad)
}

// ── 6. 红线4：后端字段名不得越过 src/api（剥离注释后判定）────────
{
  // 扫整个前端 src 再排除 api/ —— 而不是只列 views+components。
  // 原因：原实现只扫两个目录，`api/graph.ts` 里的 doc_id 违规了也报不出来；
  // 而红线管的是「不得越过 src/api」，api/ 内部允许（见 code-standards.md）。
  const FRONT_SRC = join(ROOT, 'knowledge-hub-front/src')
  const KEYS = /\b(parse_state|is_public|author_id|create_by|update_time|doc_id|user_id|dept_id|team_id)\b/g
  const bad = []
  const files = walk(FRONT_SRC, (n) => /\.(vue|ts)$/.test(n)).filter(
    (f) => !rel(f).includes('/src/api/'),
  )
  for (const f of files) {
    stripCode(read(f), f.endsWith('.vue'))
      .split(/\r?\n/)
      .forEach((line, i) => {
        const hit = line.match(KEYS)
        if (hit) bad.push(`${rel(f)}:${i + 1} 出现 ${[...new Set(hit)].join(',')}`)
      })
  }
  add('红线4 snake_case 未越过 src/api', bad.length === 0, bad)
}

// ── 7. 红线5：前端不得直接写 /api 或 /real 字面量 URL ────────────
{
  const roots = [join(ROOT, 'knowledge-hub-front/src/views'), join(ROOT, 'knowledge-hub-front/src/components')]
  const bad = []
  for (const root of roots) {
    for (const f of walk(root, (n) => /\.(vue|ts)$/.test(n))) {
      stripCode(read(f), f.endsWith('.vue'))
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/['"`]\/(api|real)\//.test(line)) bad.push(`${rel(f)}:${i + 1} ${line.trim().slice(0, 80)}`)
        })
    }
  }
  add('红线5 前端无字面量 URL', bad.length === 0, bad)
}

// ── 输出 ───────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
} else {
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
    for (const d of r.details.slice(0, 12)) console.log(`        ${d}`)
    if (r.details.length > 12) console.log(`        …另有 ${r.details.length - 12} 条`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
}
process.exit(failed.length === 0 ? 0 : 1)
