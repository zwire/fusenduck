#!/usr/bin/env node
// `fusen card | ref | resolve` entry point. See docs/vision.md and docs/adr/0001.
import { parseArgs } from "node:util";
import { buildCard, mintRef, openSource, renderCard, resolveRef } from "@fusenduck/core";

const USAGE = `usage:
  fusen card <file.parquet>
  fusen ref <file.parquet> [--where <predicate>] [--columns a,b]
  fusen resolve <ref> [--limit <n>] [--root <dir>]...   (roots default to the current directory)`;

async function main(argv: string[]): Promise<string> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      where: { type: "string" },
      columns: { type: "string" },
      limit: { type: "string" },
      root: { type: "string", multiple: true },
    },
  });
  const [command, target, ...extra] = positionals;
  if (!command || !target || extra.length) throw new Error(USAGE);
  const only = (...allowed: string[]) => {
    const stray = Object.keys(values).filter((k) => !allowed.includes(k));
    if (stray.length) throw new Error(`${command} does not take --${stray.join(", --")}\n${USAGE}`);
  };
  switch (command) {
    case "card": {
      only();
      const engine = await openSource(target);
      return renderCard(await buildCard(engine), engine.source);
    }
    case "ref": {
      only("where", "columns");
      const columns = values.columns?.split(",");
      if (columns?.some((c) => c === "")) throw new Error("--columns needs a comma-separated list of names");
      if (values.where !== undefined && values.where.trim() === "") throw new Error("--where needs a predicate");
      return `${await mintRef(target, { where: values.where, columns })}\n`;
    }
    case "resolve": {
      only("limit", "root");
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
        throw new Error("--limit must be a non-negative integer");
      }
      return resolveRef(target, { ...(limit === undefined ? {} : { limit }), roots: values.root ?? [process.cwd()] });
    }
    default:
      throw new Error(USAGE);
  }
}

try {
  process.stdout.write(await main(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`fusen: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
