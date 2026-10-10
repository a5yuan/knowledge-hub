/**
 * 演示视频旁白讲稿（结构化）
 *
 * 结构说明：
 * - card     : 章节卡（2.4s）期间念的台词，会单独合成为一段
 * - blocks   : 正文期间的台词块。每块 = 一条字幕 = 一次 TTS 调用
 * - 块间静音 : 由 narrate.mjs 统一插入（默认 0.4s），念稿时不需要写停顿符
 *
 * 写作约束（与画面时长挂钩，勿随意改动）：
 * - 语速基准 5.5 字/秒（Kai 音色实测口径），块间停顿另计
 * - 每块长度控制在 10~34 字：过短会让字幕频繁闪动，过长一行放不下
 * - 各章正文台词总时长须落在该章画面时长 ±10% 内，否则 atempo 变速会被听出来
 *   可用 `node narrate.mjs --check` 校验
 * - 禁止出现下划线标识符（web_search / retrieve_knowledge 等）：TTS 会读错，
 *   一律改写成自然语言；技术名词（NestJS / MinerU / RRF / Elasticsearch）保留
 * - 禁止破折号「——」：会被读成「破折号」，改用逗号或句号
 */

export const VOICE = 'Kai';
export const MODEL = 'qwen3-tts-instruct-flash';
export const INSTRUCTION =
  '以专业冷静的科技解说语气朗读，语速中等偏快，句读清晰，避免夸张起伏，像向面试官介绍自己的作品。';

/** 每章画面正文时长（秒），来自 out/webm 实测，用于校验台词是否放得下 */
export const BODY_DUR = {
  ch1: 7.32,
  ch2: 47.32,
  ch3: 26.32,
  ch4: 38.4,
  ch5: 51.6,
  ch6: 20.24,
};

/** 章节卡时长（秒），与 build-video.mjs 的 CARD_SEC 保持一致 */
export const CARD_SEC = 2.4;

export const NARRATION = [
  {
    id: 'ch1',
    no: 1,
    title: '项目启动过程',
    card: '第一章，项目启动过程。',
    blocks: [
      '启动顺序固定：九个容器，然后是 NestJS 后端和前端。',
      '就绪探针全过，服务才可用。',
    ],
  },
  {
    id: 'ch2',
    no: 2,
    title: '知识库构建',
    card: '第二章，知识库构建。',
    blocks: [
      '登录进入控制台。这份文档要过四道关，才能变成可检索的知识。',
      '先上传这份钢铁行业的实施指南。',
      '上传时要指定分类和可见范围。',
      '可见范围决定谁能检索到它，这是权限的源头。',
      '上传完成后，MinerU 开始解析。',
      '它不只是抽文字，而是把 PDF 版面还原成结构，表格和层级标题都保留下来。',
      '解析状态会在列表里实时刷新。',
      '解析完成，提交审核。',
      '审核通过这一刻，文档才真正写进向量库、Elasticsearch 和图谱。',
      '状态变成已发布。上传和审核是分离的，只有审核通过才触发入库。',
      '所以脏数据进不了检索链路。',
    ],
  },
  {
    id: 'ch3',
    no: 3,
    title: '场景一 · 纯知识库检索',
    card: '第三章，纯知识库检索。',
    blocks: [
      '第一个场景是纯知识库检索。',
      '问关键工序数控化率要达到多少，答案只可能来自刚入库的指南。',
      '提问后先判意图。这轮判成 knowledge，只挂检索，不开联网。',
      '检索走混合通道：关键词召回和向量召回并行，RRF 融合排名，再过一遍重排模型。',
      '答案里每个数字都带出处，往下滚能看到引用原文。',
    ],
  },
  {
    id: 'ch4',
    no: 4,
    title: '场景二 · 联网搜索',
    card: '第四章，联网搜索。',
    blocks: [
      '第二个场景是联网搜索。',
      '问的是 2026 年最新政策。这类时效信息不在企业文档里，文档只是过去时点的快照。',
      '这轮意图判成 web，工具白名单里只有联网搜索，检索工具被摘掉了。',
      '这里踩过一个坑。既然不检索知识库，模型就没有知识库不足的直接证据，',
      '反而会编出“知识库中未检索到”这种没根据的结论。',
      '所以每轮系统提示里都会注入路由指令，明确告诉它这轮该不该用工具。',
      '搜到五条结果，回答里逐条标了来源，可以点开核对。',
    ],
  },
  {
    id: 'ch5',
    no: 5,
    title: '场景三 · 知识库不足自动联网',
    card: '第五章，自动联网补充。',
    blocks: [
      '第三个场景是这套 Agent 最核心的一条路径。',
      '问题一半在知识库内、一半在知识库外：指南里的重点任务查得到，工信部的配套政策查不到。',
      '意图判成先知识库、不足再联网这一类。',
      '这类问题的处理是串行的。先拿预检索结果回答能回答的部分，',
      '发现覆盖不足，再调用检索工具换词补检。',
      '补检还是不够，才升级到联网。',
      '这个串行顺序是有意设计的，不是一步到位并发两路。',
      '联网有成本也有延迟，能靠内部知识库解决的部分，就不该花掉这一次调用。',
      '整条链路的预算被代码锁死：最多四轮工具调用、五轮迭代，每一类工具每轮只能调一次。',
      '最终答案把内部指南和外部政策拼在一起，来源分开标注。',
    ],
  },
  {
    id: 'ch6',
    no: 6,
    title: '场景四 · 其他情形（闲聊）',
    card: '第六章，其他情形。',
    blocks: [
      '最后是闲聊场景。这类提问判成 chitchat。',
      '它不挂任何工具，直接作答。',
      '不做意图分流的话，一句自我介绍也会触发检索，白花一次调用。',
      '分流的价值就在这里：让该花成本的问题花成本，不该花的省下来。',
      '演示到此结束。',
    ],
  },
];

/** 统计各章台词字数与预估时长，用于人工校验（`node narrate.mjs --check`） */
export function planReport() {
  const SPEED = 5.5; // 字/秒
  const GAP = 0.4; // 块间静音
  return NARRATION.map((ch) => {
    const chars = ch.blocks.join('').replace(/[\s，。、：；！？“……（）]/g, '').length;
    const full = ch.blocks.join('').length;
    const est = ch.blocks.reduce((a, b) => a + b.length / SPEED, 0)
      + (ch.blocks.length - 1) * GAP;
    const cardEst = ch.card.length / SPEED;
    const target = BODY_DUR[ch.id];
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
      // 正数 = 章节卡台词说完后还剩多少秒余量；负数 = 超出，需要缩短台词
      cardSlack: Number((CARD_SEC - cardEst - 0.35).toFixed(2)),
    };
  });
}
