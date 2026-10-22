import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCard, fingerprint, formatRef, openSource, resolveRef } from "@fusenduck/core";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

// A slow predicate: it reads almost nothing, so only a clock or a cancel stops it.
const SLOW = "id IN (SELECT i FROM range(3000000000) t(i) WHERE i % 7 = -1)";

describe("work stops when it runs too long or nobody waits for it", () => {
  const dir = tempDir();
  const file = join(dir, "customers.parquet");
  const big = join(dir, "big.parquet");

  beforeAll(async () => {
    await writeCustomers(file, 100);
    await writeCustomers(big, 4_000_000);
  });

  it("building a data card is stopped by the clock", async () => {
    const engine = await openSource(big);
    const started = Date.now();
    await expect(buildCard(engine, { timeoutMs: 20 })).rejects.toThrow(/data card stopped after 20 ms/);
    expect(Date.now() - started).toBeLessThan(2000);
    engine.close();
  });

  it("a cancelled caller stops the running query", async () => {
    const controller = new AbortController();
    const engine = await openSource(file, { signal: controller.signal });
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    await expect(engine.query(`SELECT count(*) FROM data WHERE ${SLOW}`)).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(3000);
    engine.close();
  });

  it("an engine is not opened for a caller that already went away", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(openSource(file, { signal: controller.signal })).rejects.toThrow(/cancelled/);
  });

  it("resolving a Ref stops when its caller goes away, well before the clock", async () => {
    const ref = formatRef({ source: file, where: SLOW, fingerprint: await fingerprint(await openSource(file)) });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    await expect(resolveRef(ref, { roots: [dir], signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
