/**
 * 引用支撑性 judge（工单 24）。
 *
 * 抽成共享模块而不是留在 s05 里：`s05-citation.mjs` 与 `tools/judge-replay.mjs`
 * 必须用**完全同一套** prompt —— 两边各写一份必然漂移，而漂移会让"judge 不稳定"的实验结论失效。
 */

export const JUDGE_SYSTEM =
  '你是引用支撑性判定器。给定「问题」「回答中的一句话」「被引用的原文片段」，' +
  '只判断原文片段是否支持这句话。只输出 JSON：{"verdict":"supported|partial|unsupported","reason":"20字内"}。\n' +
  '- supported：原文能直接推出这句话\n' +
  '- partial：原文只支持一部分，或需要额外推断\n' +
  '- unsupported：原文与该句无关，或说的不是同一件事\n' +
  '不要因为「原文有相关信息但不够完整」就判 supported。只输出 JSON。';

/**
 * 一次非流式 judge 调用（OpenAI 兼容协议）。
 *
 * ⚠️ `excerptMax` 默认 1200：第一版给 500，而 chunk 本身可能更长，
 * judge 看不到的尾部会被当成"原文没写"。
 */
export async function judgeSupport(
  { base, key, model, excerptMax = 1200, timeoutMs = 30000 },
  question,
  sentence,
  excerpt,
) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `问题：${question}\n\n句子：${sentence.slice(0, 300)}\n\n` +
            `原文片段：${excerpt.slice(0, excerptMax)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`judge HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge 输出无法解析：${String(raw).slice(0, 120)}`);
  const parsed = JSON.parse(m[0]);
  const verdict = ['supported', 'partial', 'unsupported'].includes(parsed.verdict)
    ? parsed.verdict
    : 'unsupported';
  return { verdict, reason: String(parsed.reason ?? '').slice(0, 40) };
}
