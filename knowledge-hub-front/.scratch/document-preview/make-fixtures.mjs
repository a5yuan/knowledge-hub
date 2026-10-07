/**
 * 浏览器验收夹具（工单 01，临时脚本）。
 *
 * 造两个「真实链路与 Mock 都难以自然复现」的文档，供人工在浏览器里观察：
 *   1. 永久停在 running 的文档 → 验前端有界轮询超时 +「重新检查」
 *      （后端 processParse 是 fire-and-forget，无超时无重试，这是真实存在的缺口）
 *   2. 解析失败的文档 → 验失败横幅与 parse_error 原文
 *
 * 用法：node .scratch/document-preview/make-fixtures.mjs
 * 清理：脚本末尾会打印文档 id，可直接在「我的文档」里删除。
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

const BASE = 'http://localhost:5173'
const MONGO = process.env.MONGO_CONTAINER ?? 'knowledge_hub_mongodb'
const BACKEND_ENV = new URL('../../../knowledge-hub-backend/.env', import.meta.url)

/** 从后端 .env 取 MONGO_URI（带凭据，不硬编码进脚本）。host 已是 localhost:27017，容器内直接可用 */
function mongoUri() {
  const line = readFileSync(BACKEND_ENV, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('MONGO_URI='))
  if (!line) throw new Error(`未在 ${BACKEND_ENV.pathname} 找到 MONGO_URI`)
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
}

/** 在 Mongo 容器里跑一段 mongosh 脚本（夹具要直接改库，这是唯一不新增后端接口的办法） */
function mongo(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['exec', MONGO, 'mongosh', mongoUri(), '--quiet', '--eval', script],
      { encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}\n${stderr}`))
        else resolve(stdout)
      },
    )
  })
}

async function login() {
  const res = await fetch(`${BASE}/real/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })
  return (await res.json()).accessToken
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
  if (!res.ok) throw new Error(`上传 ${name} 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

async function detail(token, id) {
  const res = await fetch(`${BASE}/real/document/${id}`, { headers: { Authorization: `Bearer ${token}` } })
  return res.json()
}

/** 把某文档钉成永久 running（清空正文），模拟 processParse fire-and-forget 挂死 */
async function pinRunning(id) {
  const out = await mongo(`
    const r = db.getSiblingDB("knowledge_hub").document_content.updateOne(
      { documentId: "${id}" },
      { $set: { parse_state: "running", parse_error: null, content: null, updated_at: new Date() } }
    );
    print("matched=" + r.matchedCount + " modified=" + r.modifiedCount);
  `)
  return out.trim()
}

const token = await login()
console.log('已登录（admin）\n')

// 入口二：只钉一个已有文档（夹具已建过、或想把任意文档变成超时用例时用）
const pinOnly = process.argv[2]
if (pinOnly) {
  console.log(`钉已有文档  id=${pinOnly}`)
  console.log(`  钉死结果  : ${await pinRunning(pinOnly)}`)
  const after = await detail(token, pinOnly)
  console.log(`  详情复核  : parse_state=${after.parse_state} content=${after.content === null ? 'null' : '非空'}`)
  process.exit(0)
}

// ---- 夹具 1：解析失败的文档（.docx 扩展名 + 非 docx 内容，走 docx 解析路径） ----
const garbage = '这不是一个合法的 docx 文件，只是占位字节。' + 'x'.repeat(512)
const failedDoc = await upload(token, 'fixture-parse-failed.docx', garbage, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
console.log(`夹具 1 · 失败文档  id=${failedDoc.id}`)
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 2000))
  const d = await detail(token, String(failedDoc.id))
  if (d.parse_state === 'failed' || d.parse_state === 'success') {
    console.log(`  终态      : ${d.parse_state}`)
    console.log(`  parse_error: ${JSON.stringify(d.parse_error)}`)
    console.log(`  content    : ${d.content === null ? 'null' : `${String(d.content).length} 字符`}`)
    break
  }
}

// ---- 夹具 2：永久停在 running 的文档（先正常上传，再直接把 Mongo 状态钉死） ----
const stuckDoc = await upload(token, 'fixture-stuck-running.pdf', '%PDF-1.4\n%%EOF', 'application/pdf')
const stuckId = String(stuckDoc.id)
console.log(`\n夹具 2 · 卡死文档  id=${stuckId}`)

// 等后端的解析回调落库（无论成功失败都会写），再覆盖成 running 且清空正文 ——
// 模拟 void this.processParse() 永久挂住：没有 MQ、没有重试、没有超时。
await new Promise((r) => setTimeout(r, 20000))
console.log(`  钉死结果  : ${await pinRunning(stuckId)}`)
const after = await detail(token, stuckId)
console.log(`  详情复核  : parse_state=${after.parse_state} content=${after.content === null ? 'null' : '非空'}`)
