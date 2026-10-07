/**
 * TipTap JSON 的结构化视图（ADR-0002：内容以 JSON 存储，可迁移）。
 * 双向兼容 @tiptap/core 的 JSONContent：可直接传入 editor content，也可承接 editor.getJSON()。
 */
export interface EditorJSON {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: EditorJSON[]
  [key: string]: unknown
}

export const EMPTY_DOC: EditorJSON = { type: 'doc', content: [] }
