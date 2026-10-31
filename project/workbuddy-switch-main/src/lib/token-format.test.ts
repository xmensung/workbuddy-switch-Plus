import { describe, expect, it } from "vitest";

import { formatTokenCount } from "./token-format";

describe("formatTokenCount", () => {
  it("展示完整数字并保留千分位分隔，不做 K / M 缩写", () => {
    // 用户给的反例：31574695 曾被格式化成 31.6M。
    expect(formatTokenCount(31_574_695)).toBe("31,574,695");
    expect(formatTokenCount(1_234)).toBe("1,234");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(0)).toBe("0");
  });

  it("结果里不出现 K / M / B 之类的数量级单位", () => {
    for (const value of [999, 1_000, 1_000_000, 31_574_695]) {
      expect(formatTokenCount(value)).not.toMatch(/[KMB]/);
    }
  });

  it("百万级与十亿级同样展开", () => {
    expect(formatTokenCount(1_000_000)).toBe("1,000,000");
    expect(formatTokenCount(2_500_000_000)).toBe("2,500,000,000");
  });
});
