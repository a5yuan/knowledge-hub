/**
 * 评测统计工具（工单 24）。
 *
 * 只放纯函数，不做 IO —— 便于单测与跨 suite 复用。
 */

/** 分位数（线性插值；q ∈ [0,1]）。空数组返回 null，不返回 0 —— 0 和「没有样本」是两回事 */
export function percentile(values, q) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  if (arr.length === 1) return arr[0];
  const pos = (arr.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

/** 常规分位汇总：P50 / P90 / P95 / P99 / min / max / avg / n */
export function summarize(values) {
  const arr = values.filter((v) => Number.isFinite(v));
  if (arr.length === 0) {
    return { n: 0, min: null, max: null, avg: null, p50: null, p90: null, p95: null, p99: null };
  }
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    n: arr.length,
    min: Math.min(...arr),
    max: Math.max(...arr),
    avg: Math.round((sum / arr.length) * 10) / 10,
    p50: Math.round(percentile(arr, 0.5) * 10) / 10,
    p90: Math.round(percentile(arr, 0.9) * 10) / 10,
    p95: Math.round(percentile(arr, 0.95) * 10) / 10,
    p99: Math.round(percentile(arr, 0.99) * 10) / 10,
  };
}

/**
 * 混淆矩阵：rows = 标注（期望），cols = 预测（实际）。
 * 返回 { labels, matrix, accuracy, perClass }
 */
export function confusionMatrix(pairs) {
  const labels = [...new Set(pairs.flatMap((p) => [p.expected, p.actual]))].sort();
  const matrix = labels.map(() => Object.fromEntries(labels.map((l) => [l, 0])));
  let correct = 0;

  for (const p of pairs) {
    const r = labels.indexOf(p.expected);
    const c = labels.indexOf(p.actual);
    if (r < 0 || c < 0) continue;
    matrix[r][p.actual] += 1;
    if (p.expected === p.actual) correct += 1;
  }

  // 每类：support（标注数）/ precision / recall
  const perClass = Object.fromEntries(
    labels.map((label) => {
      const rowIdx = labels.indexOf(label);
      const colIdx = labels.indexOf(label);
      const support = Object.values(matrix[rowIdx]).reduce((a, b) => a + b, 0);
      let predicted = 0;
      for (const row of matrix) predicted += row[label];
      const tp = matrix[rowIdx][label];
      return [
        label,
        {
          support,
          predicted,
          precision: predicted ? Math.round((tp / predicted) * 1000) / 1000 : null,
          recall: support ? Math.round((tp / support) * 1000) / 1000 : null,
        },
      ];
    }),
  );

  return {
    labels,
    matrix,
    accuracy: pairs.length ? Math.round((correct / pairs.length) * 1000) / 1000 : null,
    perClass,
    total: pairs.length,
    correct,
  };
}

/** 简单比率，保留 3 位小数 */
export function ratio(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}
