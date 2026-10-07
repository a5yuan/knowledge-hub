#!/usr/bin/env node
/**
 * 评测语料种子脚本（工单 13）
 *
 * 现有仓库夹具是「解析失败/卡住」用的占位文件，不能作为 RAG 评测语料，
 * 因此这里生成一套确定性的制度类语料（4 篇），保证评测可复现。
 *
 * 流程：登录(admin) → 上传 → 发布 → 待审核则 approve → 等 status=1 → 等 ES 检索可命中
 * 产出：test/eval/corpus-manifest.json（{title, docId} —— 供 run-eval.mjs 把标题解析为 doc_id）
 *
 * 用法：node test/eval/seed-corpus.mjs
 * 前置：后端已启动，PostgreSQL / ES / RustFS / RabbitMQ 就绪。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '123456';
const HERE = dirname(fileURLToPath(import.meta.url));

/** 确定性评测语料：标题 = 文件名（去扩展名），uniquePhrase 用于探测 ES 索引就绪 */
const CORPUS = [
  {
    title: '考勤与加班餐补制度',
    uniquePhrase: '加班餐补',
    content: `# 考勤与加班餐补制度

## 一、适用范围
本制度适用于公司全体正式员工。

## 二、加班申请流程
加班需提前在 OA 系统提交加班申请，经直属主管审批通过后方可计入加班时长。
未提交申请或未获审批的延时工作不计入加班。

## 三、加班餐补
- 工作日加班至 20:00 之后，可申请加班餐补，标准为 30 元/次。
- 餐补随当月工资一并发放，不在当月重复申报。
- 每位员工每月加班餐补上限为 600 元，超出部分不予发放。
- 周末加班餐补按实际发生次数核算，同样计入每月上限。

## 四、加班工资
- 工作日加班按 1.5 倍工资计算。
- 休息日加班优先安排调休，无法调休的按 2 倍工资计算。
- 法定节假日加班按 3 倍工资计算，不安排调休。
`,
  },
  {
    title: '研发中心新员工入职指南',
    uniquePhrase: '导师制度',
    content: `# 研发中心新员工入职指南

## 第一周清单
1. **账号开通**：向 IT 服务台提交账号申请，IT 在 1 个工作日内完成开通（邮箱、OA、GitLab、Jenkins）。
2. **环境搭建**：安装内网 VPN，克隆部门主仓库，本地跑通构建与单元测试。
3. **规范学习**：阅读《研发代码规范》，代码合并必须经双人评审后方可合入主干。
4. **导师对接**：入职当天由部门负责人指定一名导师。

## 导师制度
- 每名新员工都会指定一名导师，负责前 3 个月的日常答疑与工作节奏对齐。
- 导师期共 3 个月，期内每两周进行一次一对一对齐。
- 导师期为 3 个月的试用期考核提供主要输入，考核通过后导师关系自动结束。

## 试用期
试用期为 6 个月，入职满 3 个月时进行中期评估。
`,
  },
  {
    title: '数据安全与权限管理规范',
    uniquePhrase: '文档密级',
    content: `# 数据安全与权限管理规范

## 一、文档密级
公司文档密级分为三级：
- **公开**：可对外发布，所有员工可见。
- **内部**：默认团队内可见，跨团队访问需申请。
- **机密**：仅项目负责人及以上职级可见，需单独审批。

## 二、权限授予与回收
- 权限按最小必要原则授予，不得超范围授权。
- 员工离职当日回收全部系统权限，由 IT 服务台执行。
- 每季度对全量权限复核一次，核对结果留档。

## 三、数据外发
机密文档禁止通过任何形式外发；内部文档外发需经负责人审批。
`,
  },
  {
    title: '项目立项与审批流程',
    uniquePhrase: '立项申请单',
    content: `# 项目立项与审批流程

## 一、发起
立项由需求方发起，需提交《立项申请单》，写明背景、目标、范围与初步预算。

## 二、技术评估
技术评估环节由技术负责人王工负责，输出技术可行性与工作量评估结论。

## 三、预算审批
- 预算不超过 50 万元的立项，由部门负责人审批。
- 预算超过 50 万元的立项，需 CTO 审批。

## 四、立项后
立项通过后，由 PMO 统一分配项目编号，并同步至项目管理台账。
项目结项时需提交结项报告，由 PMO 归档。
`,
  },
];

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}`);
  const data = await res.json();
  if (!data.accessToken) throw new Error('登录响应缺少 accessToken');
  return data.accessToken;
}

async function upload(token, { title, content }) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), `${title}.md`);
  form.append('authorId', '10001');
  form.append('createBy', '10001');
  const res = await fetch(`${BASE}/document/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`上传失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const doc = await res.json();
  if (!doc.id) throw new Error('上传响应缺少 id');
  return doc.id;
}

async function detail(token, id) {
  const res = await fetch(`${BASE}/document/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`详情失败 ${res.status}`);
  return res.json();
}

/** 轮询直到 predicate 为真；超时返回 false（不抛错，由调用方决定是否失败） */
async function waitFor(label, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.warn(`  ! 等待超时：${label}`);
  return false;
}

async function main() {
  console.log(`== 评测语料种子 ==\nBASE=${BASE} 账号=${USERNAME}\n`);
  const token = await login();
  console.log('已登录\n');

  const manifest = [];
  let failed = 0;

  for (const doc of CORPUS) {
    console.log(`[${doc.title}]`);
    try {
      const id = await upload(token, doc);
      console.log(`  上传完成 id=${id}`);

      const pub = await fetch(`${BASE}/document/${id}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      console.log(`  发布返回 status=${pub.status ?? '?'} review=${pub.review ?? '-'}`);

      // REVIEW_ENABLED=true 时发布进入待审核(2)，需审核通过才到已发布(1)
      if (pub.status === 2) {
        const appr = await fetch(`${BASE}/document/${id}/approve`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: '评测语料自动审核通过' }),
        });
        if (!appr.ok) throw new Error(`审核失败 ${appr.status}: ${(await appr.text()).slice(0, 200)}`);
        console.log('  已自动审核通过');
      }

      const published = await waitFor('status=1（已发布）', 60_000, async () => (await detail(token, id)).status === 1);
      if (!published) throw new Error('文档未进入已发布状态');

      // 等 RAG/Search 管线写入 ES（发布是异步 MQ 消费）
      const indexed = await waitFor('ES 检索可命中', 180_000, async () => {
        const r = await fetch(`${BASE}/search?q=${encodeURIComponent(doc.uniquePhrase)}&pageSize=20`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await r.json();
        return Array.isArray(data.items) && data.items.some((it) => String(it.doc_id) === String(id));
      });
      if (!indexed) throw new Error('ES 索引未就绪（RAG/Search 管线未完成）');

      manifest.push({ title: doc.title, docId: String(id) });
      console.log('  ✓ 已发布且可检索\n');
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${err instanceof Error ? err.message : err}\n`);
    }
  }

  const out = join(HERE, 'corpus-manifest.json');
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: BASE, docs: manifest }, null, 2));
  console.log(`已写出 ${out}（成功 ${manifest.length} / 共 ${CORPUS.length}）`);

  if (failed > 0) {
    console.error(`\n失败 ${failed} 篇，评测语料不完整 —— 终止（exit 1）`);
    process.exit(1);
  }
  console.log('\n提示：KG 图谱为异步 LLM 抽取，图谱用例（qa-010）需等待数分钟后才可能命中。');
}

main().catch((err) => {
  console.error(`种子脚本异常：${err instanceof Error ? err.message : err}`);
  process.exit(1);
});