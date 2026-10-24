import { existsSync, readFileSync, statSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { FusenError } from "./errors.ts";

/**
 * A named connection to a database server (docs/adr/0005). The Ref carries the name only; the server address
 * comes from the user's own file, and the password from the user's own environment.
 */
export interface Profile {
  name: string;
  kind: "postgres" | "mysql";
  host: string;
  port: number;
  dbname: string;
  user: string;
  /** The environment variable that holds the password; it must start with FUSEN_. */
  passwordEnv?: string;
  /** Refuse a host that resolves to a loopback, private or link-local address unless this is true. */
  allowPrivate: boolean;
  /** libpq `sslmode` (`verify-full` unless the profile says otherwise); for MySQL its `ssl_mode`, `verify_ca` by default. */
  sslmode: string;
  /** MySQL: the file holding the certificate authority that signed the server's certificate. */
  sslCa?: string;
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PASSWORD_ENV = /^FUSEN_[A-Z0-9_]{1,64}$/;
const SSLMODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
const MYSQL_SSLMODES = new Set(["disabled", "preferred", "required", "verify_ca"]);
// verify_identity is not offered: the extension connects to the checked IP and never compares the certificate's name, so it would only be verify_ca under a stronger name.
const KEYS = new Set(["kind", "host", "port", "dbname", "user", "password_env", "allow_private", "sslmode", "ssl_ca"]);

/** Where the profiles live: `FUSEN_CONNECTIONS`, else the user's config directory. */
export function connectionsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FUSEN_CONNECTIONS) return env.FUSEN_CONNECTIONS;
  if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "fusenduck", "connections.toml");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "fusenduck", "connections.toml");
}

/** The small subset of TOML the file uses: `[name]` tables of `key = "text" | 123 | true`, and `#` comments. */
function parseToml(text: string): Map<string, Map<string, string | number | boolean>> {
  const tables = new Map<string, Map<string, string | number | boolean>>();
  let current: Map<string, string | number | boolean> | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/^\s+|\s+$/g, "");
    if (!line || line.startsWith("#")) continue;
    const at = `line ${index + 1}`;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      const name = table[1]!.trim();
      if (tables.has(name)) throw new FusenError(`the connections file defines "${name}" twice (${at})`);
      current = new Map();
      tables.set(name, current);
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (!pair || !current) throw new FusenError(`the connections file is not valid at ${at}`);
    const [, key, valueText] = pair;
    let value: string | number | boolean;
    if (/^"([^"\\]*)"$/.test(valueText!)) value = valueText!.slice(1, -1);
    else if (/^-?\d+$/.test(valueText!)) value = Number(valueText);
    else if (valueText === "true" || valueText === "false") value = valueText === "true";
    else throw new FusenError(`the connections file has a value it cannot read at ${at}`);
    if (current.has(key!)) throw new FusenError(`the connections file sets "${key}" twice (${at})`);
    current.set(key!, value);
  }
  return tables;
}

