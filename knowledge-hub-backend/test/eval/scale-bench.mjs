#!/usr/bin/env node
/**
 * 千级语料延迟曲线 + 合成对照语料（补「方案对比卡」SCALE 空白与卡 1 的单路对照缺口）
 *
 * 为什么需要合成语料：
 *   演示库只有 4 篇制度文档 / 34 个 chunk，三种召回模式在 10 条用例上**全部满分**
 *   （retrieval-ablation.mjs 实测），既测不出规模效应，也测不出单路差异。
 *   本脚本生成一套有明确设计的合成语料，用于两件事：
 *     1. 延迟曲线——同一批查询在 6 个语料规模档位下的端到端延迟与分阶段耗时
 *     2. 召回对照——语料里刻意构造了两类可判别的 query 形态（型号类 / 口语类）
 *
 * ⚠️ 诚实边界（写进结论时必须带上）：
 *   - 合成语料**不是**真实业务数据，是"钢铁行业工艺/质检"主题的模板化生成文本
 *   - 型号类查询刻意放了 26 个"只差牌号"的近重复文档，口语类查询刻意做了词汇陷阱
 *     ——查询形态是**构造**出来的，不代表真实流量分布
 *   - 语料以 `_bulk` 直接写 ES `kh_chunk`（等同 pipeline 写索引的产物），
 *     跳过 MinerU 解析 / MQ 投递 / 文档状态机：本实验测的是**检索**而非**入库**
 *   - 因此本实验只能回答"规模上升时检索侧怎么退化"，不能回答"入库管线吞吐"
 *
 * 用法：
 *   node test/eval/scale-bench.mjs             # 生成语料 → 分批入库 → 逐档测延迟
 *   node test/eval/scale-bench.mjs --cleanup   # 只清理合成语料（doc_id 前缀 bench-scale-）
 *   node test/eval/scale-bench.mjs --no-index  # 只生成 dataset-scale.json，不入库
 *
 * 产物：test/eval/dataset-scale.json、test/eval/results/scale-curve.md、scale-curve.csv
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '123456';

const ES_NODE = process.env.ES_NODE ?? 'http://localhost:9200';
const ES_INDEX = 'kh_chunk';
const EMB_BASE = (process.env.EMBEDDING_BASE_URL ?? '').replace(/\/$/, '');
const EMB_MODEL = process.env.EMBEDDING_MODEL;
const EMB_KEY = process.env.OPENAI_API_KEY;
const DIMS = Number(process.env.EMBEDDING_DIMS ?? 1024);
const EMB_BATCH = 10;

/** 合成语料 doc_id 前缀——清理时按此前缀删除 */
const PREFIX = 'bench-scale-';
const K = 5;
const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');

const msg = (err) => (err instanceof Error ? err.message : String(err));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── 合成语料生成 ───────────────────────────

/** 冷轧牌号：26 个只差牌号的近重复文档（型号类查询的判别基础） */
const GRADES = [
  'DC01', 'DC02', 'DC03', 'DC04', 'DC05', 'DC06', 'DC07',
  'SPCC', 'SPCD', 'SPCE', 'SPCF', 'SPCG',
  'St12', 'St13', 'St14', 'St15', 'St16',
  'Q195', 'Q215', 'Q235', 'Q275',
  'HC180Y', 'HC220Y', 'HC260Y', 'HC300Y', 'HC340Y',
];

/** 表面缺陷类型：质检类文档 */
const DEFECTS = [
  '结疤', '麻点', '裂纹', '划伤', '夹杂', '边裂',
  '压痕', '折印', '氧化铁皮', '锈蚀', '辊印', '塔形',
];

/** 连铸分册主题（体量填充，制造规模与噪音） */
const CAST_THEMES = [
  '结晶器保护渣', '二次冷却制度', '电磁搅拌', '轻压下', '连铸坯表面清理',
  '中间包耐材', '拉速与温度匹配', '结晶器锥度', '结晶器振动参数', '凝固末端压下',
  '大包回转台', '浸入式水口', '保护浇注', '钢包滑板', '连铸坯低倍检验',
  '铸坯缓冷', '连铸机对弧', '火焰切割', '去毛刺机', '辊道润滑',
];

