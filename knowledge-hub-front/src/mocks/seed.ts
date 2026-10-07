import type {
  Announcement,
  Category,
  Department,
  DocumentItem,
  FileType,
  DocumentType,
  Folder,
  OperationLog,
  ParseStatus,
  DocZone,
  Tag,
  User,
  Visibility,
} from '@/types/api'

/** 以 seed 时刻为基准生成相对日期，保证大盘/筛选演示数据总是"新鲜"的 */
export function daysAgoIso(days: number, hour = 10): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, 24 % (hour + 7), 0, 0)
  return d.toISOString()
}

export const seedDepartments: Department[] = [
  { id: 'd-rd', name: '研发部' },
  { id: 'd-product', name: '产品部' },
  { id: 'd-market', name: '市场部' },
]

export const seedUsers: User[] = [
  {
    id: 'u-admin',
    username: 'admin',
    password: '123456',
    displayName: '张管理员',
    role: 'admin',
    departmentId: 'd-rd',
    status: 'active',
    createdAt: daysAgoIso(90),
  },
  {
    id: 'u-li',
    username: 'li',
    password: '123456',
    displayName: '李成员',
    role: 'member',
    departmentId: 'd-rd',
    status: 'active',
    createdAt: daysAgoIso(80),
  },
  {
    id: 'u-qian',
    username: 'qian',
    password: '123456',
    displayName: '钱研发',
    role: 'member',
    departmentId: 'd-rd',
    status: 'active',
    createdAt: daysAgoIso(60),
  },
  {
    id: 'u-wang',
    username: 'wang',
    password: '123456',
    displayName: '王产品',
    role: 'member',
    departmentId: 'd-product',
    status: 'active',
    createdAt: daysAgoIso(70),
  },
  {
    id: 'u-sun',
    username: 'sun',
    password: '123456',
    displayName: '孙培训',
    role: 'member',
    departmentId: 'd-product',
    status: 'active',
    createdAt: daysAgoIso(50),
  },
  {
    id: 'u-zhao',
    username: 'zhao',
    password: '123456',
    displayName: '赵市场',
    role: 'member',
    departmentId: 'd-market',
    status: 'active',
    createdAt: daysAgoIso(40),
  },
]

export const seedCategories: Category[] = [
  { id: 'cat-product', key: 'product', name: '产品文档', enabled: true, sort: 1 },
  { id: 'cat-tech', key: 'tech', name: '技术文档', enabled: true, sort: 2 },
  { id: 'cat-training', key: 'training', name: '培训资料', enabled: true, sort: 3 },
  { id: 'cat-process', key: 'process', name: '制度流程', enabled: true, sort: 4 },
  { id: 'cat-marketing', key: 'marketing', name: '市场营销', enabled: true, sort: 5 },
]

export const seedTags: Tag[] = [
  { id: 't-1', name: '新人入门' },
  { id: 't-2', name: 'API规范' },
  { id: 't-3', name: '安全合规' },
  { id: 't-4', name: '产品发布' },
  { id: 't-5', name: '客户案例' },
  { id: 't-6', name: '操作手册' },
  { id: 't-7', name: '季度总结' },
  { id: 't-8', name: '前端' },
  { id: 't-9', name: '后端' },
  { id: 't-10', name: '测试' },
]

