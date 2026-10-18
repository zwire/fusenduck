#!/usr/bin/env node
// `fusen card | ref | resolve` entry point. See docs/vision.md and docs/adr/0001.
import { buildCard, mintRef, openSource, renderCard, resolveRef } from "@fusenduck/core";

const USAGE = `usage:
  fusen card <file.parquet>
  fusen ref <file.parquet> [--where <predicate>] [--columns a,b]
  fusen resolve <ref> [--limit <n>]`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<string> {
  const [command, target] = args;
  if (!command || !target) throw new Error(USAGE);
  switch (command) {
    case "card": {
      const engine = await openSource(target);
      return renderCard(await buildCard(engine), engine.source);
    }
    case "ref": {
      const columns = option(args, "--columns")?.split(",");
      return `${await mintRef(target, { where: option(args, "--where"), columns })}\n`;
    }
    case "resolve": {
      const limit = option(args, "--limit");
      return resolveRef(target, limit === undefined ? {} : { limit: Number(limit) });
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