/** 确定性伪随机（mulberry32）——保证每次生成同一套语料 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成全部合成文档；每篇返回 { docId, title, chunks: string[] } */
function buildCorpus() {
  const docs = [];
  const rand = rng(20261009);

  // ① 冷轧退火工艺规程 × 26（近重复：正文模板一致，只有牌号与温度不同）
  GRADES.forEach((grade, i) => {
    const soak = 700 + (i % 9) * 5; // 均热段温度
    const speed = 90 + (i % 7) * 10; // 机组速度 m/min
    const cool = 30 + (i % 4) * 5; // 冷却速率 ℃/s
    const chunks = [
      `# 冷轧退火工艺规程（${grade}）

本规程适用于牌号 ${grade} 冷轧薄板的罩式退火作业，适用厚度区间 0.30~1.20mm。

## 一、坯料条件
来料为 ${grade} 冷硬卷，表面不得有乳化液残留与明显锈斑；带钢宽度按订货公差执行。`,
      `## 二、退火温度制度（${grade}）
- 加热段目标温度：${soak + 40} ℃，升温速率控制在 60 ℃/h 以内。
- 均热段保温温度：${soak} ℃，保温时长 12 h。
- 冷却段：以 ${cool} ℃/s 的速率缓冷至 150 ℃ 以下方可出炉。

牌号 ${grade} 对均热温度偏差敏感，实际炉温偏离 ±10 ℃ 以上须重新校核炉温曲线。`,
      `## 三、机组参数与质量要求（${grade}）
- 机组速度：${speed} m/min。
- 退火后力学性能：屈服强度按牌号 ${grade} 的订货技术条件执行，延伸率不低于牌号下限。
- 表面要求：不得出现粘结、氧化色差与折印。

## 四、记录
每炉次须记录 ${grade} 的实际炉温曲线、保温时长与出炉温度，随炉次卡归档。`,
    ];
    docs.push({ docId: `${PREFIX}anneal-${i + 1}`, title: `冷轧退火工艺规程（${grade}）`, chunks });
  });

  // ② 表面缺陷判定与处置标准 × 12
  DEFECTS.forEach((defect, i) => {
    const limit = 2 + (i % 5);
    const chunks = [
      `# 表面缺陷判定与处置标准（${defect}）

## 一、缺陷描述
${defect}：${defect}多见于带钢的${['上表面', '下表面', '边部', '中部'][i % 4]}，肉眼或经光照后可辨识。

## 二、判定限值
- 单处长度不超过 ${limit} mm，且每米不超过 ${limit} 处时，判为合格。
- 超出上述限值时，降级或判废。`,
      `## 三、处置流程（${defect}）
1. 质检员在 ${defect} 首次发现时开立不合格通知单。
2. 由工艺工程师确认 ${defect} 的产生工序，必要时取样复检。
3. 按《产品质量事故分级与追责办法》判定责任归属后转生产处置。

## 四、归档
${defect} 的判定记录按月汇总，纳入质量月报。`,
    ];
    docs.push({ docId: `${PREFIX}defect-${i + 1}`, title: `表面缺陷判定与处置标准（${defect}）`, chunks });
  });

  // ③ 力学性能异常处置规程（口语类查询的正确答案来源）
  docs.push({
    docId: `${PREFIX}mech-1`,
    title: '板形与力学性能异常处置规程',
    chunks: [
      `# 板形与力学性能异常处置规程

## 一、适用范围
本规程规定冷轧薄板在后工序成形过程中出现塑性指标异常的判定与处置方法。

## 二、塑性指标不足的判定
当带钢在后工序成形时出现边缘延展不均、外形失稳，或按抽检试样测得塑性指标低于订货技术条件时，
判为塑性指标不足。该情形属于组织状态问题，与表面质量无关。`,
      `## 三、处置措施
1. 提高罩式炉均热段的保温时长，由 12 h 延长至 16 h，使晶粒充分再结晶。
2. 必要时调整炉温曲线，将均热温度上调 20~30 ℃。
3. 上述措施的目的是降低材料的抗变形能力，使塑性指标回到合格区间。
4. 处置后须重新取样复检，合格方可转入下工序。

## 四、与表面缺陷的区分
本规程处置的是**组织性能**问题；表面类缺陷（结疤、麻点等）按《表面缺陷判定与处置标准》处置。`,
    ],
  });

  // ④ 产品质量事故分级与追责办法（口语类查询的词汇陷阱干扰项）
  docs.push({
    docId: `${PREFIX}liability-1`,
    title: '产品质量事故分级与追责办法',
    chunks: [
      `# 产品质量事故分级与追责办法

## 一、事故分级
- 一般事故：单批次判废重量不超过 5 吨。
- 较大事故：单批次判废重量超过 5 吨但不超过 30 吨。
- 重大事故：单批次判废重量超过 30 吨，或造成客户产线停线。

## 二、常见事故情形
冲压时裂开、材料过硬导致模具损耗、焊接后母材断裂等情形，均属已发生的质量事故，须逐起登记。`,
      `## 三、追责
事故责任按"工序归属 + 操作记录"认定：
1. 属工艺参数设定不当的，责任人为对应工艺工程师。
2. 属操作未按规程执行的，责任人为当班操作工。
3. 属来料带入的，追溯至上游供方。

## 四、整改
每起事故须在 5 个工作日内提交整改报告，由质量管理部关闭。`,
    ],
  });

  // ⑤ 连铸工艺规程分册（规模填充：制造近义噪音，让召回候选池变拥挤）
  CAST_THEMES.forEach((theme, i) => {
    for (let vol = 1; vol <= 18; vol++) {
      const idx = i * 18 + vol;
      const temp = 1540 + (idx % 17);
      const speed = (0.8 + (idx % 9) * 0.05).toFixed(2);
      const chunks = [
        `# 连铸工艺规程·${theme}（第 ${vol} 分册）

## 一、适用范围
本分册适用于${theme}相关的连铸作业，配合《连铸工艺规程·总则》执行。

## 二、基本参数
- 中间包温度：${temp} ℃。
- 拉速：${speed} m/min。
- 断面：${[150, 200, 230, 250][idx % 4]} × ${[1200, 1400, 1600][idx % 3]} mm。`,
        `## 三、${theme}作业要点（第 ${vol} 分册）
- 作业前确认设备状态与工艺卡一致，参数未经批准不得擅自调整。
- ${theme}过程须连续记录，异常时按应急处置流程上报当班调度。
- 与${CAST_THEMES[(i + 1) % CAST_THEMES.length]}衔接时注意节奏匹配，避免温度损失。`,
        `## 四、质量判定（第 ${vol} 分册）
铸坯低倍检验按中心偏析、中心疏松、角部裂纹三项评级；
存在 ${['角部裂纹', '中心偏析', '中心疏松', '表面横裂'][idx % 4]} 超标的，按不合格处置。

## 五、存档
本分册的执行记录随生产批次归档，保存期不少于三年。`,
      ];
      docs.push({ docId: `${PREFIX}cast-${idx}`, title: `连铸工艺规程·${theme}（第 ${vol} 分册）`, chunks });
    }
  });

  // 打散顺序，避免索引时"同类扎堆"
  for (let i = docs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [docs[i], docs[j]] = [docs[j], docs[i]];
  }
  return docs;
}

