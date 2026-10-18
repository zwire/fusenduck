#!/usr/bin/env node
// `fusen card | ref | resolve` entry point. See docs/vision.md and docs/adr/0001.
import { parseArgs } from "node:util";
import { buildCard, describeError, FusenError, mintRef, openSource, renderCard, resolveRef } from "@fusenduck/core";

const USAGE = `usage:
  fusen card <file.parquet>
  fusen ref <file.parquet> [--query <select over data>] [--where <predicate>] [--columns a,b]
  fusen resolve <ref> [--limit <n>] [--root <dir>]...   (roots default to the current directory)`;

async function main(argv: string[]): Promise<string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        query: { type: "string" },
        where: { type: "string" },
        columns: { type: "string" },
        limit: { type: "string" },
        root: { type: "string", multiple: true },
      },
    });
  } catch (error) {
    throw new FusenError(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
  const { positionals, values } = parsed;
  const [command, target, ...extra] = positionals;
  if (!command || !target || extra.length) throw new FusenError(USAGE);
  const only = (...allowed: string[]) => {
    const stray = Object.keys(values).filter((k) => !allowed.includes(k));
    if (stray.length) throw new FusenError(`${command} does not take --${stray.join(", --")}\n${USAGE}`);
  };
  switch (command) {
    case "card": {
      only();
      const engine = await openSource(target);
      return renderCard(await buildCard(engine), engine.source);
    }
    case "ref": {
      only("query", "where", "columns");
      const columns = values.columns?.split(",");
      if (columns?.some((c) => c === "")) throw new FusenError("--columns needs a comma-separated list of names");
      if (values.where !== undefined && values.where.trim() === "") throw new FusenError("--where needs a predicate");
      if (values.query !== undefined && values.query.trim() === "") throw new FusenError("--query needs a SELECT");
      return `${await mintRef(target, { query: values.query, where: values.where, columns })}\n`;
    }
    case "resolve": {
      only("limit", "root");
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
        throw new FusenError("--limit must be a non-negative integer");
      }
      return resolveRef(target, { ...(limit === undefined ? {} : { limit }), roots: values.root ?? [process.cwd()] });
    }
    default:
      throw new FusenError(USAGE);
  }
}

try {
  process.stdout.write(await main(process.argv.slice(2)));
} catch (error) {
  // Engine messages can quote source values; FUSEN_DEBUG=1 shows them to the person at the terminal.
  process.stderr.write(`fusen: ${describeError(error, { debug: process.env.FUSEN_DEBUG === "1" })}\n`);
  process.exitCode = 1;
}