export const seedFolders: Folder[] = [
  // 我的文档（挂在 u-admin 名下；其他用户的"我的文档"由 ownerId 生成根文件夹）
  { id: 'f-mine-root', name: '我的文档', parentId: null, zone: 'mine', ownerId: 'u-admin', departmentId: null },
  { id: 'f-mine-1', name: '项目资料', parentId: 'f-mine-root', zone: 'mine', ownerId: 'u-admin', departmentId: null },
  { id: 'f-mine-2', name: '个人笔记', parentId: 'f-mine-root', zone: 'mine', ownerId: 'u-admin', departmentId: null },
  // 公共文档
  { id: 'f-pub-root', name: '公共文档', parentId: null, zone: 'public', ownerId: null, departmentId: null },
  { id: 'f-pub-1', name: '公司公告材料', parentId: 'f-pub-root', zone: 'public', ownerId: null, departmentId: null },
  { id: 'f-pub-2', name: '共享模板', parentId: 'f-pub-root', zone: 'public', ownerId: null, departmentId: null },
  // 部门文档（按部门各一个根）
  { id: 'f-dep-rd', name: '研发部文档', parentId: null, zone: 'department', ownerId: null, departmentId: 'd-rd' },
  { id: 'f-dep-rd-1', name: '技术方案', parentId: 'f-dep-rd', zone: 'department', ownerId: null, departmentId: 'd-rd' },
  { id: 'f-dep-rd-2', name: '会议纪要', parentId: 'f-dep-rd', zone: 'department', ownerId: null, departmentId: 'd-rd' },
  { id: 'f-dep-product', name: '产品部文档', parentId: null, zone: 'department', ownerId: null, departmentId: 'd-product' },
  { id: 'f-dep-product-1', name: '产品需求', parentId: 'f-dep-product', zone: 'department', ownerId: null, departmentId: 'd-product' },
  { id: 'f-dep-market', name: '市场部文档', parentId: null, zone: 'department', ownerId: null, departmentId: 'd-market' },
  { id: 'f-dep-market-1', name: '营销物料', parentId: 'f-dep-market', zone: 'department', ownerId: null, departmentId: 'd-market' },
  // 归档
  { id: 'f-arc-root', name: '文档归档', parentId: null, zone: 'archive', ownerId: null, departmentId: null },
  { id: 'f-arc-1', name: '2025 归档', parentId: 'f-arc-root', zone: 'archive', ownerId: null, departmentId: null },
]

type DocTuple = [
  title: string,
  summary: string,
  fileType: FileType | null, // null = 在线文档
  categoryId: string,
  tagIds: string[],
  visibility: Visibility,
  ownerId: string,
  folderId: string,
  parseStatus: ParseStatus,
  daysAgo: number,
  sizeKB: number,
]

