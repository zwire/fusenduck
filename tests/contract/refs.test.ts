import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRef, parseRef } from "@fusenduck/core";

// Frozen Ref strings. A change that makes one of them parse differently, or format to another string,
// breaks Refs that agents already hold: add the new shape beside the old one instead (expand, then contract).
const dir = join(import.meta.dirname, "refs");

describe("Ref corpus", () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const { ref, parsed } = JSON.parse(readFileSync(join(dir, file), "utf8")) as { ref: string; parsed: Parameters<typeof formatRef>[0] };
    it(`${file} still parses to the recorded fields and formats back to the same string`, () => {
      expect(parseRef(ref)).toEqual(parsed);
      expect(formatRef(parsed)).toBe(ref);
    });
  }
});

// Malformed Refs stay rejected. Each one must keep failing with a readable error.
describe("malformed Ref corpus", () => {
  it.each([
    "fusen://file/%2Fx?v=1&v=2",
    "fusen://file/%2Fx?v=1&junk",
    "fusen://file/%2Fx",
    "https://example.com/%2Fx?v=1",
    "fusen://file/%2Fx.csv?v=1&src=excel",
    "fusen://file/%2Fx.csv?v=1&src=csv&opt.shell=1&opt.columns=%5B%5B%22a%22%2C%22BIGINT%22%5D%5D",
  ])("%s is rejected", (text) => {
    expect(() => parseRef(text)).toThrow();
  });
});