/** 生成设计查询集（dataset-scale.json）——两类刻意构造的可判别形态 */
function buildQueries() {
  const items = [];
  // 型号类：查询只给牌号 + 通用词，期望精确命中断言该牌号的文档
  const termGrades = GRADES.filter((_, i) => i % 2 === 0); // 13 个
  termGrades.forEach((g, i) => {
    items.push({
      id: `sc-term-${String(i + 1).padStart(2, '0')}`,
      group: 'term',
      intent: 'knowledge',
      question: `${g} 的均热段保温温度和机组速度分别是多少？`,
      expected_doc_titles: [`冷轧退火工艺规程（${g}）`],
      notes: '型号类：语料里存在 26 篇只差牌号的近重复文档，考的是精确词元匹配。',
    });
  });
  // 口语类：查询刻意不含答案文档的实词，且与某个干扰文档共享字面词（词汇陷阱）
  const colloquial = [
    { q: '冲压时总是裂开，是不是材料太硬了？', a: '板形与力学性能异常处置规程' },
    { q: '板子一成形就变形走样，是不是太硬？', a: '板形与力学性能异常处置规程' },
    { q: '工件加工时边缘展不开，是什么原因？', a: '板形与力学性能异常处置规程' },
    { q: '料太硬加工不动，炉子那边要怎么调？', a: '板形与力学性能异常处置规程' },
    { q: '怎样才能让钢板变得容易成形一些？', a: '板形与力学性能异常处置规程' },
    { q: '抽检试样测出来偏硬，该走哪个流程？', a: '板形与力学性能异常处置规程' },
  ];
  colloquial.forEach((c, i) => {
    items.push({
      id: `sc-nat-${String(i + 1).padStart(2, '0')}`,
      group: 'natural',
      intent: 'knowledge',
      question: c.q,
      expected_doc_titles: [c.a],
      notes: '口语类：查询用词与答案文档不重合，但字面命中《产品质量事故分级与追责办法》干扰项。',
    });
  });
  return { version: '1.0.0', description: '合成对照语料查询集（scale-bench.mjs 生成）', k: K, items };
}