/** 32 条种子文档：覆盖全部 fileType、三种可见范围、四种解析状态、三种 owner 部门 */
const docTuples: DocTuple[] = [
  // ---- 在线文档（type=online）----
  ['员工差旅报销制度', '差旅报销的标准流程、票据要求与审批时限说明，适用于全体员工。', null, 'cat-process', ['t-3'], 'company', 'u-admin', 'f-pub-1', 'done', 3, 0],
  ['前端开发 API 对接规范', 'REST 接口命名、鉴权、错误码与分页约定，前端对接统一遵循本规范。', null, 'cat-tech', ['t-2', 't-8'], 'company', 'u-admin', 'f-pub-2', 'done', 6, 0],
  ['新员工入职指南', '入职第一周需要完成的账号开通、制度学习与培训安排清单。', null, 'cat-training', ['t-1'], 'department', 'u-sun', 'f-dep-product-1', 'processing', 1, 0],
  // ---- 产品文档 ----
  ['知识库产品白皮书 v2.4.pdf', '产品定位、核心功能架构与竞品对比分析，2026 年季度更新版。', 'pdf', 'cat-product', ['t-4'], 'company', 'u-wang', 'f-pub-1', 'done', 12, 8421],
  ['产品需求文档-智能搜索模块.docx', '智能搜索模块的功能需求、交互稿说明与验收标准。', 'docx', 'cat-product', ['t-4'], 'department', 'u-wang', 'f-dep-product-1', 'done', 8, 512],
  ['功能规划路线图.xlsx', '2026 下半年功能排期、负责人与里程碑节点。', 'xlsx', 'cat-product', ['t-4', 't-7'], 'department', 'u-wang', 'f-dep-product-1', 'done', 15, 233],
  ['产品发布会演示文稿.pptx', '新一代知识库产品发布会现场演示文稿与讲者备注。', 'pptx', 'cat-product', ['t-4'], 'company', 'u-wang', 'f-pub-1', 'failed', 20, 15632],
  ['需求评审纪要-文档管理.docx', '文档管理模块需求评审结论与待办事项。', 'docx', 'cat-product', [], 'private', 'u-wang', 'f-mine-1', 'pending', 0, 96],
  // ---- 技术文档 ----
  ['系统架构设计说明书.pdf', '前后端架构、数据库选型与部署拓扑的整体设计说明。', 'pdf', 'cat-tech', ['t-9'], 'company', 'u-admin', 'f-pub-1', 'done', 25, 4210],
  ['接口鉴权方案设计.docx', 'JWT 鉴权流程、Token 刷新与失效策略的技术方案。', 'docx', 'cat-tech', ['t-2', 't-9'], 'department', 'u-li', 'f-dep-rd-1', 'done', 5, 380],
  ['数据库变更记录.xlsx', 'PostgreSQL/MongoDB 的集合结构变更历史与回滚说明。', 'xlsx', 'cat-tech', ['t-9'], 'department', 'u-qian', 'f-dep-rd-1', 'done', 18, 145],
  ['前端组件库使用指南.pptx', 'Element Plus 二次封装组件的用法与最佳实践分享。', 'pptx', 'cat-tech', ['t-8'], 'department', 'u-li', 'f-dep-rd-1', 'done', 9, 8930],
  ['ES 索引设计草稿.txt', 'Elasticsearch 文档索引的分词器与字段映射草稿。', 'txt', 'cat-tech', ['t-9'], 'private', 'u-qian', 'f-mine-2', 'processing', 2, 12],
  ['性能压测报告 Q2.pdf', '核心接口 Q2 压测数据、瓶颈分析与优化建议。', 'pdf', 'cat-tech', ['t-10'], 'department', 'u-qian', 'f-dep-rd-1', 'failed', 14, 2654],
  ['代码评审 Checklist.md', '代码评审关注点清单：命名、边界、异常与测试覆盖。', 'md', 'cat-tech', ['t-8', 't-9'], 'company', 'u-admin', 'f-pub-2', 'done', 30, 8],
  ['发布流水线配置说明.txt', 'CI/CD 流水线各阶段配置项与常见失败原因排查。', 'txt', 'cat-tech', ['t-9'], 'department', 'u-li', 'f-dep-rd-2', 'pending', 1, 6],
  // ---- 培训资料 ----
  ['新员工培训课件-产品篇.pptx', '面向新员工的产品体系与核心概念培训课件。', 'pptx', 'cat-training', ['t-1'], 'company', 'u-sun', 'f-pub-1', 'done', 22, 11240],
  ['新人上手练习题库.xlsx', '入职练习题与评分标准，配套入职指南使用。', 'xlsx', 'cat-training', ['t-1'], 'department', 'u-sun', 'f-dep-product-1', 'done', 11, 87],
  ['安全意识培训.pdf', '信息安全红线、常见钓鱼案例与账号安全规范。', 'pdf', 'cat-training', ['t-3'], 'company', 'u-admin', 'f-pub-1', 'done', 28, 3320],
  ['培训签到表模板.xlsx', '培训活动签到与反馈收集的标准表格模板。', 'xlsx', 'cat-training', [], 'company', 'u-sun', 'f-pub-2', 'done', 35, 22],
  // ---- 制度流程 ----
  ['信息安全管理制度.pdf', '公司信息安全总纲：分级、授权与违规处理。', 'pdf', 'cat-process', ['t-3'], 'company', 'u-admin', 'f-pub-1', 'done', 26, 1980],
  ['采购流程说明.docx', '采购申请、比价、审批与验收的完整流程说明。', 'docx', 'cat-process', [], 'company', 'u-admin', 'f-pub-1', 'done', 33, 420],
  ['会议室使用管理办法.txt', '会议室预约规则、设备使用与取消时限。', 'txt', 'cat-process', [], 'company', 'u-li', 'f-pub-1', 'done', 17, 5],
  ['印章使用登记表.xlsx', '用印申请与登记台账模板。', 'xlsx', 'cat-process', ['t-3'], 'department', 'u-admin', 'f-dep-rd-2', 'done', 40, 33],
  ['值班排班制度.docx', '技术值班制度、响应时限与升级路径。', 'docx', 'cat-process', [], 'department', 'u-qian', 'f-dep-rd-1', 'processing', 4, 210],
  // ---- 市场营销 ----
  ['品牌视觉规范手册.pdf', 'Logo 使用、配色与排版规范，对外物料设计必读。', 'pdf', 'cat-marketing', [], 'company', 'u-zhao', 'f-pub-1', 'done', 21, 15320],
  ['客户案例-某制造企业.docx', '制造企业知识库落地案例：痛点、方案与收益数据。', 'docx', 'cat-marketing', ['t-5'], 'company', 'u-zhao', 'f-pub-1', 'done', 10, 640],
  ['市场推广计划 Q3.xlsx', 'Q3 渠道投放计划、预算分配与 KPI 拆解。', 'xlsx', 'cat-marketing', ['t-7'], 'department', 'u-zhao', 'f-dep-market-1', 'done', 7, 178],
  ['展会物料清单.pptx', '季度展会所需的物料清单与供应商联系方式。', 'pptx', 'cat-marketing', [], 'department', 'u-zhao', 'f-dep-market-1', 'failed', 13, 4210],
  ['竞品分析报告-2026H1.pdf', '主要竞品的功能矩阵、定价与市场动向分析。', 'pdf', 'cat-marketing', ['t-5'], 'department', 'u-zhao', 'f-dep-market-1', 'done', 16, 5320],
  // ---- 归档区 ----
  ['2025 年度知识库运营总结.pdf', '上一年度知识库运营数据总结与改进项（已归档）。', 'pdf', 'cat-product', ['t-7'], 'company', 'u-admin', 'f-arc-1', 'done', 120, 2210],
  ['旧版操作手册 v1.0.docx', '已被新版取代的历史版本文档（已归档）。', 'docx', 'cat-training', ['t-6'], 'company', 'u-admin', 'f-arc-1', 'done', 150, 980],
]