function profileOf(name: string, table: Map<string, string | number | boolean>): Profile {
  if (!NAME.test(name)) throw new FusenError(`"${name}" is not a valid connection name (lower-case letters, digits, - and _, starting with a letter)`);
  for (const key of table.keys()) if (!KEYS.has(key)) throw new FusenError(`connection "${name}" has an unknown setting "${key}"`);
  const text = (key: string, required = true): string | undefined => {
    const value = table.get(key);
    if (value === undefined) {
      if (required) throw new FusenError(`connection "${name}" needs "${key}"`);
      return undefined;
    }
    if (typeof value !== "string" || !value || /[\s'"\\]/.test(value)) throw new FusenError(`connection "${name}": "${key}" must be plain text without spaces or quotes`);
    return value;
  };
  const kind = text("kind")!;
  if (kind !== "postgres" && kind !== "mysql") throw new FusenError(`connection "${name}": kind must be "postgres" or "mysql"`);
  const port = table.get("port");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new FusenError(`connection "${name}": port must be a number from 1 to 65535`);
  const passwordEnv = text("password_env", false);
  if (passwordEnv !== undefined && !PASSWORD_ENV.test(passwordEnv)) {
    throw new FusenError(`connection "${name}": password_env must be an environment variable that starts with FUSEN_`);
  }
  const allowPrivate = table.get("allow_private") ?? false;
  if (typeof allowPrivate !== "boolean") throw new FusenError(`connection "${name}": allow_private must be true or false`);
  const sslmode = text("sslmode", false) ?? (kind === "mysql" ? "verify_ca" : "verify-full");
  const sslCa = text("ssl_ca", false);
  if (kind === "mysql") {
    if (!MYSQL_SSLMODES.has(sslmode)) throw new FusenError(`connection "${name}": sslmode "${sslmode}" is not one of ${[...MYSQL_SSLMODES].join(", ")}`);
    // Measured on the real extension: without ssl_ca the client accepts any certificate under verify_ca.
    if (sslmode === "verify_ca" && !sslCa) {
      throw new FusenError(`connection "${name}": sslmode ${sslmode} needs ssl_ca (the file of the certificate authority); without it the MySQL client does not check the server. Set ssl_ca, or sslmode = "required" to encrypt without checking`);
    }
  } else {
    if (!SSLMODES.has(sslmode)) throw new FusenError(`connection "${name}": sslmode "${sslmode}" is not one libpq knows`);
    if (sslCa) throw new FusenError(`connection "${name}": ssl_ca is only for MySQL connections`);
  }
  return { name, kind, host: text("host")!, port, dbname: text("dbname")!, user: text("user")!, passwordEnv, allowPrivate, sslmode, ...(sslCa ? { sslCa } : {}) };
}

/** Reads and checks the profile `name`. The file is used only if it is the user's own and nobody else can write it. */
export function loadProfile(name: string, opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): Profile {
  const path = opts.path ?? connectionsPath(opts.env);
  if (!NAME.test(name)) throw new FusenError(`"${name}" is not a valid connection name`);
  if (!existsSync(path)) throw new FusenError(`no connection named "${name}": define it in ${path}`);
  if (process.platform !== "win32") {
    const info = statSync(path);
    if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
      throw new FusenError(`${path} must be owned by you and not writable by group or others (chmod go-w)`);
    }
  }
  const tables = parseToml(readFileSync(path, "utf8"));
  const table = tables.get(name);
  if (!table) throw new FusenError(`no connection named "${name}": define it in ${path}`);
  return profileOf(name, table);
}

/** The password from the profile's variable, or for Postgres the matching line of `~/.pgpass` (the password only). */
export function readPassword(profile: Profile, env: NodeJS.ProcessEnv = process.env): string {
  if (profile.passwordEnv) {
    const value = env[profile.passwordEnv];
    if (!value) throw new FusenError(`connection "${profile.name}": the environment variable ${profile.passwordEnv} is not set`);
    return value;
  }
  if (profile.kind === "postgres") {
    const file = env.PGPASSFILE ? undefined : join(homedir(), ".pgpass");
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const parts = line.split(/(?<!\\):/).map((part) => part.replace(/\\(.)/g, "$1"));
        if (parts.length === 5 && [profile.host, "*"].includes(parts[0]!) && [String(profile.port), "*"].includes(parts[1]!)
          && [profile.dbname, "*"].includes(parts[2]!) && [profile.user, "*"].includes(parts[3]!)) return parts[4]!;
      }
    }
  }
  throw new FusenError(`connection "${profile.name}": no password found; set password_env in the profile and export that variable`);
}

/** Whether an address is loopback, private, link-local, unspecified, or a metadata address (including IPv4-mapped IPv6). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1]! : address;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  return lower === "::" || lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

/**
 * The address the engine connects to. The name is resolved here, once, and the address is what the connection uses
 * (`hostaddr`), so the address that was checked is the one connected to.
 */
export async function resolveHost(profile: Profile): Promise<string> {
  const address = isIP(profile.host) ? profile.host : (await lookup(profile.host)).address;
  if (!profile.allowPrivate && isPrivateAddress(address)) {
    throw new FusenError(`connection "${profile.name}": ${profile.host} is a loopback, private or link-local address; set allow_private = true in the profile to use it`);
  }
  return address;
}
