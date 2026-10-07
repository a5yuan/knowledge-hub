import { db } from './db'
import { buildMockMarkdown, setMockContent } from './content'

/**
 * 解析管道 mock（ADR-0004）：pending → processing（2~4s）→ done 90% / failed 10%。
 * setTimeout 直接变更内存库，前端轮询列表/详情即可看到流转；
 * 终态同时写入正文或错误（等价后端 processParse 落 Mongo document_content）；
 * 二期接真实解析管道时仅需替换本模块（handler 调用点不变）。
 */

const MIN_MS = 2000
const MAX_MS = 4000
const SUCCESS_RATE = 0.9

/**
 * 在途调度的 id 集合：上传路径与详情 handler 都会调用 scheduleParse，
 * 靠它保证同一文档同时只有一条时序（否则两次调度会各自推进，出现状态回退或重复写正文）。
 */
const scheduled = new Set<string>()

function randMs(): number {
    return MIN_MS + Math.random() * (MAX_MS - MIN_MS)
}

function findDoc(docId: string) {
    return db.documents.find((d) => d.id === docId)
}

/** 推进到终态并落正文/错误；每个出口都必须把 id 移出在途集合，否则该文档再也无法被重新调度 */
function finish(docId: string): void {
    scheduled.delete(docId)
    const doc = findDoc(docId)
    if (!doc || doc.parseStatus !== 'processing') return
    const success = Math.random() < SUCCESS_RATE
    doc.parseStatus = success ? 'done' : 'failed'
    doc.updatedAt = new Date().toISOString()
    if (success) {
        doc.summary = `${doc.title} 的内容摘要（mock 解析生成）`
        setMockContent(docId, { content: buildMockMarkdown(doc), parseError: null })
    } else {
        setMockContent(docId, {
            content: '',
            parseError: '解析失败（mock）：文件已加密或格式不受支持，请下载原文件确认',
        })
    }
}

function toProcessing(docId: string): void {
    scheduled.delete(docId)
    const doc = findDoc(docId)
    if (!doc || doc.parseStatus !== 'pending') return
    doc.parseStatus = 'processing'
    doc.updatedAt = new Date().toISOString()
    setTimeout(() => finish(docId), randMs())
}

/**
 * 调度解析流转。幂等：同一文档在途时直接返回；已到终态（done/failed）不再重启。
 * 停在 pending / processing 的种子文档由详情页调用本函数续跑 —— 否则预览页的轮询
 * 只能等到有界超时（后端同样存在 pending 挂死的缺口，见工单备注「已知后端缺陷」）。
 */
export function scheduleParse(docId: string): void {
    const doc = findDoc(docId)
    if (!doc || doc.type !== 'file') return
    if (doc.parseStatus !== 'pending' && doc.parseStatus !== 'processing') return
    if (scheduled.has(docId)) return
    scheduled.add(docId)
    if (doc.parseStatus === 'pending') setTimeout(() => toProcessing(docId), randMs())
    else setTimeout(() => finish(docId), randMs())
}
