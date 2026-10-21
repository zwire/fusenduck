import { describe, expect, it } from "vitest";
import { compare, table } from "../bench/budgets.ts";

describe("bench budgets", () => {
  it("passes numbers at or under budget", () => {
    const rows = compare({ a: 10, b: 5 }, { a: 10, b: 6 });
    expect(rows.map((r) => r.over)).toEqual([false, false]);
  });

  it("flags a number over budget", () => {
    const rows = compare({ a: 11 }, { a: 10 });
    expect(rows[0]).toEqual({ name: "a", measured: 11, budget: 10, over: true });
    expect(table(rows)).toContain("| a | 11 | 10 | OVER |");
  });

  it("flags a budget with no measured number", () => {
    expect(compare({}, { a: 10 })[0]?.over).toBe(true);
  });

  it("flags a measured number that is not finite", () => {
    expect(compare({ a: NaN }, { a: 10 })[0]?.over).toBe(true);
  });
});
