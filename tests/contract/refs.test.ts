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
