// 月份筛选辅助：把 'YYYY-MM' 转成半开区间后用范围条件过滤，
// 让 SQLite 能走 created_at 索引（strftime('%Y-%m', ...) 会对每行计算，索引失效全表扫）。

/**
 * 'YYYY-MM' → ['YYYY-MM-01 00:00:00', '次月-01 00:00:00']。
 * created_at 存的是 datetime('now') 的 'YYYY-MM-DD HH:MM:SS' 格式，字符串比较即时间比较。
 * 非法输入返回 null（调用方按空集处理）。
 */
export function monthRange(month: string): [string, string] | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 1 || mo < 1 || mo > 12) return null;
  const start = `${m[1]}-${m[2]}-01 00:00:00`;
  const nextY = mo === 12 ? y + 1 : y;
  const nextM = mo === 12 ? 1 : mo + 1;
  const end = `${String(nextY).padStart(4, '0')}-${String(nextM).padStart(2, '0')}-01 00:00:00`;
  return [start, end];
}
