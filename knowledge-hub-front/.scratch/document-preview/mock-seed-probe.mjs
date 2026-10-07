/**
 * Mock 侧对齐探针（工单 01 验收用，临时脚本，跑完即删）。
 *
 * 用 Vite 自带的 SSR 模块加载器真实执行 src/mocks/db.ts 的模块初始化
 * （含 buildSeedContents），断言种子正文库的填充结果 —— 这是 vue-tsc 与 lint 都看不到的一层。
 */
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  const { db } = await server.ssrLoadModule('/src/mocks/db.ts')
  const { getMockContent } = await server.ssrLoadModule('/src/mocks/content.ts')

  const docs = db.documents
  const files = docs.filter((d) => d.type === 'file')
  const online = docs.filter((d) => d.type === 'online')
  const doneFiles = files.filter((d) => d.parseStatus === 'done')
  const failedFiles = files.filter((d) => d.parseStatus === 'failed')
  const midFiles = files.filter((d) => d.parseStatus === 'pending' || d.parseStatus === 'processing')

  console.log(
    `种子规模：${docs.length} 篇（file ${files.length} / online ${online.length}）；` +
      `done ${doneFiles.length} / failed ${failedFiles.length} / pending+processing ${midFiles.length}\n`,
  )

  check('存在四种解析状态的文件文档可供演示', doneFiles.length > 0 && failedFiles.length > 0 && midFiles.length > 0)

  const doneMissing = doneFiles.filter((d) => !getMockContent(d.id)?.content)
  check(
    'done 的文件文档全部预置 markdown 正文',
    doneMissing.length === 0,
    doneMissing.length ? `缺 ${doneMissing.length} 篇：${doneMissing.slice(0, 3).map((d) => d.title).join(', ')}` : `${doneFiles.length} 篇齐备`,
  )

  const failedMissing = failedFiles.filter((d) => !getMockContent(d.id)?.parseError)
  check(
    'failed 的文件文档全部预置失败原因',
    failedMissing.length === 0,
    failedMissing.length ? `缺 ${failedMissing.length} 篇` : `${failedFiles.length} 篇齐备`,
  )

  const successWithError = doneFiles.filter((d) => getMockContent(d.id)?.parseError)
  check('done 的文档不带失败原因（成功写 null）', successWithError.length === 0)

  // 关键回归：在线文档必须完全不受影响，contentJson（TipTap JSON）不能被换成 markdown
  const polluted = online.filter((d) => getMockContent(d.id) !== undefined)
  check(
    '在线文档未被写入正文库（contentJson 保持 TipTap JSON）',
    polluted.length === 0,
    polluted.length ? `被污染 ${polluted.length} 篇` : `${online.length} 篇均未触碰`,
  )
  const onlineWithoutJson = online.filter((d) => !d.contentJson)
  check('在线文档仍持有 contentJson', onlineWithoutJson.length === 0)

  // 中途态不预置正文（由详情 handler 触发续跑）
  const midWithContent = midFiles.filter((d) => getMockContent(d.id) !== undefined)
  check(
    'pending / processing 的文档不预置正文（留给详情接口触发流转）',
    midWithContent.length === 0,
    midWithContent.length ? `误置 ${midWithContent.length} 篇` : `${midFiles.length} 篇均未预置`,
  )

  // 正文可渲染性：抽一篇实跑 markdown-it
  const sample = getMockContent(doneFiles[0].id).content
  const MarkdownIt = (await import('markdown-it')).default
  const html = new MarkdownIt({ html: false, linkify: true, breaks: true }).render(sample)
  check('种子正文覆盖标题/表格/代码块/引用', /<h1>/.test(html) && /<table>/.test(html) && /<pre>/.test(html) && /<blockquote>/.test(html))
  check('种子正文里的原始 HTML 被转义而非执行', html.includes('&lt;script&gt;') && !/<script/.test(html))
} finally {
  await server.close()
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
