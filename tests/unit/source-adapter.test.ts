import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openSource } from "@fusenduck/core";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

describe("the source adapter of a Parquet file", () => {
  const file = join(tempDir(), "customers.parquet");

  beforeAll(async () => {
    await writeCustomers(file, 10);
  });

  it("is the Parquet adapter, which names how it reads and addresses rows", async () => {
    const engine = await openSource(file);
    try {
      expect(engine.adapter.name).toBe("parquet");
      expect(engine.adapter.rowPosition).toBe("file_row_number");
      expect(engine.adapter.read(engine.source)).toBe(`read_parquet('${engine.source}')`);
      expect(engine.adapter.baseQuery(engine.source, true)).toBe(`SELECT *, file_row_number FROM read_parquet('${engine.source}')`);
      expect(await engine.adapter.scanBytes(engine)).toBeGreaterThan(0);
      expect(await engine.adapter.fingerprint(engine)).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      engine.close();
    }
  });
});
