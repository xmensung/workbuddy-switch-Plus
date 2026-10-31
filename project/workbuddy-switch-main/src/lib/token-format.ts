/**
 * Token 数量的统一展示格式。
 *
 * 规则：完整数字 + 千分位分隔（如 `31,574,695`）。
 *
 * 刻意不使用 `Intl` 的 `notation: "compact"`（K / M / B 缩写）：Token 是精确量，
 * 缩写会让「31.6M」无法与账单、接口返回值逐位核对，故一律展示原值。
 */
const exactTokenFormatter = new Intl.NumberFormat("en-US");

export function formatTokenCount(value: number): string {
  return exactTokenFormatter.format(value);
}
