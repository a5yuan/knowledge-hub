/**
 * 评测公共层 —— 请求与事实归纳（工单 24 §设计·公共层职责）。
 *
 * 口径必须与 `agent-trace.mjs` 完全一致，否则跨脚本数字不可比。
 * 本文件只做「搬运 + 统一」，不改变任何解析语义。
 *
 * 唯一新增：`preflight()` —— 环境体检。工单原文没写，但 2026-10-20 实测踩过：
 * `qwen-turbo` 429 时 `planIntent` 走 fallback，五类输入全判 `knowledge`，
 * 此时跑出来的意图/工具准确率是假的，而报告看不出来。所以跑 suite 前必须先体检。
 */
import 'dotenv/config';

export const BASE = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const USERNAME = process.env.EVAL_USERNAME ?? 'admin';
const PASSWORD = process.env.EVAL_PASSWORD ?? '';

/** 预算上限（源码 src/ai/tool-denial.ts 的 TOOL_BUDGET_LIMITS） */
export const TOOL_BUDGET_LIMITS = {
  total: 4,
  rewrite: 1,
  web: 1,
  graph: 1,
};
export const MAX_ITERATIONS = 5;

const msg = (err) => (err instanceof Error ? err.message : String(err));

/**
 * 评测用采样温度（工单 24 补）。
 *
 * 默认不传 → 后端按 0.3 走；设 `EVAL_TEMPERATURE=0` 则逐请求传 0。
 * 为什么要这个：同一问题两次跑出相反结论（意图、工具选择），
 * 在 0.3 下 50 条样本的有效精度远低于名义值。可复现是评测的前置条件。
 */
export const EVAL_TEMPERATURE =
  process.env.EVAL_TEMPERATURE === undefined
    ? undefined
    : Number(process.env.EVAL_TEMPERATURE);

/** 登录拿 access token（缺密码直接抛，避免拿空密码去试） */
export async function login(base = BASE) {
  if (!PASSWORD) {
    throw new Error(
      '缺少 EVAL_PASSWORD：请 `EVAL_PASSWORD=xxx node test/eval/run-all.mjs`，或在 .env 中配置',
    );
  }
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  const data = await res.json();
  if (!data.accessToken) throw new Error('登录响应缺少 accessToken');
  return data.accessToken;
}

/**
 * 打一次 SSE 对话，返回事件数组 + 时间锚点。
 *
 * 时间锚点三件套（工单 24 要求 s07 必须分开两个 TTFT 口径）：
 * - `ttft_event_ms`：首个任意事件（thinking 模式下通常是 reasoning-start）
 * - `ttft_text_ms`：首个 text-delta（用户真正看到字）
 * - `wall_ms`：整轮结束
 */
