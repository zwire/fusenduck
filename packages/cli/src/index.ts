#!/usr/bin/env node
// `fusen card | ref | resolve` entry point. See docs/vision.md and docs/adr/0001.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildCard, describeError, FusenError, MAX_PEEK_ROWS, mintRef, openSource, peek, renderCard, resolveRef } from "@fusenduck/core";

const USAGE = `usage:
  fusen card <file.parquet> [--unmask]
  fusen peek <file.parquet> [--rows <n>] [--unmask]   (the card, the first rows and a Ref in one result)
  fusen ref <file.parquet> [--query <select over data>] [--where <predicate>] [--columns a,b]
  fusen resolve <ref> [--limit <n>] [--root <dir>]... [--unmask]   (roots default to the current directory)
  fusen --help | --version

exit status: 0 done (a DATA_CHANGED result included), 1 the command failed, 2 the command line is wrong.
Values that look like personal data (emails, phone numbers, names, ...) are masked unless --unmask is given.
FUSEN_DEBUG=1 shows engine errors, which can quote values from the file.`;

/** A mistake in the command line: exit status 2, with the usage. */
class UsageError extends FusenError {}

const usage = (message: string) => new UsageError(`${message}\n${USAGE}`);

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
        rows: { type: "string" },
        root: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        unmask: { type: "boolean" },
      },
    });
  } catch (error) {
    throw usage(error instanceof Error ? error.message : String(error));
  }
  const { positionals, values } = parsed;
  if (values.help || positionals[0] === "help") return `${USAGE}\n`;
  if (values.version) {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    return `${version}\n`;
  }
  const [command, target, ...extra] = positionals;
  if (!command) throw usage("give a command");
  if (!["card", "peek", "ref", "resolve"].includes(command)) throw usage(`unknown command: ${command}`);
  if (!target) throw usage(command === "resolve" ? "resolve needs a Ref" : `${command} needs the path of a Parquet file`);
  if (extra.length) throw usage(`unexpected argument: ${extra[0]} (quote a --where or --query that has spaces)`);
  const only = (...allowed: string[]) => {
    const stray = Object.keys(values).filter((k) => !allowed.includes(k));
    if (stray.length) throw usage(`${command} does not take --${stray.join(", --")}`);
  };
  switch (command) {
    case "card": {
      only("unmask");
      const engine = await openSource(target);
      try {
        return renderCard(await buildCard(engine, { unmask: values.unmask }), engine.source);
      } finally {
        engine.close();
      }
    }
    case "peek": {
      only("rows", "unmask");
      if (values.rows !== undefined && !(/^\d+$/.test(values.rows) && Number(values.rows) <= MAX_PEEK_ROWS)) {
        throw usage(`--rows must be an integer from 0 to ${MAX_PEEK_ROWS}`);
      }
      const rows = values.rows === undefined ? undefined : Number(values.rows);
      return peek(target, { ...(rows === undefined ? {} : { rows }), unmask: values.unmask });
    }
    case "ref": {
      only("query", "where", "columns");
      const columns = values.columns?.split(",");
      if (columns?.some((c) => c === "")) throw usage("--columns needs a comma-separated list of names");
      if (values.where !== undefined && values.where.trim() === "") throw usage("--where needs a predicate");
      if (values.query !== undefined && values.query.trim() === "") throw usage("--query needs a SELECT");
      return `${await mintRef(target, { query: values.query, where: values.where, columns })}\n`;
    }
    case "resolve": {
      only("limit", "root", "unmask");
      if (values.limit !== undefined && !/^\d+$/.test(values.limit)) throw usage("--limit must be a non-negative integer");
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      const roots = values.root ?? [process.cwd()];
      try {
        return await resolveRef(target, { ...(limit === undefined ? {} : { limit }), roots, unmask: values.unmask });
      } catch (error) {
        // The person at the terminal set the roots, so naming them is safe, and it says what to change.
        if (error instanceof FusenError && error.message.includes("outside the allowed roots")) {
          throw new FusenError(`${error.message}\nroots: ${roots.join(", ")}. Run from the file's directory or add --root <dir>.`);
        }
        throw error;
      }
    }
  }
  throw usage(`unknown command: ${command}`);
}

try {
  process.stdout.write(await main(process.argv.slice(2)));
} catch (error) {
  // Engine messages can quote source values; FUSEN_DEBUG=1 shows them to the person at the terminal.
  process.stderr.write(`fusen: ${describeError(error, { debug: process.env.FUSEN_DEBUG === "1" })}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