/** online 文档的占位 TipTap JSON */
function onlineContent(paragraph: string): Record<string, unknown> {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: paragraph.slice(0, 12) }] },
      { type: 'paragraph', content: [{ type: 'text', text: paragraph }] },
    ],
  }
}

// ---------- 程序化扩充种子（工单 13）：把文档量提升到可演示规模（分页/搜索量级/大盘形态） ----------

/** 每分类的生成主题池，标题形如「主题-Q3-编号.ext」 */
const GEN_TOPICS: Record<string, string[]> = {
  'cat-product': ['用户调研纪要', '版本发布说明', '功能验收报告', '交互设计说明', '灰度发布计划'],
  'cat-tech': ['线上故障复盘', '服务部署手册', '数据迁移方案', '日志采集规范', '缓存治理实践'],
  'cat-training': ['岗位技能地图', '内部课程讲义', '导师带教手册', '学习路径规划', '培训效果评估'],
  'cat-process': ['合同审批流程', '差旅预订指引', '资产领用登记', '访客接待规范', '印章外借流程'],
  'cat-marketing': ['渠道投放复盘', '内容营销日历', '线索转化分析', '直播活动方案', '私域运营手册'],
}

const GEN_CATS = Object.keys(GEN_TOPICS)
const GEN_EXTS: FileType[] = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'txt']
const GEN_BASE_KB: Record<FileType, number> = { pdf: 1200, docx: 180, xlsx: 60, pptx: 2400, md: 12, txt: 6 }
/** done 占多数，其余状态少量穿插，保持解析流转的演示真实感 */
const GEN_STATUSES: ParseStatus[] = ['done', 'done', 'done', 'done', 'processing', 'done', 'pending', 'done', 'failed', 'done']
const GEN_SUMMARIES = [
  (t: string) => `「${t}」的完整记录：背景、关键结论与后续行动项，供团队协作参考。`,
  (t: string) => `整理了${t}的要点与实践建议，覆盖常见问题与注意事项。`,
  (t: string) => `${t}的阶段性沉淀，包含执行步骤、责任分工与时间安排。`,
]

/** department 可见范围：owner 与部门目录联动 */
const GEN_DEPT: Array<{ owner: string; folder: string; cat?: string }> = [
  { owner: 'u-li', folder: 'f-dep-rd-1', cat: 'cat-tech' },
  { owner: 'u-qian', folder: 'f-dep-rd-1', cat: 'cat-tech' },
  { owner: 'u-li', folder: 'f-dep-rd-2', cat: 'cat-process' },
  { owner: 'u-wang', folder: 'f-dep-product-1', cat: 'cat-product' },
  { owner: 'u-sun', folder: 'f-dep-product-1', cat: 'cat-training' },
  { owner: 'u-zhao', folder: 'f-dep-market-1', cat: 'cat-marketing' },
]

