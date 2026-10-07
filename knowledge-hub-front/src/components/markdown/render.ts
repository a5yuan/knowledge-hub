import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import type { RendererRule } from 'markdown-it'

/**
 * markdown 渲染（ADR-0006：真实后端正文格式为 markdown）。
 *
 * 正文来自用户上传文件的解析结果（.md / .txt 更是原文直读），完全不可信，故安全姿态三层：
 * 1. `html: false` —— 正文里的原始 HTML 被转义为文本，输出只含渲染器自己生成的标签
 * 2. 显式 `ALLOWED_TAGS` / `ALLOWED_ATTR` —— 只放行渲染器能产出的标签与属性，不用 DOMPurify 默认集合
 * 3. `link_open` 覆写 —— 外链强制 `target=_blank` + `rel="noopener noreferrer"`
 *
 * 三层缺一不可。改成 `html: true` 等于把安全边界全押在 DOMPurify 上，属安全姿态变更，须另开 ADR。
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

const escapeHtml = md.utils.escapeHtml

/**
 * 代码块：项目无高亮库（README 已知限制），自建完整输出而非覆写默认实现 ——
 * 默认实现需从 `rules.fence` 读回，那是 `RendererRule | undefined`，会引来非空断言。
 * 只声明用得到的两个形参：`RendererRule` 有 5 个，TS 允许少形参赋值，省掉三个无人用的占位。
 */
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const lang = token.info.trim().split(/\s+/)[0] || ''
  const langTag = lang ? `<span class="md-code-lang">${escapeHtml(lang)}</span>` : ''
  return (
    `<div class="md-code-block">${langTag}` +
    `<button class="md-code-copy" type="button">复制</button>` +
    `<pre class="md-code"><code>${escapeHtml(token.content)}</code></pre>` +
    `</div>`
  )
}

/** markdown-it 默认没有 link_open 规则（走 renderToken 兜底），故先取原实现、再回落 */
const defaultLinkOpen: RendererRule | undefined = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

/** 只放行渲染器能产出的标签；`div` / `span` / `button` 是上面代码块自建的外壳与复制按钮 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'strong',
  'em',
  's',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'div',
  'span',
  'button',
]

const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'class', 'target', 'rel', 'align', 'start', 'type']

export function renderMarkdown(source: string): string {
  if (!source) return ''
  return DOMPurify.sanitize(md.render(source), { ALLOWED_TAGS, ALLOWED_ATTR })
}
