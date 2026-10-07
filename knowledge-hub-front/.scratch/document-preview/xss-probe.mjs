/**
 * XSS 探针（工单 01 验收用，临时脚本，跑完即删）。
 *
 * 复刻 src/components/markdown/render.ts 的 markdown-it 配置与两条自定义规则
 * （DOMPurify 需要 DOM 才能实例化，Node 侧无 DOM 实现，故此处复刻第一道闸门的完整链条，
 *  并对输出断言 DOMPurify 白名单本应保证的不变量：若输出已不含任何可执行构造，
 *  DOMPurify 在该输出上无事可做，第二道闸门为纯冗余防御）。
 */
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const escapeHtml = md.utils.escapeHtml

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

const defaultLinkOpen = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'strong', 'em', 's', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div', 'span', 'button',
])

const PROBES = [
  ['原始 script 标签', '<script>alert(1)</script>'],
  ['img onerror 事件', '<img src=x onerror="alert(2)">'],
  ['javascript: 链接', '[x](javascript:alert(3))'],
  ['style 标签', '<style>body{display:none}</style>'],
  ['围栏内 </code></pre> 逃逸', '```\n</code></pre><script>alert(4)</script>\n```'],
  ['原始 a[href=javascript:]', '<a href="javascript:alert(5)">x</a>'],
  ['javascript: 图片', '![x](javascript:alert(6))'],
  ['iframe', '<iframe src="https://evil.example"></iframe>'],
  ['data:text/html 链接', '[y](data:text/html;base64,PHNjcmlwdD5hbGVydCg3KTwvc2NyaXB0Pg==)'],
  ['svg onload', '<svg onload="alert(8)"></svg>'],
  ['html 注释内脚本', '<!--<script>alert(9)</script>-->'],
]

/**
 * 断言 DOMPurify 白名单本应保证的不变量。
 * 只扫描**真标签**：转义后的 `&lt;img onerror=&quot;` 是字面文本（含 onerror= 但不是属性），
 * 用「在 `<tag` 与 `>` 之间」的扫描方式区分二者 —— 若不区分，会把已转义的文本误判为属性。
 */
const REAL_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

function violations(html) {
  const found = []
  for (const m of html.matchAll(REAL_TAG)) {
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) found.push(`非白名单标签 <${tag}>`)
    if (closing) continue
    const attrs = m[3]
    for (const a of attrs.matchAll(/([a-zA-Z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g)) {
      const name = a[1].toLowerCase()
      const value = a[2].replace(/^["']|["']$/g, '')
      if (/^on/.test(name)) found.push(`事件属性 ${name}= 于 <${tag}>`)
      if (name !== 'href' && name !== 'src' && name !== 'class') continue
      if (/^\s*javascript:/i.test(value)) found.push(`javascript: 地址于 <${tag} ${name}>`)
      if (/^\s*data:text\/html/i.test(value)) found.push(`data:text/html 地址于 <${tag} ${name}>`)
    }
  }
  if (/<script|<style|<iframe|<object|<embed|<svg|<math/i.test(html)) found.push('存在可执行/嵌入标签')
  return found
}

let failed = 0
for (const [name, payload] of PROBES) {
  const html = md.render(payload)
  const bad = violations(html)
  if (bad.length > 0) failed += 1
  console.log(`\n=== ${name} ${bad.length === 0 ? 'PASS' : 'FAIL'} ===`)
  console.log(`payload : ${JSON.stringify(payload)}`)
  console.log(`output  : ${html.replace(/\n/g, '\\n')}`)
  if (bad.length > 0) console.log(`违规    : ${bad.join('; ')}`)
}

console.log(`\n合计：${PROBES.length - failed}/${PROBES.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
