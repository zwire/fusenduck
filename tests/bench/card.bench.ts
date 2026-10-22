// Measures the budgets in bench/budgets.json on a generated 1,000,000-row Parquet file
// and exits non-zero when any number is over its budget.
// Run: pnpm bench   (add --write to record the measured numbers)
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCard, mintRef, openSource, renderCard, resolveRef } from "../../packages/core/src/index.ts";
import { View } from "../../apps/web/src/view.ts";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";
import { buildSpa } from "../helpers/web.ts";
import { compare, table, type Numbers } from "./budgets.ts";

const BUDGETS_FILE = "bench/budgets.json";
const { budgets } = JSON.parse(readFileSync(BUDGETS_FILE, "utf8")) as { budgets: Numbers };

const dir = tempDir();
const file = join(dir, "big.parquet");
await writeCustomers(file, 1_000_000);

const t0 = performance.now();
const engine = await openSource(file);
const card = await buildCard(engine);
const cardMs = Math.round(performance.now() - t0);

const ref = await mintRef(file, { where: "id <= 11" });
const rendered = await resolveRef(ref, { limit: 11, roots: [dir] });
// Tokens are estimated as characters / 3.5; no tokenizer is used.
const tokens = (s: string) => Math.round(s.length / 3.5);

// The Web UI (docs/adr/0002): open (engine, card, whole-file Ref), a 100-row page in the middle, a Ref for a selection.
const time = async (work: () => Promise<unknown>) => {
  const start = performance.now();
  await work();
  return Math.round(performance.now() - start);
};
let view: View | undefined;
const webOpenMs = await time(async () => (view = await View.open(file, [dir])));
const fp = view!.opened.fingerprint;
const webRowsMs = await time(() => view!.rows(fp, 500_000, 100));
const webRefMs = await time(() => view!.ref(fp, [[10, 14], [40, 40], [500_000, 500_099]]));
await view!.close();
buildSpa();
const spaBytes = ["spa/index.html", "spa/style.css", "dist/app.js", "dist/api.js"]
  .map((f) => statSync(join("apps/web", f)).size)
  .reduce((a, b) => a + b, 0);

const numbers = {
  card_build_ms: cardMs,
  card_render_tokens: tokens(renderCard(card, file)),
  rows_render_tokens_11_rows: tokens(rendered),
  web_open_ms: webOpenMs,
  web_rows_page_ms: webRowsMs,
  web_ref_ms: webRefMs,
  web_spa_bytes: spaBytes,
};
rmSync(dir, { recursive: true, force: true });
const rows = compare(numbers, budgets);
console.log(table(rows));
if (process.argv.includes("--write")) {
  const measured = { measured_on: "1,000,000 rows x 5 columns (id, region, amount, status, note), Parquet", ...numbers };
  writeFileSync(BUDGETS_FILE, `${JSON.stringify({ budgets, measured }, null, 2)}\n`);
}
if (rows.some((r) => r.over)) {
  console.error(`Over budget: ${rows.filter((r) => r.over).map((r) => r.name).join(", ")}`);
  process.exitCode = 1;
}
