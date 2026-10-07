/**
 * 雪花ID精度处理工具
 *
 * 雪花ID 为 64 位整数，超出 JS Number 安全整数范围（2^53 - 1），
 * 以 Number 存储或传输会丢失精度，必须统一以字符串表示。
 *
 * @param value 雪花ID（bigint / 字符串 / Number）
 * @param fieldName 字段名，用于错误提示
 * @returns 精度安全的字符串雪花ID
 */
export function normalizeSnowflakeId(
  value: string | number | bigint,
  fieldName = 'id',
): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new Error(`[${fieldName}] 雪花ID不能为空`);
    }
    return trimmed;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `[${fieldName}] 数值 ${value} 超出 JS 安全整数范围，精度已丢失，请以字符串形式传入雪花ID`,
      );
    }
    return String(value);
  }
  throw new Error(`[${fieldName}] 雪花ID类型不合法：${typeof value}`);
}
