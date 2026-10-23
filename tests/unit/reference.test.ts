import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REFERENCE_PATH, renderReference } from "../../packages/mcp/src/reference.ts";

describe("MCP tool reference", () => {
  it("docs/reference/mcp-tools.md matches the tool schemas (run pnpm docs:reference after changing a tool)", async () => {
    expect(readFileSync(REFERENCE_PATH, "utf8")).toBe(await renderReference());
  });
});
