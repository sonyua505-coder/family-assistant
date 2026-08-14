/**
 * 轻量失败限流（M5，对应设计文档 §9 "轻量失败限流"）。
 * 针对 /w/:token/* 的令牌校验失败计数：同一来源短时间失败过多则 429。
 * 纯内存实现（进程重启即清零），对个人家庭规模足够。
 */

const failures = new Map<string, number[]>();

/**
 * 是否允许本次请求继续。key 通常用来源 IP；窗口内失败次数超限返回 false。
 */
export function checkRateLimit(key: string, max = 10, windowMs = 300_000): boolean {
  const cutoff = Date.now() - windowMs;
  const arr = (failures.get(key) ?? []).filter((t) => t > cutoff);
  failures.set(key, arr);
  return arr.length < max;
}

/** 记录一次失败。 */
export function recordFailure(key: string): void {
  const arr = failures.get(key) ?? [];
  arr.push(Date.now());
  // 顺带清掉窗口外的旧记录，防止 Map 无限增长
  const cutoff = Date.now() - 300_000;
  failures.set(key, arr.filter((t) => t > cutoff));
}

/** 成功后清空该来源的失败计数。 */
export function clearFailures(key: string): void {
  failures.delete(key);
}
