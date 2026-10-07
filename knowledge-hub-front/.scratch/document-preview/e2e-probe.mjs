/**
 * 真实通道端到端探针（工单 01 验收用，临时脚本）。
 *
 * 走的是浏览器会走的那条链路：登录 → 上传 → 立即取详情 → 轮询到终态。
 * 断言「解析完成前 content 为空 / 解析完成后 content 是 markdown」这个前端状态机的数据前提，
 * 并顺带实测 /storage 取流是否被 RustFS bucket policy 拒绝（工单备注里的已知后端缺口）。
 *
 * 用法：node .scratch/document-preview/e2e-probe.mjs [前端地址，默认 http://localhost:5173]
 */
const BASE = process.argv[2] ?? 'http://localhost:5173'
const POLL_INTERVAL = 2500
const POLL_MAX = 40

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const XSS_MD = `# XSS 探针与渲染覆盖

本文件同时验证两件事：**解析产物是不是 markdown**，以及**原始 HTML 是否被转义**。

## 表格

| 字段 | 值 |
| --- | --- |
| 文档 ID | e2e-probe |
| 解析引擎 | MinerU flash |

## 列表

1. 有序第一项
2. 有序第二项
   - 嵌套无序项

> 引用块：这段应当出现在解析后的正文里。

\`\`\`ts
const docId = 'e2e-probe'
console.log('解析完成', docId)
\`\`\`

## 原始 HTML 探针（应显示为字面文本，不得执行）

<script>alert('PROBE_SCRIPT_1')</script>

<img src=x onerror="alert('PROBE_ONERROR_2')">

<style>body{display:none}</style>

<svg onload="alert('PROBE_SVG_3')"></svg>

[x](javascript:alert('PROBE_JS_4'))

[y](data:text/html;base64,PHNjcmlwdD5hbGVydCgnUFJPQkVfREFUQV81Jyk8L3NjcmlwdD4=)

<!-- <script>alert('PROBE_COMMENT_6')</script> -->
`

const TXT = `纯文本探针 TXT_PLAINTEXT_MARKER

这一份用于验证 txt 在解析完成前按原文展示的分支。
行二：<script>alert('PROBE_TXT_7')</script>
`

// 最小合法 PDF（与 mock 文件服务同构，运行时算 xref 偏移）
function buildPdf() {
  const stream = 'BT /F1 20 Tf 72 760 Td (E2E Probe PDF) Tj 0 -36 Td (Parsed by MinerU.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = objects.map((obj, i) => {
    const offset = body.length
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
    return offset
  })
  const xrefOffset = body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`
  return body + `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
}

async function login() {
  const res = await fetch(`${BASE}/real/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`)
  const data = await res.json()
  return data.accessToken ?? data.access_token
}

