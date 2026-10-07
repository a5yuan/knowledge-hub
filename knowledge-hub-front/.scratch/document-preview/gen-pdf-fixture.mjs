// 生成浏览器走查用的最小合法 PDF（临时脚本，与 e2e-probe.mjs 的 buildPdf 同构）
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const stream = 'BT /F1 20 Tf 72 760 Td (Browser Walkthrough PDF) Tj 0 -36 Td (Parsed by MinerU.) Tj ET'
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
const pdf = body + `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
const out = fileURLToPath(new URL('./fixtures-browser/walkthrough-clean.pdf', import.meta.url))
writeFileSync(out, pdf, 'latin1')
console.log('pdf written:', pdf.length, 'bytes →', out)
