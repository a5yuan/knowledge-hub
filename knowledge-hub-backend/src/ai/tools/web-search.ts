/**
 * web_search（Tavily，工单 23 抽取）。
 *
 * 行为与原实现逐行一致：
 * - 未配 key → 直接返回「未配置」（`available` 在构造期算一次，与原来闭包捕获同语义）
 * - 8s 超时（AbortController）
 * - 0 条命中单独文案
 * - ⚠️ 登记来源走 `sources.push`（不去重），保持既有不一致；对齐去重拆到后续工单
 * - 正文编号用 `[W1] [W2]`，**不参与**全局 [n] 编号
 */
import type { ToolDeps, ToolResult, WebResult } from './types';
import { safeDomain } from './utils';
import { TAVILY_TIMEOUT_MS, WEB_CONTENT_SLICE } from './constants';

/** Tavily 返回的最小结构（只取用到的字段） */
interface TavilyResponse {
  results?: Array<{ title: string; url: string; content: string }>;
}

export async function webSearch(
  input: { query: string },
  deps: ToolDeps,
): Promise<ToolResult> {
  const apiKey = deps.config.tavilyApiKey;
  if (!apiKey) {
    return {
      summary: 'Web 搜索未配置',
      content:
        'Web 搜索能力未配置（缺少 TAVILY_SEARCH）。请告知用户当前仅能基于企业知识库回答，如需公网信息请管理员配置搜索服务。',
      results: [] as WebResult[],
    };
  }

  // timer 声明在 try 外、清理在 finally：原实现只在成功路径 clearTimeout，
  // 异常或非 2xx 时会漏一个 8s 定时器（jest 报「worker 未正常退出」即此因）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TAVILY_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: input.query,
        max_results: 5,
        search_depth: 'basic',
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`tavily ${resp.status}`);
    const data = (await resp.json()) as TavilyResponse;
    const results = (data.results ?? []).slice(0, 5);
    if (results.length === 0) {
      return {
        summary: 'Web 0 条命中',
        content: '公网搜索未找到相关结果。',
        results: [],
      };
    }
    for (const r of results) {
      const domain = safeDomain(r.url);
      deps.sources.push({
        kind: 'web',
        title: `${r.title} — ${domain}`,
        url: r.url,
        excerpt: r.content.slice(0, deps.config.excerptLen),
        heading: null,
      });
    }
    const text = results
      .map(
        (r, i) =>
          `[W${i + 1}] ${r.title} (${safeDomain(r.url)})\n${r.content.slice(0, WEB_CONTENT_SLICE)}`,
      )
      .join('\n\n');
    return {
      summary: `Web 命中 ${results.length} 条`,
      content: text,
      results: results.map((r) => ({ title: r.title, url: r.url })),
    };
  } catch (err) {
    deps.logger.warn(
      `web_search 降级: ${err instanceof Error ? err.message : err}`,
    );
    return {
      summary: 'Web 搜索暂不可用',
      content:
        '公网搜索服务暂时不可用，请基于已有信息回答，并告知用户 Web 结果缺失。',
      results: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