async function upload(token, name, content, type) {
  const form = new FormData()
  form.append('file', new Blob([content], { type }), name)
  form.append('authorId', '1000000000000000001')
  form.append('createBy', '1000000000000000001')
  const res = await fetch(`${BASE}/real/document/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`上传 ${name} 失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

async function detail(token, id) {
  const res = await fetch(`${BASE}/real/document/${id}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`详情 HTTP ${res.status}`)
  return res.json()
}

/** 上传 → 立即取详情 → 轮询到终态，返回时间线与终态响应 */
async function runCase(token, label, name, content, type) {
  console.log(`\n──────── ${label}（${name}）────────`)
  const created = await upload(token, name, content, type)
  const id = String(created.id)
  console.log(`  上传响应     : ${JSON.stringify(created).slice(0, 220)}`)

  const first = await detail(token, id)
  console.log(`  立即取详情   : parse_state=${first.parse_state} content=${first.content === null ? 'null' : `${String(first.content).length} 字符`}`)
  // 注意：md / txt 后端走同步路径，取详情时已 success；只有 pdf 一类才真的经历 pending → running。
  // 因此这里只断言「未到终态时不应有正文」，而不能断言「一定有中间态」。
  const midState = first.parse_state === 'pending' || first.parse_state === 'running'
  check(
    `${label} 未到终态时正文未产出（中间态=${midState}）`,
    midState ? !first.content : true,
    midState ? `content=${first.content === null ? 'null' : '非空'}` : `取详情时已 ${first.parse_state}，跳过`,
  )
  check(`${label} source_file_name 已返回`, Boolean(first.source_file_name), String(first.source_file_name))

  const seq = [first.parse_state]
  const started = Date.now()
  let last = first
  for (let i = 0; i < POLL_MAX; i += 1) {
    if (last.parse_state === 'success' || last.parse_state === 'failed') break
    await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    last = await detail(token, id)
    if (last.parse_state !== seq[seq.length - 1]) seq.push(last.parse_state)
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`  状态时间线   : ${seq.join(' → ')}（${elapsed}s）`)
  console.log(`  终态         : parse_state=${last.parse_state} parse_error=${JSON.stringify(last.parse_error)} content=${last.content === null ? 'null' : `${String(last.content).length} 字符`}`)

  return { id, first, last, seq, elapsed }
}

function inspectMarkdown(md) {
  const out = []
  out.push(['含标题标记 #', /^#/m.test(md)])
  out.push(['含表格分隔行 |---|', /^\|[\s-:|]+\|$/m.test(md)])
  out.push(['含有序列表', /^\s*\d+\.\s/m.test(md)])
  out.push(['含引用块 >', /^\s*>/m.test(md)])
  out.push(['含围栏代码块', /```/.test(md)])
  return out
}

const token = await login()
console.log('已登录（admin）')

const md = await runCase(token, 'markdown', 'e2e-probe.md', XSS_MD, 'text/markdown')
const txt = await runCase(token, '纯文本', 'e2e-probe.txt', TXT, 'text/plain')
const pdf = await runCase(token, 'PDF', 'e2e-probe.pdf', buildPdf(), 'application/pdf')

console.log('\n════════ 断言 ════════')

for (const c of [md, txt, pdf]) {
  const label = c.last.source_file_name
  if (c.last.parse_state === 'success') {
    check(`${label} 解析成功后 content 非空`, Boolean(c.last.content))
    const shapes = inspectMarkdown(String(c.last.content))
    console.log(`    正文结构：${shapes.map(([n, ok]) => `${ok ? '✓' : '✗'}${n}`).join('  ')}`)
  } else {
    console.log(`  INFO  ${label} 终态为 ${c.last.parse_state}（MinerU flash 云端解析，失败原因见 parse_error）`)
  }
}

// /storage 取流：前端 pdf 内嵌与 txt/md 原文分支都依赖它，且必须能通过 res.ok + Content-Type 双校验
for (const c of [md, txt, pdf]) {
  const url = c.last.source_file_url
  if (!url) {
    check(`${c.last.source_file_name} source_file_url 存在`, false, '后端未返回')
    continue
  }
  const rel = (() => {
    try {
      const u = new URL(url)
      return `/storage${u.pathname}${u.search}`
    } catch {
      return url
    }
  })()
  const res = await fetch(`${BASE}${rel}`, { method: 'GET' })
  const ctype = res.headers.get('content-type') ?? ''
  const body = await res.arrayBuffer()
  console.log(`\n  ${c.last.source_file_name} → ${rel}`)
  console.log(`    HTTP ${res.status}  Content-Type: ${ctype || '（缺失）'}  字节: ${body.byteLength}`)
  check(`${c.last.source_file_name} /storage 取流成功（前端 r.ok 校验通过）`, res.ok, `HTTP ${res.status}`)
  check(`${c.last.source_file_name} /storage 返回的是文件而非 SPA fallback`, !ctype.includes('text/html'), `Content-Type: ${ctype || '缺失'}`)
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