/** company 可见范围：挂公共目录 */
const GEN_PUB: Array<{ owner: string; folder: string; cat?: string }> = [
  { owner: 'u-admin', folder: 'f-pub-1', cat: 'cat-process' },
  { owner: 'u-admin', folder: 'f-pub-2', cat: 'cat-tech' },
  { owner: 'u-wang', folder: 'f-pub-1', cat: 'cat-product' },
  { owner: 'u-sun', folder: 'f-pub-1', cat: 'cat-training' },
  { owner: 'u-zhao', folder: 'f-pub-2', cat: 'cat-marketing' },
]

/**
 * 确定性生成 count 篇文档（无随机：编号/主题/类型按 gi 轮换，重启与刷新演示数据稳定）。
 * 比例：private 10% 挂个人目录、company 40% 挂公共目录、department 50% 按部门挂对应目录；
 * 日期覆盖近 44 天且含若干当天文档（支撑大盘「今日新增」）。
 */
function generateSeedDocuments(count: number, startIndex: number): DocumentItem[] {
  return Array.from({ length: count }, (_, i) => {
    const gi = startIndex + i
    const slot = gi % 10
    const isPrivate = slot === 0
    const isCompany = slot >= 1 && slot <= 4
    const pick = isCompany ? GEN_PUB[gi % GEN_PUB.length] : GEN_DEPT[gi % GEN_DEPT.length]
    const categoryId = pick.cat ?? GEN_CATS[gi % GEN_CATS.length]
    const topic = GEN_TOPICS[categoryId][gi % 5]
    const fileType: FileType | null = gi % 17 === 3 ? null : GEN_EXTS[gi % GEN_EXTS.length]
    const seq = String((gi % 9) + 1).padStart(2, '0')
    const title = fileType === null ? `${topic}-Q3-${seq}（在线）` : `${topic}-Q3-${seq}.${fileType}`
    const summary = GEN_SUMMARIES[gi % GEN_SUMMARIES.length](topic)
    const parseStatus = GEN_STATUSES[gi % GEN_STATUSES.length]
    const daysAgo = gi % 11 === 0 ? 0 : (gi * 5 + 2) % 44
    const sizeKB = GEN_BASE_KB[(fileType ?? 'md') as FileType] * ((gi % 9) + 1)
    return {
      id: `d${String(gi + 1).padStart(3, '0')}`,
      title,
      type: (fileType === null ? 'online' : 'file') as DocumentType,
      ...(fileType === null ? {} : { fileType }),
      ...(fileType === null ? { contentJson: onlineContent(summary) } : {}),
      summary,
      categoryId,
      tagIds: [`t-${(gi % 10) + 1}`],
      visibility: (isPrivate ? 'private' : isCompany ? 'company' : 'department') as Visibility,
      zone: (isPrivate ? 'mine' : isCompany ? 'public' : 'department') as DocZone,
      folderId: isPrivate ? (gi % 2 ? 'f-mine-1' : 'f-mine-2') : pick.folder,
      ownerId: isPrivate ? ['u-admin', 'u-wang', 'u-li', 'u-qian'][gi % 4] : pick.owner,
      parseStatus,
      ...(fileType === null ? {} : { fileSize: sizeKB * 1024, fileUrl: `/mock-files/${encodeURIComponent(title)}` }),
      createdAt: daysAgoIso(daysAgo),
      updatedAt: daysAgoIso(Math.max(daysAgo - 1, 0)),
      archivedAt: null,
    }
  })
}

export function buildSeedDocuments(): DocumentItem[] {
  const handWritten = docTuples.map((t, i) => {
    const [title, summary, fileType, categoryId, tagIds, visibility, ownerId, folderId, parseStatus, daysAgo, sizeKB] = t
    const isOnline = fileType === null
    const zone: DocZone = folderId.startsWith('f-arc') ? 'archive' : folderId.startsWith('f-pub') ? 'public' : folderId.startsWith('f-mine') ? 'mine' : 'department'
    const createdAt = daysAgoIso(daysAgo)
    return {
      id: `d${String(i + 1).padStart(3, '0')}`,
      title,
      type: (isOnline ? 'online' : 'file') as DocumentType,
      ...(isOnline ? {} : { fileType }),
      ...(isOnline ? { contentJson: onlineContent(summary) } : {}),
      summary,
      categoryId,
      tagIds,
      visibility,
      zone,
      folderId,
      ownerId,
      parseStatus,
      ...(isOnline ? {} : { fileSize: sizeKB * 1024, fileUrl: `/mock-files/${encodeURIComponent(title)}` }),
      createdAt,
      updatedAt: daysAgoIso(Math.max(daysAgo - 1, 0)),
      archivedAt: zone === 'archive' ? daysAgoIso(Math.max(daysAgo - 5, 0)) : null,
    }
  })

  // 追加程序化生成的演示文档（32 篇手写种子 → 72 篇可演示规模）
  return [...handWritten, ...generateSeedDocuments(40, handWritten.length)]
}

