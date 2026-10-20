/**
 * 工具层公共小函数（工单 23）。
 *
 * `safeDomain` 原本是 `ai-agent.service.ts` 的 private 方法，被两处使用：
 * - 工具内部（web_search 拼来源标题与正文）
 * - 编排层（`filterCitedSources` 里判断 `(来源: 域名)` 是否被引用）
 *
 * 抽到这里是为了**只有一份实现** —— 两边各留一份迟早会漂移。
 */

/** 从 URL 取域名；非法 URL 退化为前 40 字符 */
export function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}
