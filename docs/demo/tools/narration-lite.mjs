/**
 * 精简版（<=120s）演示视频旁白讲稿（结构化）
 *
 * 与完整版的差异：
 * - 章节卡从 2.4s 压到 1.2s：卡上台词只能留「第N章。」四个字，标题交给画面
 *   （1.2s 里还要留 0.35s 尾巴，超过 5 个字就会被 atempo 压得听出加速感）
 * - 正文只保留每章的主干论点，删掉过程性描述；技术名词保留
 * - 正文画面时长来自 build-lite.mjs 产出的 out/lite/segments.json（ffmpeg 实测值）
 *
 * 用法：node narrate.mjs --lite --check    （预算校验）
 */

import { readFileSync, existsSync } from 'node:fs';

export const VOICE = 'Kai';
export const MODEL = 'qwen3-tts-instruct-flash';
export const INSTRUCTION =
  '以专业冷静的科技解说语气朗读，语速中等偏快，句读清晰，避免夸张起伏，像向面试官介绍自己的作品。';

/** 兜底正文时长（build-lite 预算值）；实际以 out/lite/segments.json 为准 */
const FALLBACK_BODY = { ch1: 7.32, ch2: 29.28, ch3: 17.04, ch4: 20.08, ch5: 24.44, ch6: 12.96 };

const SEG = new URL('./out/lite/segments.json', import.meta.url);
export const BODY_DUR = existsSync(SEG)
  ? Object.fromEntries(JSON.parse(readFileSync(SEG, 'utf8')).map((s) => [s.id, s.body]))
  : { ...FALLBACK_BODY };

/** 章节卡时长（秒），与 build-lite.mjs 的 CARD_SEC 保持一致 */
export const CARD_SEC = 1.2;

export const NARRATION = [
  {
    id: 'ch1',
    no: 1,
    title: '项目启动过程',
    card: '第一章。',
    blocks: [
      '启动顺序固定：九个容器，然后是后端和前端。',
      '就绪探针全过，服务才对外可用。',
    ],
  },
  {
    id: 'ch2',
    no: 2,
    title: '知识库构建',
    card: '第二章。',
    blocks: [
      '登录控制台，文档要过四道关，才能变成可检索的知识。',
      '先上传这份钢铁行业的实施指南。',
      '上传要指定分类和可见范围，可见范围决定谁能检索到它。',
      '上传完成后，MinerU 开始解析。',
      '它不光抽文字，还把 PDF 版面还原成结构，表格和标题都保留。',
      '解析完成，提交审核。审核通过，才真正写进向量库和 Elasticsearch。',
    ],
  },
  {
    id: 'ch3',
    no: 3,
    title: '场景一 · 纯知识库检索',
    card: '第三章。',
    blocks: [
      '纯知识库检索场景。',
      '问关键工序数控化率要达到多少，答案只在刚入库的指南里。',
      '这轮判成知识库检索，只挂检索，不开联网。',
      '关键词召回和向量召回并行，RRF 融合排名，再过一遍重排模型。',
    ],
  },
  {
    id: 'ch4',
    no: 4,
    title: '场景二 · 联网搜索',
    card: '第四章。',
    blocks: [
      '第二个场景，联网搜索。',
      '问的是最新政策，这类信息不在企业文档里，文档只是过去时点的快照。',
      '这轮判成联网，工具白名单里只剩搜索，检索工具被摘掉了。',
      '踩过一个坑：不检索知识库，模型没有不足的证据，反而会编出没根据的结论。',
    ],
  },
  {
    id: 'ch5',
    no: 5,
    title: '场景三 · 知识库不足自动联网',
    card: '第五章。',
    blocks: [
      '第三个场景，是这套 Agent 最核心的一条路径。',
      '问题一半在库内、一半在库外：指南里的重点任务查得到，配套政策查不到。',
      '先拿预检索结果答能答的部分，不足再换词补检，还不够才升级联网。',
      '这个串行顺序是有意设计的，联网有成本有延迟，能内部解决就不该花。',
    ],
  },
  {
    id: 'ch6',
    no: 6,
    title: '场景四 · 其他情形（闲聊）',
    card: '第六章。',
    blocks: [
      '最后是闲聊场景。',
      '它不挂工具，直接作答。不做分流的话，一句自我介绍也会触发检索。',
      '分流的价值就在这里：该花的才花，不该花的省下来。',
    ],
  },
];

/** 统计各章台词字数与预估时长，用于人工校验（`node narrate.mjs --lite --check`） */
export function planReport(bodyDur = BODY_DUR, cardSec = CARD_SEC) {
  const SPEED = 5.5; // 字/秒
  const GAP = 0.4; // 块间静音
  return NARRATION.map((ch) => {
    const chars = ch.blocks.join('').replace(/[\s，。、：；！？“……（）]/g, '').length;
    const full = ch.blocks.join('').length;
    const est = ch.blocks.reduce((a, b) => a + b.length / SPEED, 0) + (ch.blocks.length - 1) * GAP;
    const cardEst = ch.card.length / SPEED;
    const target = bodyDur[ch.id];
    return {
      id: ch.id,
      title: ch.title,
      blocks: ch.blocks.length,
      chars,
      full,
      est: Number(est.toFixed(2)),
      target,
      ratio: Number((est / target).toFixed(3)),
      cardLen: ch.card.length,
      cardEst: Number(cardEst.toFixed(2)),
      cardSlack: Number((cardSec - cardEst - 0.35).toFixed(2)),
    };
  });
}
