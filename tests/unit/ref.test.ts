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

  it("round-trips paths and predicates with ? & = and ,", () => {
    const odd = { source: "/d/we?ird&n=a,me.parquet", where: "region = 'a&b=c,d?'", fingerprint: "abc123def456" };
    expect(parseRef(formatRef(odd))).toEqual(odd);
  });

  it.each([
    ["a parameter with no value", "fusen://file/%2Fx?v=1&junk"],
    ["a duplicate parameter", "fusen://file/%2Fx?v=1&v=2"],
    ["a malformed escape", "fusen://file/%E0%A4%A?v=1"],
    ["a missing fingerprint", "fusen://file/%2Fx"],
  ])("rejects %s with a readable error", (_name, text) => {
    expect(() => parseRef(text)).toThrow(/malformed Ref|no fingerprint/);
  });
});
