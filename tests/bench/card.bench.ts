// Measures the budgets in bench/budgets.json on a generated 1,000,000-row Parquet file.
// Run: pnpm bench   (add --write to record the measured numbers)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCard, mintRef, openSource, renderCard, resolveRef } from "../../packages/core/src/index.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

const dir = tempDir();
const file = join(dir, "big.parquet");
await writeCustomers(file, 1_000_000);

const t0 = performance.now();
const engine = await openSource(file);
const card = await buildCard(engine);
const cardMs = Math.round(performance.now() - t0);

const ref = await mintRef(file, { where: "id <= 11" });
const rendered = await resolveRef(ref, { limit: 11 });
// Tokens are estimated as characters / 3.5; no tokenizer is used.
const tokens = (s: string) => Math.round(s.length / 3.5);

const measured = {
  measured_on: "1,000,000 rows x 5 columns (id, region, amount, status, note), Parquet",
  card_build_ms: cardMs,
  card_render_tokens: tokens(renderCard(card, file)),
  rows_render_tokens_11_rows: tokens(rendered),
};
console.log(JSON.stringify(measured, null, 2));
if (process.argv.includes("--write")) {
  writeFileSync(
    "bench/budgets.json",
    `${JSON.stringify({ budgets: { card_build_ms: 1000, card_render_tokens: 1000, rows_render_tokens_11_rows: 1000 }, measured }, null, 2)}\n`,
  );
}
