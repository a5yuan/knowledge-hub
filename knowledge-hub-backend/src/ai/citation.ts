/**
 * 引用标记处理（工单 24 P0）。
 *
 * 抽成纯函数而不是留在 `ai-agent.service.ts` 里当私有方法：
 * ① 这两个逻辑是「字符串进、字符串/数组出」，没有依赖，单测成本极低；
 * ② 编排层已经 1300 行，能搬出去的就搬 —— 与 23 号工单把工具实现下沉到 `ai/tools/` 同一思路。
 */

/**
 * 剥掉文本里的引用标记（`[n]` 与 web 的 `[Wn]`）。
 *
 * 只用于**注入历史**：编号是「本轮」的全局序号，跨轮没有意义。
 * 上一轮的 `[3]` 被模型当成这一轮可用的编号，是「只有 1 条来源却写 [3]」这类越界引用的来源之一。
 */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\[W\d{1,2}\]/gi, '').replace(/\[\d{1,3}\]/g, '');
}

/**
 * 找出答案里越界的引用编号（引了 `[n]`，但本轮只有 total 条来源）。
 *
 * 纯检测，不改正文：流式文本已经发给用户了，事后改会造成「看到过 [3]、刷新后没了」的不一致。
 * 越界编号随 `finish` 事件下发并记 warn 日志，让问题可统计；
 * 治本靠「prompt 明确禁止编造」+「注入历史时剥离旧编号」。
 *
 * 注：web 的 `[Wn]` 走局部编号映射，不在此列。
 */
export function findInvalidCitations(answer: string, total: number): number[] {
  if (!answer) return [];
  const bad = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > total) bad.add(n);
  }
  return [...bad].sort((a, b) => a - b);
}

/**
 * 流式引用过滤器：**在下发前**把越界编号丢掉。
 *
 * 为什么必须在流里做，不能等答案生成完再改：
 * 文本是逐 delta 推给前端的，生成完再改只能改落库内容 ——
 * 用户已经看到 `[3]`，刷新后又没了，比留个错号更糟。
 *
 * 判定与 `findInvalidCitations` 一致：只处理 `[n]`；`[Wn]`、`[备注]` 这类原样放行。
 * 编号可能被拆在两个 chunk 里（`"["` + `"3]"`），所以要缓冲到能判定为止；
 * 缓冲有上限（`MAX_PENDING`），避免遇到孤立的 `[` 把后续文本全卡住。
 */
export class CitationStreamFilter {
  /** 等待判定的尾部（可能以 `[` 开头且尚未闭合） */
  private pending = '';

  /** 兜底上限：超过这个长度还没凑成标记，就按普通文本放行 */
  private static readonly MAX_PENDING = 6;

  /**
   * 被丢掉的越界编号个数。
   *
   * 为什么必须计数：过滤器把编号吞掉之后，`findInvalidCitations` 永远看不到越界，
   * 「编号有效性 100%」就无法区分「模型没编」和「编了但被兜底吃掉」。
   * 这两个事实对产品意义完全不同 —— 前者是好事，后者说明 prompt 仍没守住。
   */
  private dropped = 0;

  get droppedCount(): number {
    return this.dropped;
  }

  constructor(private readonly validMax: () => number) {}

  /**
   * 喂入一个 delta，返回可以安全下发的文本（可能是空串）。
   * `validMax` 每次判定时实时读取 —— 工具调用会不断登记新来源。
   */
  push(chunk: string): string {
    if (!chunk) return '';
    this.pending += chunk;
    let out = '';

    while (this.pending.length > 0) {
      const at = this.pending.indexOf('[');
      if (at < 0) {
        out += this.pending;
        this.pending = '';
        break;
      }
      out += this.pending.slice(0, at);
      const rest = this.pending.slice(at);

      const numeric = /^\[(\d{1,3})\]/.exec(rest);
      if (numeric) {
        const n = Number(numeric[1]);
        // 合法编号保留，越界丢弃（只丢标记，正文一个字不动）
        if (n >= 1 && n <= this.validMax()) out += numeric[0];
        else this.dropped += 1;
        this.pending = rest.slice(numeric[0].length);
        continue;
      }

      // 可能是还没收完的 `[12`：长度可控就再等一个 chunk
      if (rest.length <= CitationStreamFilter.MAX_PENDING && /^\[\d{0,3}$/.test(rest)) {
        this.pending = rest;
        return out;
      }

      // 其它方括号（[备注]、[W1]、[1,2]…）原样放行
      out += '[';
      this.pending = rest.slice(1);
    }
    return out;
  }

  /** 流结束时把残留吐出来（可能是一个永远没闭合的 `[`） */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }
}
