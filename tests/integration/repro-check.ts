// Reproducibility check: a clean clone of HEAD installs from the lockfile, builds, writes the same
// fixtures byte for byte, and the CLI mints and resolves the golden Refs to identical text.
// Run: pnpm repro:check [--out <file>]   (the report also goes to stdout; default .scratch/repro/report.md)
// The clone is of HEAD, so commit first: uncommitted changes are not in it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { writeCustomers } from "../helpers/fixtures.ts";

const root = join(import.meta.dirname, "../..");

interface Golden {
  fixtures: Record<string, string>;
  outputs: { args: string[]; status: number | null; stdout: string; stderr: string }[];
}

/** Writes the fixtures into `dir` and runs the golden commands through this tree's CLI. */
async function golden(dir: string): Promise<Golden> {
  const file = join(dir, "customers.parquet");
  await writeCustomers(file, 1000);
  const cli = join(root, "packages/cli/src/index.ts");
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: dir, env: { ...process.env, FUSEN_DEBUG: "" } });
    return { args, status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const selections = [
    [],
    ["--where", "region = 'south' AND amount > 500"],
    ["--where", "id <= 20", "--columns", "id,note"],
    ["--query", "SELECT region, count(*) AS n, round(sum(amount), 2) AS total FROM data GROUP BY region ORDER BY region"],
    ["--where", "file_row_number BETWEEN 3 AND 5"],
  ];
  const outputs = [run("card", file), run("peek", file, "--rows", "3")];
  for (const selection of selections) {
    const minted = run("ref", file, ...selection);
    outputs.push(minted, run("resolve", minted.stdout.trim(), "--limit", "50"));
  }
  const fixtures = { "customers.parquet": createHash("sha256").update(readFileSync(file)).digest("hex") };
  return { fixtures, outputs };
}

function sh(command: string, args: string[], cwd: string): void {
  // pnpm is a .cmd shim on Windows, which only a shell runs.
  const r = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd} (exit ${r.status}):\n${r.stderr || r.stdout}`);
}

const { values } = parseArgs({ options: { golden: { type: "string" }, out: { type: "string" } } });

if (values.golden) {
  // The clone's own copy of this script, run by the check below.
  process.stdout.write(JSON.stringify(await golden(values.golden)));
} else {
  const out = values.out ?? join(root, ".scratch/repro/report.md");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim() !== "";
  const work = mkdtempSync(join(tmpdir(), "fusenduck-repro-"));
  // Both trees write the fixtures to the same path, so the Refs (which carry the path) can match.
  const data = join(work, "data");
  const clone = join(work, "clone");
  const steps: string[] = [];
  let failed: string[] = [];
  try {
    mkdirSync(data);
    const here = await golden(data);
    rmSync(data, { recursive: true });
    mkdirSync(data);

    let t = performance.now();
    sh("git", ["clone", "--quiet", "--no-hardlinks", root, clone], work);
    sh("git", ["checkout", "--quiet", head], clone);
    steps.push(`clone of ${head.slice(0, 12)}: ${Math.round(performance.now() - t)} ms`);
    t = performance.now();
    sh("pnpm", ["install", "--frozen-lockfile"], clone);
    steps.push(`pnpm install --frozen-lockfile: ${Math.round(performance.now() - t)} ms`);
    t = performance.now();
    sh("pnpm", ["build"], clone);
    steps.push(`pnpm build: ${Math.round(performance.now() - t)} ms`);

    const r = spawnSync(process.execPath, [join(clone, "tests/integration/repro-check.ts"), "--golden", data], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`the clone's golden run failed (exit ${r.status}):\n${r.stderr}`);
    const there = JSON.parse(r.stdout) as Golden;

    for (const [name, hash] of Object.entries(here.fixtures)) {
      if (there.fixtures[name] !== hash) failed.push(`fixture ${name}: sha256 ${hash.slice(0, 16)} here, ${there.fixtures[name]?.slice(0, 16)} in the clone`);
    }
    // The fixture path is the same in every command; a Ref is shown by its start.
    const label = (args: string[]) =>
      `fusen ${args
        .map((x) => x.replace(data, "<data>"))
        .map((x) => (x.startsWith("fusen://") ? "<ref>" : x.includes(" ") ? JSON.stringify(x.length > 50 ? `${x.slice(0, 47)}...` : x) : x))
        .join(" ")}`;
    here.outputs.forEach((a, i) => {
      const b = there.outputs[i];
      if (a.status !== 0) failed.push(`${label(a.args)}: exit ${a.status} here: ${a.stderr.trim()}`);
      if (!b || b.status !== a.status || b.stdout !== a.stdout) failed.push(`${label(a.args)}: the clone printed different text`);
    });
    const rows = here.outputs.map((a, i) => {
      const digest = createHash("sha256").update(a.stdout).digest("hex").slice(0, 16);
      const same = there.outputs[i]?.stdout === a.stdout ? "same" : "DIFFERENT";
      return `| \`${label(a.args).replaceAll("|", "\\|")}\` | ${a.status} | ${digest} | ${same} |`;
    });
    const report = [
      `## repro:check ${failed.length ? "FAILED" : "passed"} (${head.slice(0, 12)}, ${process.platform}, Node ${process.versions.node})`,
      "",
      ...(dirty ? ["Note: the working tree has uncommitted changes; the clone has HEAD only.", ""] : []),
      ...steps.map((s) => `- ${s}`),
      `- fixture customers.parquet sha256: ${Object.values(here.fixtures)[0]?.slice(0, 16)} (${there.fixtures["customers.parquet"] === here.fixtures["customers.parquet"] ? "same" : "DIFFERENT"} in the clone)`,
      "",
      "| command | exit | sha256 of stdout | clean clone |",
      "|---|---|---|---|",
      ...rows,
      "",
      ...failed.map((f) => `- ${f}`),
    ].join("\n");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${report}\n`);
    process.stdout.write(`${report}\n`);
  } catch (error) {
    failed = [String(error instanceof Error ? error.message : error)];
    process.stderr.write(`repro:check: ${failed[0]}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  process.exitCode = failed.length ? 1 : 0;
}
