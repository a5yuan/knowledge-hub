#!/usr/bin/env node
/**
 * 合成语料上的单路召回消融（Recall Ablation on Synthetic Corpus）
 *
 * ## 为什么需要合成语料
 * 生产环境 `kh_chunk` 只有 34 个切片 / 4 篇同质化制度文档，四个臂**全部满分**，
 * 完全无判别力（见 recall-ablation.mjs 的结果）。要回答「双路是否必要」，
 * 必须构造一个**词面重叠度与语义分布都有梯度**的受控语料 —— 这是检索消融的标准做法。
 *
 * ## 语料设计（8 篇 / 24 切片，全部以 `synth-` 前缀的 doc_id 标识）
 * - **型号密集型**：正文堆满牌号/参数（Q345B、HRB400E、二冷水量…）
 *   → 精确 token 命中，**BM25 强、KNN 可能弱**
 * - **口语目标型**：正文用书面语，查询用口语
 *   → 词面几乎不重叠，**KNN 强、BM25 弱**
 * - **同域干扰型**（6 篇）：与上面同属冶金/制造域但主题不同，制造 near-miss 候选
 *
 * ## 诚实边界（写进报告，不要隐藏）
 * - 这是**合成语料**，只用于暴露「双路价值的边界条件」，**不能当作生产质量结论**
 * - 语料由本脚本确定性生成（无随机），因此**完全可复现**
 * - 跑完自动删除全部 `synth-*` 切片，不污染环境
 *
 * ## 用法
 *   node test/eval/recall-ablation-synth.mjs          # 造语料 → 消融 → 清理
 *   node test/eval/recall-ablation-synth.mjs --keep   # 保留语料（调试用）
 *   node test/eval/recall-ablation-synth.mjs --clean  # 只清理
 *
 * 前置：ES 已就绪（**不需要后端**）。
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';

const ES = (process.env.ES_NODE ?? 'http://localhost:9200').replace(/\/$/, '');
const EMB_URL = (process.env.EMBEDDING_BASE_URL ?? '').replace(/\/$/, '');
const EMB_MODEL = process.env.EMBEDDING_MODEL ?? 'qwen3.7-text-embedding-flash';
const API_KEY = process.env.OPENAI_API_KEY;

const INDEX = 'kh_chunk';
const PREFIX = 'synth-';
const RECALL_SIZE = 50;   // 与生产一致
const RRF_K = 60;         // 与生产一致
const K = 5;
const SOURCE = ['doc_id', 'doc_title', 'chunk_index', 'content'];

const msg = (e) => (e instanceof Error ? e.message : String(e));

// ─────────────────────────── 合成语料定义 ───────────────────────────

// ─────────────────── v1：小语料（18 切片，无 hard negative） ───────────────────
// 保留 v1 是为了可复现：v1 的结果是「四臂几乎无差异」，说明**语料不够狠就测不出差异**，
// 这本身就是「双路价值有边界条件」的证据之一。

const V1 = (() => {
  const model = {
    title: '连铸工艺参数调整规程',
    chunks: [
      '适用范围：本规程适用于 Q345B、Q235B、HRB400E、HRB500E 四个牌号的板坯连铸生产，覆盖 150mm 与 200mm 两种断面。',
      '二次冷却水量设定：Q345B 在拉速 0.9 m/min 时二冷水总量为 320 L/min，比水量按 1.15 L/kg 控制；HRB400E 同拉速下二冷水总量为 300 L/min，比水量 1.05 L/kg。水量调整步长不超过 10 L/min。',
      '拉速与过热度：结晶器过热度控制在 15~25 ℃；Q345B 拉速上限 1.10 m/min，HRB400E 拉速上限 1.25 m/min。过热度每升高 5 ℃，拉速上限下调 0.05 m/min。',
    ],
  };
  const colloquial = {
    title: '板形与力学性能异常处置规程',
    chunks: [
      '当轧件出现加工硬化倾向增强、变形抗力上升时，应核查加热制度与终轧温度是否偏低，必要时提高均热段温度并延长均热时间。',
      '若产品硬度超出交付要求且后续机加工出现刀具异常磨损，需回溯化学成分与冷却路径，确认是否发生非预期的相变强化。',
      '处置流程：先由工艺工程师出具调整方案，经值班作业长确认后执行，调整后连续跟踪三个轧制单位的产品性能并留档。',
    ],
  };
  const distractors = [
    { title: '转炉炼钢终点控制要点', chunks: ['终点碳含量按钢种要求控制在 0.04%~0.08%，终点温度命中率目标不低于 85%。', '氧枪流量与枪位需联动调整，避免喷溅与返干。'] },
    { title: '精炼炉合金加入顺序规范', chunks: ['脱氧合金化顺序为先强脱氧剂后弱脱氧剂，合金加入后需保证足够的软吹时间。', '喂丝速度与包芯线类型匹配，避免钢液裸露二次氧化。'] },
    { title: '热轧加热炉温度制度', chunks: ['均热段温度按钢种设定，总在炉时间不得超过上限，防止过热过烧。', '炉温均匀性偏差应控制在设定值 ±15 ℃ 以内。'] },
    { title: '成品力学性能取样与判定', chunks: ['每批产品按规定位置取样，拉伸与冲击试验结果须同时满足标准要求。', '复验规则与不合格判定流程按质量手册执行。'] },
    { title: '关键设备点检与润滑标准', chunks: ['点检按班次执行，重点部位包括减速机、轴承座与液压站。', '润滑周期与油品型号须与设备手册一致，换油需留记录。'] },
    { title: '生产安全事故应急处置预案', chunks: ['发生人身伤害时优先切断危险源并启动现场急救，同时上报值班调度。', '应急演练每季度至少组织一次并留存记录。'] },
  ];
  const cases = [
    { id: 'syn-q1', q: 'Q345B 的二冷水量应该设多少？', target: '连铸工艺参数调整规程', profile: '型号密集' },
    { id: 'syn-q2', q: 'HRB400E 的拉速上限是多少？', target: '连铸工艺参数调整规程', profile: '型号密集' },
    { id: 'syn-q3', q: '料太硬加工不动，炉子那边要怎么调？', target: '板形与力学性能异常处置规程', profile: '口语目标' },
    { id: 'syn-q4', q: '铸坯出来后变形抗性太大是哪儿的问题', target: '板形与力学性能异常处置规程', profile: '口语目标' },
    { id: 'syn-q5', q: '转炉终点的碳含量怎么控', target: '转炉炼钢终点控制要点', profile: '同域干扰' },
    { id: 'syn-q6', q: '合金什么时候加进去比较合适', target: '精炼炉合金加入顺序规范', profile: '同域干扰' },
    { id: 'syn-q7', q: '炉子温度均匀性偏差允许多少', target: '热轧加热炉温度制度', profile: '同域干扰' },
    { id: 'syn-q8', q: '冲击试验不合格怎么处理', target: '成品力学性能取样与判定', profile: '同域干扰' },
    { id: 'syn-q9', q: '减速机多久加一次油', target: '关键设备点检与润滑标准', profile: '同域干扰' },
    { id: 'syn-q10', q: '有人受伤了第一步做什么', target: '生产安全事故应急处置预案', profile: '同域干扰' },
  ];
  return { docs: [model, colloquial, ...distractors], cases };
})();

// ─────────────── v2：**含 hard negative**（40 切片，专门制造单路失效） ───────────────
// 关键设计：
//   ① 6 篇「牌号文档」标题只有牌号不同、正文措辞几乎一致 → KNN 看到的 6 条语义几乎相同，
//      而 BM25 靠牌号这个精确 token + 标题加权能直接命中 → **制造 KNN 的失效面**
//   ② 4 篇「口语目标文档」用书面语写、查询用口语 → 制造 BM25 的失效面
//   ③ 干扰文档扩到 10 篇，让 Top-5 成为真正的约束（不能再靠"总共就 4 篇"蒙中）

const V2 = (() => {
  /** ① 6 篇牌号文档：措辞模板几乎一致，只有牌号与数值不同 */
  const GRADES = [
    ['Q235B', 280, 1.30, 1.02],
    ['Q345B', 320, 1.10, 1.15],
    ['Q420', 310, 1.15, 1.12],
    ['Q460', 350, 1.00, 1.22],
    ['HRB400E', 300, 1.25, 1.05],
    ['HRB500E', 340, 1.05, 1.18],
  ];
  const gradeDocs = GRADES.map(([g, water, speed, ratio]) => ({
    title: `${g} 二冷水量与拉速设定`,
    chunks: [
      `牌号 ${g} 的板坯连铸参数：拉速基准 0.9 m/min 时，二次冷却水总量为 ${water} L/min，比水量按 ${ratio} L/kg 控制。`,
      `牌号 ${g} 的拉速上限为 ${speed} m/min；结晶器过热度控制在 15~25 ℃，过热度每升高 5 ℃ 拉速上限下调 0.05 m/min。`,
    ],
  }));

  /** ② 4 篇口语目标文档：书面语表述，与口语查询词面几乎不重叠 */
  const colloquialDocs = [
    { title: '轧件变形抗力异常处置规程', chunks: [
      '当轧件出现加工硬化倾向增强、变形抗力显著上升时，应核查加热制度与终轧温度是否偏低，必要时提高均热段温度并延长均热时间。',
      '处置流程：由工艺工程师出具调整方案，经值班作业长确认后执行，连续跟踪三个轧制单位的产品性能并留档。',
    ] },
    { title: '刀具异常磨损成因分析规范', chunks: [
      '若产品硬度超出交付要求，且后续机加工环节出现刀具异常磨损，需回溯化学成分与冷却路径，确认是否发生非预期的相变强化。',
      '分析结论须形成书面报告，并同步更新工艺卡与检验标准。',
    ] },
    { title: '连铸坯表面缺陷判定准则', chunks: [
      '铸坯表面纵向裂纹深度超过 2 mm 时判定为不合格，需切除或降级处理。',
      '裂纹成因需结合保护渣性能、结晶器振动参数与二冷制度综合分析。',
    ] },
    { title: '成品硬度超差追溯流程', chunks: [
      '硬度检测结果超出标准范围时，应启动追溯流程，核查热处理炉温记录与冷却介质状态。',
      '追溯结论应在三个工作日内反馈至质量管理部门。',
    ] },
  ];

  /** ③ 10 篇同域干扰文档 */
  const distractors = [
    { title: '转炉炼钢终点控制要点', chunks: ['终点碳含量按钢种要求控制在 0.04%~0.08%，终点温度命中率目标不低于 85%。', '氧枪流量与枪位需联动调整，避免喷溅与返干。'] },
    { title: '精炼炉合金加入顺序规范', chunks: ['脱氧合金化顺序为先强脱氧剂后弱脱氧剂，合金加入后需保证足够的软吹时间。', '喂丝速度与包芯线类型匹配，避免钢液裸露二次氧化。'] },
    { title: '热轧加热炉温度制度', chunks: ['均热段温度按钢种设定，总在炉时间不得超过上限，防止过热过烧。', '炉温均匀性偏差应控制在设定值 ±15 ℃ 以内。'] },
    { title: '成品力学性能取样与判定', chunks: ['每批产品按规定位置取样，拉伸与冲击试验结果须同时满足标准要求。', '复验规则与不合格判定流程按质量手册执行。'] },
    { title: '关键设备点检与润滑标准', chunks: ['点检按班次执行，重点部位包括减速机、轴承座与液压站。', '润滑周期与油品型号须与设备手册一致，换油需留记录。'] },
    { title: '生产安全事故应急处置预案', chunks: ['发生人身伤害时优先切断危险源并启动现场急救，同时上报值班调度。', '应急演练每季度至少组织一次并留存记录。'] },
    { title: '钢包周转与温度管理规范', chunks: ['钢包周转时间不得超过规定上限，否则须回炉补温。', '包衬侵蚀情况每班检查，超过允许厚度立即下线。'] },
    { title: '连铸保护渣选型指导', chunks: ['保护渣熔点与黏度需与钢种及拉速匹配，避免卷渣与粘结。', '更换保护渣型号须经工艺确认并试浇验证。'] },
    { title: '轧辊使用与磨削周期规定', chunks: ['轧辊按轧制量确定磨削周期，超期使用将影响板形精度。', '磨削后需检测辊形与硬度并记录归档。'] },
    { title: '成品入库与标识管理办法', chunks: ['成品入库前须完成标识核对，确保炉批号与质保书一致。', '标识不清的产品不得入库，须退回重新标识。'] },
  ];

  const cases = [
    // 型号画像：目标文档的标题/正文含精确牌号，但其余 5 篇牌号文档语义高度相似
    { id: 'syn2-g1', q: 'Q345B 的二冷水量设多少？', target: 'Q345B 二冷水量与拉速设定', profile: '型号密集' },
    { id: 'syn2-g2', q: 'Q460 的拉速上限是多少？', target: 'Q460 二冷水量与拉速设定', profile: '型号密集' },
    { id: 'syn2-g3', q: 'HRB500E 的比水量按多少控制？', target: 'HRB500E 二冷水量与拉速设定', profile: '型号密集' },
    { id: 'syn2-g4', q: 'Q235B 拉速基准下二冷水总量', target: 'Q235B 二冷水量与拉速设定', profile: '型号密集' },
    // 口语画像：查询口语化，目标文档全书面语
    { id: 'syn2-c1', q: '料太硬加工不动，炉子那边要怎么调？', target: '轧件变形抗力异常处置规程', profile: '口语目标' },
    { id: 'syn2-c2', q: '刀磨得太快了是不是材料有问题', target: '刀具异常磨损成因分析规范', profile: '口语目标' },
    { id: 'syn2-c3', q: '铸坯表面裂了多深算废', target: '连铸坯表面缺陷判定准则', profile: '口语目标' },
    { id: 'syn2-c4', q: '测出来硬度不对，该去查哪儿', target: '成品硬度超差追溯流程', profile: '口语目标' },
    // 干扰画像
    { id: 'syn2-d1', q: '转炉终点碳含量怎么控', target: '转炉炼钢终点控制要点', profile: '同域干扰' },
    { id: 'syn2-d2', q: '合金什么时候加比较合适', target: '精炼炉合金加入顺序规范', profile: '同域干扰' },
    { id: 'syn2-d3', q: '钢包周转时间有上限吗', target: '钢包周转与温度管理规范', profile: '同域干扰' },
    { id: 'syn2-d4', q: '保护渣怎么选型', target: '连铸保护渣选型指导', profile: '同域干扰' },
  ];

  return { docs: [...gradeDocs, ...colloquialDocs, ...distractors], cases };
})();