export async function sseStream(token, { content, sessionId, temperature }, base = BASE) {
  const t0 = Date.now();
  const res = await fetch(`${base}/ai/sessions/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      content,
      ...(sessionId ? { sessionId } : {}),
      // 未显式传时后端用默认 0.3；评测要可复现就传 0（EVAL_TEMPERATURE=0）
      ...(typeof temperature === 'number' ? { temperature } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SSE HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const events = [];
  let firstByteMs = null;
  let ttftEventMs = null;
  let ttftTextMs = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === null) firstByteMs = Date.now() - t0;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let evt;
        try {
          evt = JSON.parse(line.slice(6));
        } catch {
          continue; // 忽略非 JSON 片段
        }
        if (ttftEventMs === null) ttftEventMs = Date.now() - t0;
        if (ttftTextMs === null && evt.type === 'text-delta') {
          ttftTextMs = Date.now() - t0;
        }
        events.push(evt);
      }
    }
  }

  return {
    events,
    wall_ms: Date.now() - t0,
    first_byte_ms: firstByteMs,
    ttft_event_ms: ttftEventMs,
    ttft_text_ms: ttftTextMs,
  };
}

/** 把一轮事件流还原成结构化事实（与 agent-trace.mjs 同口径） */
export function summarizeTurn(events, wallMs) {
  const pick = (type) => events.filter((e) => e.type === type);
  const plan = pick('data-plan').at(-1)?.data ?? null;
  const session = pick('data-session').at(-1)?.data?.sessionId ?? null;

  const retrieves = pick('data-retrieve');
  const graphs = pick('data-graph');
  const webs = pick('data-web-search');
  // rewrite_query 无独立 data-* 事件，用 data-status 的 stage 判定
  const rewriteStages = pick('data-status').filter(
    (e) => e.data?.stage === 'rewrite',
  );
  /**
   * 工单 24 P0：代调检索（预检索为空时由代码补一次）。
   * 它不发 tool_call，只看 `tools.retrieve_knowledge` 会误判成「本轮没检索」——
   * 所以后端会额外发一条 `data-status{stage:'retrieve', forced:true}`。
   */
  const forcedRetrieve = pick('data-status').some(
    (e) => e.data?.stage === 'retrieve' && e.data?.forced === true,
  );

  const steps = pick('start-step')
    .map((e) => e.data?.step)
    .filter(Boolean);
  const answer = pick('text-delta')
    .map((e) => e.data?.delta ?? '')
    .join('');
  const sources = pick('data-sources').at(-1)?.data ?? null;
  const errors = pick('error').map((e) => e.data);

  const toolCalls =
    retrieves.length + graphs.length + webs.length + rewriteStages.length;

  return {
    session_id: session,
    intent: plan?.intent ?? null,
    suggested_terms: plan?.suggestedTerms ?? [],
    steps: steps.length,
    step_seq: steps,
    tool_calls: toolCalls,
    tools: {
      retrieve_knowledge: retrieves.length,
      retrieve_graph: graphs.length,
      web_search: webs.length,
      rewrite_query: rewriteStages.length,
    },
    /** 本轮是否发生过「代码代调的检索」（工单 24 P0）：模型没发 tool_call，但确实查了库 */
    forced_retrieve: forcedRetrieve,
    /**
     * 只统计**知识库类**来源。
     * `sources_count` 含 web / graph，用它判「有没有查知识库」会把「查了网页」误算成「查了库」——
     * 2026-10-22 踩过：加上 sources_count>0 后，10 条 web 用例全被判成「多余检索」，行为一致率掉到 80%。
     */
    kb_sources_count: (Array.isArray(sources?.sources) ? sources.sources : []).filter(
      (x) => x?.kind === 'knowledge',
    ).length,
    /**
     * 预算是否触顶。
     * ⚠️ 这是**间接**判定：SSE 只下发成功执行的工具事件，被拒绝的 ToolMessage 不进事件流，
     * 所以「模型尝试了 5 次、第 5 次被拒」在客户端看来就是 tool_calls = 4。
     * 真要观察拒绝，需要 Langfuse 或 22 号工单的 tool_denial 落到 SSE（尚未实现）。
     */
    budget_exhausted: toolCalls >= TOOL_BUDGET_LIMITS.total,
    answer,
    answer_len: answer.length,
    empty_answer:
      answer.trim().length === 0 || answer.includes('本次回答未生成内容'),
    retrieved_docs: [
      ...new Set(
        retrieves.flatMap((e) => (e.data?.items ?? []).map((i) => i.documentTitle)),
      ),
    ],
    graph: graphs.map((e) => ({
      query: e.data?.query,
      entities: (e.data?.entities ?? []).map((x) => x.name),
      relations: (e.data?.relations ?? []).map(
        (r) => `${r.source} -${r.relation}-> ${r.target}`,
      ),
    })),
    web: webs.flatMap((e) => (e.data?.results ?? []).map((r) => r.title)),
    sources_count: Array.isArray(sources?.sources) ? sources.sources.length : 0,
    sources: sources?.sources ?? [],
    errors,
    wall_ms: wallMs,
  };
}

/** GET 封装（幂等 / 降级断言用） */
export async function apiGet(token, path, base = BASE) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

/** POST 封装 */
export async function apiPost(token, path, body, base = BASE) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

/**
 * rerank 端点健康探针（工单 24 补，2026-10-21 实测踩到）。
 *
 * 为什么单独探：DashScope rerank 免费额度耗尽时返回 **403 `AllocationQuota.FreeTierOnly`**，
 * `RerankService` 只 warn 一句就降级为 RRF —— 对话照常返回 200、答案非空，
 * **任何只看对话结果的探针都发现不了**。此时检索质量（s01/s05 的引用口径）已经悄悄变了。
 *
 * 返回 `{ ok, status, detail }`；ok=false 时调用方必须把它写进报告 caveat，不能只打一行日志。
 */
export async function probeRerank() {
  const url =
    process.env.RERANK_API_URL ??
    'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
  const model = process.env.RERANK_MODEL ?? 'qwen3.7-text-rerank';
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, status: 0, detail: '缺 OPENAI_API_KEY' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        input: { query: '高炉炼铁', documents: ['高炉炼铁是把铁矿石还原成铁水'] },
        parameters: { return_documents: false, top_n: 1 },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, model, detail: body.slice(0, 240) };
  } catch (err) {
    return { ok: false, status: 0, model, detail: msg(err) };
  }
}

/**
 * 环境体检（本工单新增，工单原文未提及）。
 *
 * 为什么必须有：意图路由 / 切题评估 / Mem0 抽取共用 `MEMORY_LLM_MODEL`
 * （默认 qwen-turbo）。一旦限流，`planIntent` 走 fallback，**所有输入都判 knowledge**，
 * 此时 s03/s04 的准确率是假数字，但报告看不出异常。
 *
 * 探针：问一句纯闲聊，正常应判 `chitchat`；若判 `knowledge`，基本可断定路由降级。
 * 返回问题列表，空数组 = 环境健康。
 */
export async function preflight(token, base = BASE) {
  const issues = [];
  let turn;
  try {
    turn = await sseStream(token, { content: '你好呀，今天过得怎么样？' }, base);
  } catch (err) {
    return [`对话不可用：${msg(err)}`];
  }
  const f = summarizeTurn(turn.events, turn.wall_ms);

  if (f.intent === 'knowledge') {
    issues.push(
      '意图路由疑似降级：闲聊输入被判为 knowledge（fallback 值）。检查 MEMORY_LLM_MODEL 额度/可用性',
    );
  } else if (f.intent === null) {
    issues.push('未收到 data-plan 事件，意图路由未工作');
  }
  if (f.empty_answer) issues.push('探针答案为空');
  if (f.errors.length) {
    issues.push(`error 事件：${JSON.stringify(f.errors[0]).slice(0, 160)}`);
  }

  // 检索链路可用性：`GET /search` 是全文检索入口（`POST /ai/chat` 是 SSE，不适合探针）
  try {
    const q = await apiGet(token, '/search?q=' + encodeURIComponent('高炉') + '&page=1&pageSize=3', base);
    if (q.status !== 200) {
      issues.push(`/search 返回 ${q.status}（检索链路异常）`);
    } else if (!Array.isArray(q.json?.items ?? q.json?.list ?? q.json?.records ?? [])) {
      issues.push('/search 响应结构异常（无列表字段）');
    }
  } catch (err) {
    issues.push(`/search 不可用：${msg(err)}`);
  }

  // rerank 额度：403 时检索静默降级为 RRF，对话仍正常 —— 必须单独探，不能靠对话结果推断。
  // 这里只作为**警告**（不打进 issues）：它不影响 s07/s08/s09/s11/s12 的判定，
  // 但会让 s01/s02/s05 的检索/引用口径偏离，所以由那几项自己调 probeRerank() 写进报告。
  const rr = await probeRerank();
  if (!rr.ok) {
    console.warn(
      `  ⚠️ Rerank 不可用（HTTP ${rr.status}，model=${rr.model}）：检索正在降级为 RRF。` +
        `s01/s02/s05 的检索与引用口径会偏离。${rr.detail ? '详情：' + rr.detail.slice(0, 120) : ''}`,
    );
  }

  return issues;
}
