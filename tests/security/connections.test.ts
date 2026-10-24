import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPrivateAddress, loadProfile, readPassword, resolveHost } from "../../packages/core/src/connections.ts";

const dir = mkdtempSync(join(tmpdir(), "fusen-conn-"));
const write = (name: string, text: string, mode = 0o600) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};
const GOOD = `# profiles
[warehouse]
kind = "postgres"
host = "db.example.com"
port = 5432
dbname = "analytics"
user = "fusen_ro"
password_env = "FUSEN_WAREHOUSE_PASSWORD"
`;

describe("connection profiles (docs/adr/0005 sections 1 and 2)", () => {
  it("reads a profile and defaults to verifying TLS", () => {
    const profile = loadProfile("warehouse", { path: write("ok.toml", GOOD) });
    expect(profile).toMatchObject({ kind: "postgres", host: "db.example.com", port: 5432, dbname: "analytics", user: "fusen_ro", sslmode: "verify-full", allowPrivate: false });
  });

  it("says where to define a missing profile, without guessing", () => {
    expect(() => loadProfile("nope", { path: write("a.toml", GOOD) })).toThrow(/no connection named "nope"/);
    expect(() => loadProfile("warehouse", { path: join(dir, "absent.toml") })).toThrow(/define it in/);
  });

  it("refuses a password variable outside FUSEN_, so a profile cannot send another secret to its host", () => {
    for (const name of ["AWS_SECRET_ACCESS_KEY", "fusen_x", "PGPASSWORD"]) {
      const path = write("p.toml", GOOD.replace("FUSEN_WAREHOUSE_PASSWORD", name));
      expect(() => loadProfile("warehouse", { path })).toThrow(/starts with FUSEN_/);
    }
  });

  it("refuses unknown settings, odd values and a literal password key", () => {
    expect(() => loadProfile("warehouse", { path: write("b.toml", GOOD + 'password = "x"\n') })).toThrow(/unknown setting "password"/);
    expect(() => loadProfile("warehouse", { path: write("c.toml", GOOD.replace('"db.example.com"', '"a b"')) })).toThrow(/plain text/);
    expect(() => loadProfile("warehouse", { path: write("d.toml", GOOD.replace("5432", "99999")) })).toThrow(/port/);
    expect(() => loadProfile("warehouse", { path: write("e.toml", GOOD.replace('"postgres"', '"oracle"')) })).toThrow(/kind/);
  });

  it.skipIf(process.platform === "win32")("is read only when nobody else can write it", () => {
    expect(() => loadProfile("warehouse", { path: write("w.toml", GOOD, 0o666) })).toThrow(/not writable by group or others/);
  });

  it("reads the password from the named variable, and says which one is missing without printing a value", () => {
    const profile = loadProfile("warehouse", { path: write("pw.toml", GOOD) });
    expect(readPassword(profile, { FUSEN_WAREHOUSE_PASSWORD: "s3cret-canary" })).toBe("s3cret-canary");
    expect(() => readPassword(profile, {})).toThrow(/FUSEN_WAREHOUSE_PASSWORD is not set/);
  });

  it("recognises loopback, private, link-local and metadata addresses, mapped IPv6 included", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) expect(isPrivateAddress(address), address).toBe(false);
  });

  it("refuses a private host unless the profile allows it, and returns the address it checked", async () => {
    const path = write("h.toml", GOOD.replace("db.example.com", "127.0.0.1"));
    await expect(resolveHost(loadProfile("warehouse", { path }))).rejects.toThrow(/allow_private = true/);
    const allowed = write("h2.toml", GOOD.replace("db.example.com", "127.0.0.1") + "allow_private = true\n");
    await expect(resolveHost(loadProfile("warehouse", { path: allowed }))).resolves.toBe("127.0.0.1");
  });
});
