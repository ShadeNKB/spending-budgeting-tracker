import { describe, expect, it } from "vitest";
import { formatMoney, formatInt } from "./format";

describe("formatMoney", () => {
  it("renders standard USD with two decimals", () => {
    expect(formatMoney(12.5)).toBe("$12.50");
    expect(formatMoney(0)).toBe("$0.00");
  });

  it("prefixes negatives with a minus sign", () => {
    expect(formatMoney(-4.2)).toBe("-$4.20");
  });

  it("returns $0.00 for non-finite input", () => {
    expect(formatMoney(NaN)).toBe("$0.00");
    expect(formatMoney(Infinity)).toBe("$0.00");
  });

  it("compacts thousands and millions when requested", () => {
    expect(formatMoney(1500, { compact: true })).toBe("$1.5k");
    expect(formatMoney(12_500, { compact: true })).toBe("$13k");
    expect(formatMoney(2_400_000, { compact: true })).toBe("$2.4M");
  });

  it("does not compact below the 1000 threshold", () => {
    expect(formatMoney(999, { compact: true })).toBe("$999.00");
  });

  it("adds a leading + when sign is requested for positives", () => {
    expect(formatMoney(10, { sign: true })).toBe("+$10.00");
    expect(formatMoney(0, { sign: true })).toBe("$0.00");
    expect(formatMoney(-10, { sign: true })).toBe("-$10.00");
  });
});

describe("formatInt", () => {
  it("formats with thousands separator and rounds", () => {
    expect(formatInt(1234)).toBe("1,234");
    expect(formatInt(1234.7)).toBe("1,235");
  });
});
