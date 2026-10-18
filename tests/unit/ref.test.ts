import { describe, expect, it } from "vitest";
import { formatRef, parseRef } from "@fusenduck/core";

describe("Ref string", () => {
  const ref = { source: "/data/a b/customers.parquet", where: "region = 'south' AND amount > 900", columns: ["id", "amount"], fingerprint: "abc123def456" };

  it("round-trips through format and parse", () => {
    expect(parseRef(formatRef(ref))).toEqual(ref);
  });

  it("round-trips a Ref without where or columns", () => {
    const bare = { source: "/data/x.parquet", fingerprint: "abc123def456" };
    expect(parseRef(formatRef(bare))).toEqual(bare);
  });

  it("rejects a string that is not a fusen:// Ref", () => {
    expect(() => parseRef("https://example.com")).toThrow();
    expect(() => parseRef("fusen://file/")).toThrow();
  });
});
