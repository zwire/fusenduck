import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCard, mintRef, openSource, peek, renderCard, resolveRef } from "@fusenduck/core";
import { tempDir, writeCustomers } from "../helpers/fixtures.ts";

const cli = join(import.meta.dirname, "../../packages/cli/src/index.ts");
const mcp = join(import.meta.dirname, "../../packages/mcp/src/index.ts");

// People: columns whose names say personal data, free text that carries some, and look-alikes that are not.
async function writePeople(path: string): Promise<void> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  await connection.run(`COPY (
    SELECT i AS id,
           'user' || i || '@example.com' AS email,
           '+81 90-1234-' || lpad(i::VARCHAR, 4, '0') AS phone,
           'Taro ' || i AS full_name,
           DATE '1990-01-01' + i::INTEGER AS birth_date,
           CASE i WHEN 2 THEN 'call 03-1234-5678 or mail a.b@example.org'
                  WHEN 3 THEN 'paid with 4111 1111 1111 1111'
                  ELSE 'note ' || i END AS note,
           TIMESTAMP '2026-10-22 14:00:00' + INTERVAL (i) MINUTE AS created_at,
           4111111111111111 + 0 * i AS order_no,
           'Widget ' || i AS product_name,
           '2026-10-22 14:00:00' AS created_text
    FROM range(1, 6) t(i)
  ) TO '${path}' (FORMAT parquet)`);
}

const dataLines = (out: string) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("personal data is masked by default", () => {
  const dir = tempDir();
  const file = join(dir, "people.parquet");
  const customers = join(dir, "customers.parquet");

  beforeAll(async () => {
    await writePeople(file);
    await writeCustomers(customers, 100);
  });

  it("hides columns named like personal data and values shaped like it, and says so", async () => {
    const out = await resolveRef(await mintRef(file), { roots: [dir] });
    const rows = dataLines(out);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.email).toBe("«masked:email»");
      expect(row.phone).toBe("«masked:phone»");
      expect(row.full_name).toBe("«masked:name»");
      expect(row.birth_date).toBe("«masked:birth»");
    }
    expect(rows[1]!.note).toBe("call «masked:phone» or mail «masked:email»");
    expect(rows[2]!.note).toBe("paid with «masked:card»");
    expect(rows[0]!.note).toBe("note 1");
    // Look-alikes stay: a timestamp, a long number that is not text, a product name, a timestamp written as text.
    expect(rows[0]!.created_at).toBe("2026-10-22 14:01:00");
    expect(rows[0]!.order_no).toBe("4111111111111111");
    expect(rows[0]!.product_name).toBe("Widget 1");
    expect(rows[0]!.created_text).toBe("2026-10-22 14:00:00");
    expect(out).not.toMatch(/example\.com|Taro|1990-|03-1234|4111 1111/);
    expect(out).toContain(
      "MASKED: values that look like personal data are hidden: email (email, by column name), phone (phone, by column name), " +
        "full_name (name, by column name), birth_date (birth, by column name), note (email, phone, card, by value). " +
        "Whoever runs fusenduck can show them with --unmask.",
    );
  });

  it("shows them only when unmasking is asked for", async () => {
    const out = await resolveRef(await mintRef(file), { roots: [dir], unmask: true });
    expect(dataLines(out)[0]!.email).toBe("user1@example.com");
    expect(out).not.toContain("MASKED");
  });

  it("masks by shape when a query renames the column", async () => {
    const ref = await mintRef(file, { query: "SELECT upper(email) AS contact FROM data" });
    const rows = dataLines(await resolveRef(ref, { roots: [dir] }));
    expect(rows[0]!.contact).toBe("«masked:email»");
  });

  it("a predicate still selects by the real value", async () => {
    const ref = await mintRef(file, { where: "email = 'user2@example.com'" });
    const rows = dataLines(await resolveRef(ref, { roots: [dir] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("2");
  });

  it("hides the card's min and max of such columns", async () => {
    const card = await buildCard(await openSource(file));
    const email = card.columns.find((c) => c.column === "email")!;
    expect([email.min, email.max]).toEqual(["«masked:email»", "«masked:email»"]);
    const birth = card.columns.find((c) => c.column === "birth_date")!;
    expect([birth.min, birth.max, birth.avg]).toEqual(["«masked:birth»", "«masked:birth»", "«masked:birth»"]);
    expect(card.columns.find((c) => c.column === "product_name")!.min).toBe("Widget 1");
    expect(card.columns.find((c) => c.column === "created_at")!.min).toBe("2026-10-22 14:01:00");
    const text = renderCard(card, file);
    expect(text).not.toMatch(/example\.com|Taro|1990-/);
    expect(text).toContain("MASKED: min, max and avg values that look like personal data are hidden: email (email, by column name)");
    const raw = await buildCard(await openSource(file), { unmask: true });
    expect(raw.columns.find((c) => c.column === "email")!.min).toBe("user1@example.com");
  });

  it("peek masks both its card and its rows", async () => {
    const out = await peek(file, { roots: [dir] });
    expect(out).not.toMatch(/example\.com|Taro/);
    expect((await peek(file, { roots: [dir], unmask: true })).includes("user1@example.com")).toBe(true);
  });

  it("leaves a file without personal data exactly as before", async () => {
    const out = await peek(customers, { roots: [dir] });
    expect(out).not.toContain("MASKED");
    expect(out).not.toContain("«masked");
  });

  it("the CLI takes --unmask", () => {
    const masked = spawnSync("node", [cli, "peek", file], { encoding: "utf8", cwd: dir });
    expect(masked.stdout).toContain("«masked:email»");
    const shown = spawnSync("node", [cli, "peek", file, "--unmask"], { encoding: "utf8", cwd: dir });
    expect(shown.stdout).toContain("user1@example.com");
  });

  it("an agent cannot unmask through a tool; only the server's --unmask can", async () => {
    const open = async (...args: string[]) => {
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(new StdioClientTransport({ command: "node", args: [mcp, "--root", dir, ...args] }));
      return client;
    };
    const text = async (client: Client, args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "fusen_peek", arguments: args });
      return (result.content as { text: string }[]).map((c) => c.text).join("\n");
    };
    const masked = await open();
    try {
      const { tools } = await masked.listTools();
      for (const tool of tools) expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("unmask");
      expect(await text(masked, { path: file })).toContain("«masked:email»");
      expect(await text(masked, { path: file, unmask: true })).not.toContain("user1@example.com");
    } finally {
      await masked.close();
    }
    const shown = await open("--unmask");
    try {
      expect(await text(shown, { path: file })).toContain("user1@example.com");
    } finally {
      await shown.close();
    }
  });
});