// ─────────────────────────── 基础设施调用 ───────────────────────────

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

/** 批量向量化（与后端 EmbeddingService 同模型 / 同维度 / 同 batchSize=10） */
async function embedBatch(texts) {
  const res = await fetch(`${EMB_BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EMB_KEY}` },
    body: JSON.stringify({ model: EMB_MODEL, input: texts, encoding_format: 'float' }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const vectors = (data.data ?? []).map((d) => d.embedding);
  if (vectors.length !== texts.length) {
    throw new Error(`embedding 返回条数不符 期望=${texts.length} 实际=${vectors.length}`);
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== DIMS) {
      throw new Error(`embedding 维度不符 期望=${DIMS} 实际=${v?.length}`);
    }
  }
  return vectors;
}

async function bulkIndex(ops) {
  const res = await fetch(`${ES_NODE}/_bulk?refresh=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body: ops.join('\n') + '\n',
  });
  if (!res.ok) throw new Error(`_bulk ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.errors) {
    const bad = data.items.find((it) => Object.values(it)[0]?.error);
    throw new Error(`_bulk 存在失败项: ${JSON.stringify(bad).slice(0, 400)}`);
  }
  // 防回归：ES 对同 _id 是 last-write-wins，_id 重复会**静默**吞掉写入，
  // 表现为「esCount 增量 < 本批条数」。这里显式断言，避免再次把语料规模测小。
  const expected = ops.length / 2;
  if ((data.items?.length ?? 0) !== expected) {
    throw new Error(`_bulk 返回条数不符 期望=${expected} 实际=${data.items?.length}`);
  }
  return data.items.length;
}

async function esCount() {
  const res = await fetch(`${ES_NODE}/${ES_INDEX}/_count`);
  const data = await res.json();
  return data.count ?? 0;
}

async function refreshIndex() {
  await fetch(`${ES_NODE}/${ES_INDEX}/_refresh`, { method: 'POST' });
}

