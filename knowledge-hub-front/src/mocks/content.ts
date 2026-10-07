import type { DocumentItem } from '@/types/api'

/**
 * Mock 正文库：等价后端 MongoDB 的 `document_content` 集合。
 *
 * 本模块只 import 类型，不 import `db` —— `db` / `parse` / handlers 单向依赖它。
 * 反向依赖会在 MSW 初始化期形成循环，拿到 `undefined` 的 `db`。
 */

interface MockContent {
  /** markdown 正文，等价 document_content.content */
  content: string
  /** 解析失败原因，等价 document_content.parse_error；成功时为 null */
  parseError: string | null
}

const contents = new Map<string, MockContent>()

export function setMockContent(id: string, value: MockContent): void {
  contents.set(id, value)
}

export function getMockContent(id: string): MockContent | undefined {
  return contents.get(id)
}

/**
 * 生成 mock markdown 正文：刻意覆盖标题 / 列表 / 表格 / 引用 / 代码块，
 * 并内含一段原始 HTML —— 用于验证 `html: false` 下它按文本呈现而非被执行。
 */
export function buildMockMarkdown(doc: DocumentItem): string {
  const name = doc.fileName ?? doc.title
  return [
    `# ${doc.title}`,
    '',
    doc.summary || '（mock 解析未产出摘要）',
    '',
    '## 文档信息',
    '',
    '| 字段 | 值 |',
    '| --- | --- |',
    `| 原始文件 | ${name} |`,
    `| 文档 ID | ${doc.id} |`,
    '| 解析引擎 | mock（等价 MinerU 的 markdown 产出） |',
    '',
    '## 正文',
    '',
    '本段为 mock 解析产出的 markdown，用于验证渲染链路。',
    '',
    '1. 有序列表第一项',
    '2. 有序列表第二项',
    '   - 嵌套无序项',
    '',
    '> 引用块：真实链路里这段来自 MinerU，写入 MongoDB 的 `document_content.content`。',
    '',
    '```ts',
    `const docId = '${doc.id}'`,
    "console.log('解析完成', docId)",
    '```',
    '',
    '原始 HTML 在 `html: false` 下按文本呈现：<script>alert(1)</script> 不会被执行。',
  ].join('\n')
}

/** 种子正文：为 type=file 的终态文档补齐正文 / 错误，供 Mock 演示「解析后 markdown」 */
export function buildSeedContents(documents: DocumentItem[]): void {
  documents.forEach((doc) => {
    // 在线文档的正文是 TipTap JSON（contentJson），塞 markdown 会让 Editor 与审核工作台渲染错乱
    if (doc.type !== 'file') return
    if (doc.parseStatus === 'done') {
      setMockContent(doc.id, { content: buildMockMarkdown(doc), parseError: null })
    } else if (doc.parseStatus === 'failed') {
      setMockContent(doc.id, {
        content: '',
        parseError: '解析失败（mock）：文件已加密或格式不受支持，请下载原文件确认',
      })
    }
  })
}