export const seedOperations: OperationLog[] = [
  { id: 'op-01', userId: 'u-wang', action: 'upload', targetId: 'd004', targetTitle: '知识库产品白皮书 v2.4.pdf', detail: '批量上传 1 个文件', createdAt: daysAgoIso(0, 9) },
  { id: 'op-02', userId: 'u-admin', action: 'update', targetId: 'd001', targetTitle: '员工差旅报销制度', detail: '更新在线文档内容', createdAt: daysAgoIso(0, 10) },
  { id: 'op-03', userId: 'u-li', action: 'login', detail: '登录系统', createdAt: daysAgoIso(0, 8) },
  { id: 'op-04', userId: 'u-sun', action: 'upload', targetId: 'd003', targetTitle: '新员工入职指南', detail: '创建在线文档', createdAt: daysAgoIso(1, 14) },
  { id: 'op-05', userId: 'u-zhao', action: 'update', targetId: 'd027', targetTitle: '客户案例-某制造企业.docx', detail: '修改可见范围为全公司', createdAt: daysAgoIso(1, 16) },
  { id: 'op-06', userId: 'u-qian', action: 'delete', targetId: undefined, targetTitle: '临时测试文档.txt', detail: '删除个人草稿', createdAt: daysAgoIso(2, 11) },
  { id: 'op-07', userId: 'u-wang', action: 'login', detail: '登录系统', createdAt: daysAgoIso(2, 9) },
  { id: 'op-08', userId: 'u-admin', action: 'upload', targetId: 'd021', targetTitle: '信息安全管理制度.pdf', detail: '批量上传 1 个文件', createdAt: daysAgoIso(3, 15) },
  { id: 'op-09', userId: 'u-sun', action: 'ai-ask', detail: 'AI 问答：如何申请差旅报销？', createdAt: daysAgoIso(3, 10) },
  { id: 'op-10', userId: 'u-zhao', action: 'upload', targetId: 'd029', targetTitle: '展会物料清单.pptx', detail: '批量上传 3 个文件', createdAt: daysAgoIso(4, 14) },
  { id: 'op-11', userId: 'u-li', action: 'login', detail: '登录系统', createdAt: daysAgoIso(4, 9) },
  { id: 'op-12', userId: 'u-admin', action: 'login', detail: '登录系统', createdAt: daysAgoIso(5, 9) },
]

export const seedAnnouncements: Announcement[] = [
  { id: 'an-1', title: '知识库系统 v2 上线通知', content: '新版知识库已上线，新增智能搜索与在线文档能力，欢迎体验。', enabled: true, createdAt: daysAgoIso(2) },
  { id: 'an-2', title: '信息安全月活动预告', content: '本月将开展信息安全培训与钓鱼演练，请各位同事留意通知。', enabled: true, createdAt: daysAgoIso(5) },
  { id: 'an-3', title: '旧版文档迁移完成', content: '旧版文件服务器文档已全部迁移至知识库，原地址将停用。', enabled: false, createdAt: daysAgoIso(15) },
]

/** 热门搜索词（mock 聚合：命中次数计数） */
export const seedHotSearch: { keyword: string; count: number }[] = [
  { keyword: '报销流程', count: 233 },
  { keyword: 'API 鉴权', count: 187 },
  { keyword: '新人指南', count: 156 },
  { keyword: '品牌规范', count: 121 },
  { keyword: '压测报告', count: 98 },
  { keyword: '竞品分析', count: 87 },
  { keyword: '值班制度', count: 64 },
]