describe("personal data inside nested values", () => {
  const dir = tempDir();
  const file = join(dir, "events.parquet");

  beforeAll(async () => {
    const connection = await (await DuckDBInstance.create(":memory:")).connect();
    await connection.run(`COPY (
      SELECT i AS id,
             ('{"email":"j' || i || '@example.com"}')::JSON AS payload,
             {'email': 'b' || i || '@example.com', 'plan': 'pro'} AS info,
             ['a' || i || '@example.com', 'plain'] AS contacts,
             NULL::VARCHAR AS phone
      FROM range(1, 4) t(i)
    ) TO '${file}' (FORMAT parquet)`);
  });

  it("walks JSON, STRUCT and LIST values in rows, and hides a field named like personal data", async () => {
    const out = await resolveRef(await mintRef(file), { roots: [dir] });
    expect(out).not.toContain("example.com");
    const row = dataLines(out)[0]!;
    expect(row.info).toEqual({ email: "«masked:email»", plan: "pro" });
    expect(row.contacts).toEqual(["«masked:email»", "plain"]);
    expect(String(row.payload)).toContain("«masked:email»");
    // A column whose every value is null hid nothing, so the note does not name it.
    expect(out).toMatch(/MASKED: values that look like personal data are hidden: payload \(email, by value\), info \(email, by value\), contacts \(email, by value\)\./);
  });

  it("hides the card's min and max of nested columns by their shape", async () => {
    const text = renderCard(await buildCard(await openSource(file)), file);
    expect(text).not.toContain("example.com");
    expect(text).not.toContain("phone (");
  });
});