async function deleteBenchChunks() {
  const res = await fetch(`${ES_NODE}/${ES_INDEX}/_delete_by_query?refresh=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { prefix: { doc_id: PREFIX } } }),
  });
  const data = await res.json();
  return data.deleted ?? 0;
}

/** 单次检索（生产配置：hybrid + rerank on），返回端到端与分阶段耗时 */
async function searchOnce(token, q) {
  const url = `${BASE}/rag/search?q=${encodeURIComponent(q)}&top_k=${K}&rerank=true&mode=hybrid`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const wall = Date.now() - t0;
  if (!res.ok) throw new Error(`/rag/search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    wall_ms: wall,
    took_ms: data.took_ms ?? null,
    stages: data.stages ?? null,
    titles: items.map((it) => it.doc_title),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const percentile = (xs, p) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
};
const fmt = (v, d = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

// ─────────────────────────── 主流程 ───────────────────────────

/** 规模档位：每档入库的 wave 大小（按 chunk 计） */
const WAVES = [250, 250, 250, 250, 250];
/** 每档重复次数（对同一批查询循环 REPEATS 轮） */
const REPEATS = Number(process.env.SCALE_REPEATS ?? 3);

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has('--cleanup')) {
    const deleted = await deleteBenchChunks();
    console.log(`已清理合成语料 chunk：${deleted} 条（doc_id 前缀 ${PREFIX}）`);
    console.log(`当前 ${ES_INDEX} 总数：${await esCount()}`);
    return;
  }

  if (!EMB_BASE || !EMB_MODEL || !EMB_KEY) {
    throw new Error('缺少 EMBEDDING_BASE_URL / EMBEDDING_MODEL / OPENAI_API_KEY');
  }

  const corpus = buildCorpus();
  const queries = buildQueries();
  const chunkTotal = corpus.reduce((a, d) => a + d.chunks.length, 0);
  // 语料自检：doc_id 与 (doc_id, chunk_index) 必须唯一，否则 _bulk 会静默去重、把规模测小
  const docIds = new Set(corpus.map((d) => d.docId));
  if (docIds.size !== corpus.length) {
    throw new Error(`合成语料 doc_id 重复：${corpus.length} 篇文档只有 ${docIds.size} 个唯一 id`);
  }
  const keys = new Set();
  for (const d of corpus) {
    for (let i = 0; i < d.chunks.length; i++) {
      const k = `${d.docId}-${i}`;
      if (keys.has(k)) throw new Error(`合成语料 _id 重复：${k}`);
      keys.add(k);
    }
  }
  const dsPath = join(HERE, 'dataset-scale.json');
  writeFileSync(dsPath, JSON.stringify(queries, null, 2), 'utf8');
  console.log(
    `合成语料：${corpus.length} 篇文档 / ${chunkTotal} 个 chunk；查询集 ${queries.items.length} 条 → ${dsPath}`,
  );
  if (args.has('--no-index')) return;

  mkdirSync(RESULTS_DIR, { recursive: true });

  const token = await login();
  const baseCount = await esCount();
  console.log(`入库前 ${ES_INDEX} 总数（真实演示语料）：${baseCount}\n`);

  /** 档位记录 */
  const curve = [];

  /** 在指定规模下测一批查询 */
  async function measurePoint(scaleLabel, chunkCount) {
    const lat = [];
    const stageAcc = { embed_ms: [], knn_ms: [], bm25_ms: [], fuse_ms: [], rerank_ms: [] };
    let errors = 0;
    for (let r = 0; r < REPEATS; r++) {
      for (const item of queries.items) {
        try {
          const res = await searchOnce(token, item.question);
          lat.push(res.wall_ms);
          if (res.stages) for (const k of Object.keys(stageAcc)) stageAcc[k].push(res.stages[k] ?? 0);
        } catch {
          errors += 1;
        }
      }
    }
    const point = {
      scale: scaleLabel,
      chunks: chunkCount,
      n: lat.length,
      errors,
      mean: mean(lat),
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      max: lat.length ? Math.max(...lat) : 0,
      stages: Object.fromEntries(Object.entries(stageAcc).map(([k, v]) => [k, mean(v)])),
    };
    curve.push(point);
    console.log(
      `${scaleLabel.padEnd(12)} chunks=${String(chunkCount).padStart(5)}  ` +
        `均值 ${fmt(point.mean)} ms  P50 ${fmt(point.p50)}  P95 ${fmt(point.p95)}  P99 ${fmt(point.p99)}  ` +
        `embed ${fmt(point.stages.embed_ms)}  召回 ${fmt(point.stages.knn_ms)}/${fmt(point.stages.bm25_ms)}  精排 ${fmt(point.stages.rerank_ms)}` +
        (errors ? `  ⚠️ 错误 ${errors}` : ''),
    );
  }

  console.log('开始逐档测量（生产配置 hybrid + rerank=on）\n');
  await measurePoint('基线', baseCount);

  // 逐 wave 入库 → 每档测一次
  let embCursor = 0;
  const flatChunks = [];
  for (const doc of corpus) {
    doc.chunks.forEach((content, i) => {
      flatChunks.push({ docId: doc.docId, title: doc.title, chunkIndex: i, content });
    });
  }

  for (let w = 0; w < WAVES.length; w++) {
    const slice = flatChunks.slice(embCursor, embCursor + WAVES[w]);
    if (!slice.length) break;
    process.stdout.write(`入库 wave ${w + 1}：${slice.length} chunk 向量化中…\r`);
    const ops = [];
    for (let i = 0; i < slice.length; i += EMB_BATCH) {
      const batch = slice.slice(i, i + EMB_BATCH);
      const vectors = await embedBatch(batch.map((c) => c.content));
      batch.forEach((c, j) => {
        ops.push(JSON.stringify({ index: { _index: ES_INDEX, _id: `${c.docId}-${c.chunkIndex}` } }));
        ops.push(
          JSON.stringify({
            doc_id: c.docId,
            doc_title: c.title,
            chunk_index: c.chunkIndex,
            content: c.content,
            embedding: vectors[j],
            created_at: new Date().toISOString(),
            author_id: null,
            team_id: null,
            status: 1,
            is_public: false,
          }),
        );
      });
    }
    await bulkIndex(ops);
    await refreshIndex();
    embCursor += slice.length;
    await sleep(500); // 让 ES 段合并/缓存稳定
    await measurePoint(`wave ${w + 1} 后`, await esCount());
  }

  // ── 出报告 ──
  const lines = [];
  lines.push('# 千级语料规模 · 检索延迟曲线');
  lines.push('');
  lines.push('## 测试方法');
  lines.push('');
  lines.push('- 被测接口：`GET /rag/search`（生产配置：`mode=hybrid`、`rerank=true`、`top_k=5`）');
  lines.push(`- 查询集：\`test/eval/dataset-scale.json\`，${queries.items.length} 条固定查询（13 型号类 + 6 口语类），每档重复 ${REPEATS} 轮`);
  lines.push(`- 语料：合成"钢铁行业工艺/质检"语料，共 ${corpus.length} 篇 / ${chunkTotal} chunk，分 ${WAVES.length} 批入库；基线为真实演示语料 ${baseCount} chunk`);
  lines.push('- 入库方式：DashScope embedding（同 `EMBEDDING_MODEL`、1024 维、batch=10）→ `_bulk` 直写 `kh_chunk` → `_refresh` → 测下一档');
  lines.push('- 延迟口径：`wall_ms` = 客户端侧端到端（含 HTTP、鉴权、查询向量化、双路召回、RRF、精排）；stages 为后端自报分阶段均值');
  lines.push('- 环境：本机开发机，全部中间件以 Docker 单容器运行（ES 单节点，`-Xms512m -Xmx512m`）；`LANGFUSE_ENABLED=false`（排除云端 tracing 的额外往返）');
  lines.push('');
  lines.push('## 延迟曲线');
  lines.push('');
  lines.push('| 档位 | 语料 chunk 数 | 样本数 | 均值 ms | P50 ms | P95 ms | P99 ms | 最大 ms | 错误 |');
  lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const p of curve) {
    lines.push(
      `| ${p.scale} | ${p.chunks} | ${p.n} | ${fmt(p.mean)} | ${fmt(p.p50)} | ${fmt(p.p95)} | ${fmt(p.p99)} | ${fmt(p.max)} | ${p.errors} |`,
    );
  }
  lines.push('');
  lines.push('## 分阶段耗时随规模变化（均值 ms）');
  lines.push('');
  lines.push('| 档位 | 查询向量化 | KNN 召回 | BM25 召回 | RRF 融合 | 精排 |');
  lines.push('| :--- | ---: | ---: | ---: | ---: | ---: |');
  for (const p of curve) {
    lines.push(
      `| ${p.scale} | ${fmt(p.stages.embed_ms)} | ${fmt(p.stages.knn_ms)} | ${fmt(p.stages.bm25_ms)} | ${fmt(p.stages.fuse_ms)} | ${fmt(p.stages.rerank_ms)} |`,
    );
  }
  lines.push('');
  lines.push('> 注：KNN 与 BM25 在 hybrid 下并行发起，两者耗时为各自独立计量，不可直接相加当作端到端增量。');
  lines.push('');

  const md = lines.join('\n');
  writeFileSync(join(RESULTS_DIR, 'scale-curve.md'), md, 'utf8');
  const csv = [
    'scale,chunks,n,mean_ms,p50_ms,p95_ms,p99_ms,max_ms,errors,embed_ms,knn_ms,bm25_ms,fuse_ms,rerank_ms',
    ...curve.map((p) =>
      [
        `"${p.scale}"`, p.chunks, p.n, p.mean.toFixed(1), p.p50.toFixed(1), p.p95.toFixed(1),
        p.p99.toFixed(1), p.max.toFixed(1), p.errors,
        p.stages.embed_ms.toFixed(1), p.stages.knn_ms.toFixed(1), p.stages.bm25_ms.toFixed(1),
        p.stages.fuse_ms.toFixed(1), p.stages.rerank_ms.toFixed(1),
      ].join(','),
    ),
  ].join('\n');
  writeFileSync(join(RESULTS_DIR, 'scale-curve.csv'), csv, 'utf8');
  writeFileSync(join(RESULTS_DIR, 'scale-curve.json'), JSON.stringify({ generatedAt: new Date().toISOString(), baseCount, chunkTotal, repeats: REPEATS, curve }, null, 2), 'utf8');

  console.log('\n' + md);
  console.log(`\n已写入 ${join(RESULTS_DIR, 'scale-curve.md')} / .csv / .json`);
  console.log(`提示：合成语料仍在索引中，清理请执行 node test/eval/scale-bench.mjs --cleanup`);
}

main().catch((err) => {
  console.error(`运行失败：${msg(err)}`);
  process.exit(1);
});