/** 语料集选择：RECALL_SYNTH_SET=v1|v2（默认 v2，因为 v1 无 hard negative） */
const SET_NAME = process.env.RECALL_SYNTH_SET ?? 'v2';
const SET = SET_NAME === 'v1' ? V1 : V2;
const SYNTH_CASES = SET.cases;


// ─────────────────────────── 工具 ───────────────────────────

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (v, d = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

async function embed(text) {
  const res = await fetch(`${EMB_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: EMB_MODEL, input: text, dimensions: 1024 }),
  });
  if (!res.ok) throw new Error(`embedding ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const v = (await res.json())?.data?.[0]?.embedding;
  if (!Array.isArray(v)) throw new Error('embedding 响应缺少向量');
  return v;
}

async function es(path, method = 'GET', body) {
  const res = await fetch(`${ES}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ES ${res.status} ${path}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** 与生产同构的 RRF */
function rrfFuse(lists, k = RRF_K) {
  const map = new Map();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const key = `${hit.doc_id}|${hit.chunk_index}`;
      const add = 1 / (k + i + 1);
      const ex = map.get(key);
      if (ex) ex.rrfScore += add; else map.set(key, { ...hit, rrfScore: add });
    });
  }
  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

/** min-max 归一化后加权求和（与「加权求和」候选臂同构） */
function weightedFuse(lists, weights) {
  const map = new Map();
  lists.forEach((list, li) => {
    if (!list.length) return;
    const scores = list.map((h) => h.score ?? 0);
    const min = Math.min(...scores), max = Math.max(...scores), span = max - min;
    list.forEach((hit) => {
      const norm = span > 0 ? ((hit.score ?? 0) - min) / span : 1;
      const key = `${hit.doc_id}|${hit.chunk_index}`;
      const add = norm * (weights[li] ?? 0);
      const ex = map.get(key);
      if (ex) ex.weighted += add; else map.set(key, { ...hit, weighted: add });
    });
  });
  return [...map.values()].sort((a, b) => b.weighted - a.weighted);
}

function metrics(expectedTitle, titles) {
  const topK = titles.slice(0, K);
  const hits = topK.filter((t) => t === expectedTitle);
  const idx = topK.indexOf(expectedTitle);
  return {
    recall_at_k: hits.length > 0 ? 1 : 0,   // 单篇 ground truth
    precision_at_k: hits.length / K,
    mrr: idx >= 0 ? 1 / (idx + 1) : 0,
    hit_at_k: hits.length > 0 ? 1 : 0,
    first_hit_rank: idx >= 0 ? idx + 1 : null,
  };
}

function toHits(resp) {
  return (resp.hits?.hits ?? []).map((h) => {
    const s = h._source ?? {};
    return { doc_id: s.doc_id ?? '', doc_title: s.doc_title ?? '', chunk_index: s.chunk_index ?? 0, content: s.content ?? '', score: h._score ?? 0 };
  });
}

const bm25 = (q) => es(`/${INDEX}/_search`, 'POST', {
  size: RECALL_SIZE,
  query: { multi_match: { query: q, fields: ['doc_title^2', 'content'] } },
  _source: SOURCE,
});

const knn = (vec) => es(`/${INDEX}/_search`, 'POST', {
  size: RECALL_SIZE,
  knn: { field: 'embedding', query_vector: vec, k: RECALL_SIZE, num_candidates: Math.max(RECALL_SIZE * 2, 100) },
  _source: SOURCE,
});

// ─────────────────────────── 语料播种 / 清理 ───────────────────────────

async function clean() {
  const r = await es(`/${INDEX}/_delete_by_query?refresh=true`, 'POST', {
    query: { prefix: { doc_id: PREFIX } },
  });
  return r.deleted ?? 0;
}

async function seed() {
  const docs = SET.docs;
  let n = 0;
  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di];
    const docId = `${PREFIX}${String(di + 1).padStart(2, '0')}`;
    for (let ci = 0; ci < doc.chunks.length; ci++) {
      const content = doc.chunks[ci];
      const vec = await embed(`${doc.title}\n${content}`);
      await es(`/${INDEX}/_doc/${docId}-${ci}?refresh=false`, 'PUT', {
        doc_id: docId,
        doc_title: doc.title,
        chunk_index: ci,
        content,
        embedding: vec,
        created_at: new Date().toISOString(),
        status: 1,
        is_public: true,
        author_id: '',
        team_id: '',
      });
      n++;
    }
  }
  await es(`/${INDEX}/_refresh`, 'POST').catch(() => {});
  return n;
}

// ─────────────────────────── 主流程 ───────────────────────────

const ARMS = ['bm25_only', 'knn_only', 'dual_rrf', 'dual_weighted'];

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--clean')) {
    console.log(`已删除 ${await clean()} 个 synth 切片`);
    return;
  }
  if (!EMB_URL || !API_KEY) throw new Error('缺少 EMBEDDING_BASE_URL / OPENAI_API_KEY');

  const existing = await clean();   // 先清理残留，保证幂等
  if (existing) console.log(`清理了 ${existing} 个残留 synth 切片`);

  console.log('播种合成语料…');
  const seeded = await seed();
  const total = (await es(`/${INDEX}/_count`)).count;
  console.log(`已写入 ${seeded} 个 synth 切片；kh_chunk 共 ${total} 个切片\n`);

  const per = Object.fromEntries(ARMS.map((a) => [a, { m: [], took: [] }]));
  const rows = [];

  for (const c of SYNTH_CASES) {
    const [vec, bRes] = await Promise.all([embed(c.q), bm25(c.q)]);
    const kRes = await knn(vec);
    const b = toHits(bRes), k = toHits(kRes);
    const arms = {
      bm25_only: b,
      knn_only: k,
      dual_rrf: rrfFuse([k, b]),
      dual_weighted: weightedFuse([b, k], [0.5, 0.5]),
    };
    const row = { ...c, arm: {} };
    for (const a of ARMS) {
      const ordered = arms[a].slice(0, K);
      const titles = ordered.map((h) => h.doc_title);
      const m = metrics(c.target, titles);
      per[a].m.push(m);
      per[a].took.push(a === 'knn_only' ? kRes.took : bRes.took);
      row.arm[a] = { ...m, top1: titles[0] ?? '（空）' };
    }
    rows.push(row);
    console.log(
      `${c.id} [${c.profile}]  命中位次  bm25=${row.arm.bm25_only.first_hit_rank ?? '—'}` +
        `  knn=${row.arm.knn_only.first_hit_rank ?? '—'}` +
        `  rrf=${row.arm.dual_rrf.first_hit_rank ?? '—'}` +
        `  weighted=${row.arm.dual_weighted.first_hit_rank ?? '—'}`,
    );
  }

  const summary = ARMS.map((a) => ({
    arm: a,
    recall_at_k: mean(per[a].m.map((x) => x.recall_at_k)),
    precision_at_k: mean(per[a].m.map((x) => x.precision_at_k)),
    mrr: mean(per[a].m.map((x) => x.mrr)),
    hit_at_k: mean(per[a].m.map((x) => x.hit_at_k)),
    took_ms_mean: mean(per[a].took),
  }));

  const L = [];
  L.push(`# 单路召回消融 · 合成语料 ${SET_NAME}（K=${K}，用例 ${SYNTH_CASES.length} 条，synth 切片 ${seeded} 个）\n`);
  L.push(`> ⚠️ **这是合成语料**（集合 \`${SET_NAME}\`）。生产环境只有 34 个切片 / 4 篇同质文档，四臂全部满分、无判别力，`);
  L.push('> 因此构造受控语料用于暴露**双路价值的边界条件**。**结论不能当作生产质量结论。**\n');
  L.push('> `v2` 集合含 **hard negative**：6 篇「牌号文档」标题只差牌号、正文措辞几乎一致（考验 KNN）；');
  L.push('> 4 篇「口语目标文档」全用书面语（考验 BM25）；干扰文档 10 篇让 Top-5 成为真实约束。\n');
  L.push('> 口径：直连 ES，不含 rerank / 意图路由 / 生成；DSL 与 RRF 复制自生产代码；');
  L.push('> 语料由 `recall-ablation-synth.mjs` 确定性生成，**可复现**；跑完自动清理。\n');
  L.push(`| 臂 | Recall@${K} | Precision@${K} | MRR | Hit@${K} | ES took 均值 ms |`);
  L.push('| :--- | :-: | :-: | :-: | :-: | :-: |');
  for (const s of summary) {
    L.push(`| ${s.arm} | ${fmt(s.recall_at_k)} | ${fmt(s.precision_at_k)} | ${fmt(s.mrr)} | ${fmt(s.hit_at_k)} | ${fmt(s.took_ms_mean, 1)} |`);
  }
  L.push('\n**逐用例首条命中位次**（— = Top-5 全未命中）\n');
  L.push('| 用例 | 画像 | 期望文档 | 纯 BM25 | 纯 KNN | 双路 RRF | 加权求和 |');
  L.push('| :--- | :--- | :--- | :-: | :-: | :-: | :-: |');
  for (const r of rows) {
    L.push(`| ${r.id} | ${r.profile} | ${r.target} | ${r.arm.bm25_only.first_hit_rank ?? '—'} | ${r.arm.knn_only.first_hit_rank ?? '—'} | ${r.arm.dual_rrf.first_hit_rank ?? '—'} | ${r.arm.dual_weighted.first_hit_rank ?? '—'} |`);
  }
  const out = L.join('\n');
  console.log('\n' + out + '\n');

  // 结构性统计
  const knnOnly = rows.filter((r) => !r.arm.knn_only.first_hit_rank);
  const bm25Only = rows.filter((r) => !r.arm.bm25_only.first_hit_rank);
  console.log(`纯 KNN 未命中：${knnOnly.length} 条（${knnOnly.map((r) => r.id).join(', ') || '无'}）`);
  console.log(`纯 BM25 未命中：${bm25Only.length} 条（${bm25Only.map((r) => r.id).join(', ') || '无'}）`);
  console.log(`型号密集画像下 KNN 未命中：${rows.filter((r) => r.profile === '型号密集' && !r.arm.knn_only.first_hit_rank).length}/${rows.filter((r) => r.profile === '型号密集').length}`);
  console.log(`口语画像下 BM25 未命中：${rows.filter((r) => r.profile === '口语目标' && !r.arm.bm25_only.first_hit_rank).length}/${rows.filter((r) => r.profile === '口语目标').length}`);

  if (process.env.RECALL_SYNTH_OUT) {
    writeFileSync(process.env.RECALL_SYNTH_OUT, out, 'utf8');
    console.log(`\n已写入 ${process.env.RECALL_SYNTH_OUT}`);
  }

  if (!args.includes('--keep')) {
    console.log(`\n清理合成语料：删除 ${await clean()} 个 synth 切片`);
    console.log(`清理后 kh_chunk = ${(await es(`/${INDEX}/_count`)).count}（应恢复到播种前的 ${total - seeded}）`);
  } else {
    console.log('\n--keep：保留合成语料，记得之后执行 --clean');
  }
}

main().catch(async (err) => {
  console.error(`运行失败：${msg(err)}`);
  try { console.log(`清理 ${await clean()} 个 synth 切片`); } catch { /* ignore */ }
  process.exit(1);
});
