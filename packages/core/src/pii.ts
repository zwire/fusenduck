// Values that look like personal data are hidden from what fusenduck shows, unless whoever runs it
// asks otherwise (docs/vision.md, section 6). Two signals: a column whose name says what it holds
// (email, phone, name, ...), whose every value is hidden, and text that is shaped like an email
// address, a phone number or a card number, which is hidden where it appears. It is best effort: a
// query can reshape a value past both signals, and a predicate still reads the real values.

/** One column that had something hidden, and why. */
export interface Masked {
  column: string;
  kinds: string[];
  by: "name" | "value";
}

export const mask = (kind: string): string => `«masked:${kind}»`;

// Column names are split into lowercase words: "birthDate", "BIRTH_DATE" and "birth date" all give birth, date.
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const PERSON = new Set(["first", "last", "full", "given", "family", "middle", "customer", "user", "person", "contact", "member", "employee", "patient"]);

/** The kind of personal data a column's name says it holds, if any. A bare "name" is not one: products have names. */
export function nameKind(column: string): string | undefined {
  const w = words(column);
  const has = (...any: string[]) => any.some((x) => w.includes(x));
  const pair = (a: string, b: string) => w.some((x, i) => x === a && w[i + 1] === b);
  if (has("email", "mail") || pair("e", "mail")) return "email";
  if (has("phone", "telephone", "tel", "mobile", "fax")) return "phone";
  if (has("firstname", "lastname", "fullname", "surname", "username") || w.some((x, i) => x === "name" && PERSON.has(w[i - 1] ?? ""))) {
    return "name";
  }
  if (has("birth", "birthday", "birthdate", "dob")) return "birth";
  if (has("address", "addr", "street", "zip", "zipcode", "postal", "postcode")) return "address";
  if (has("ssn", "passport", "iban", "cvv", "mynumber") || pair("card", "number") || pair("credit", "card") || pair("national", "id") || pair("tax", "id")) {
    return "id_number";
  }
  return undefined;
}

// An email address is found from its "@" outward, so a long run of letters without one costs one pass
// (a plain regex would retry it from every position, which a cell of megabytes turns into minutes).
const LOCAL = /[A-Za-z0-9._%+-]/;
const DOMAIN = /[A-Za-z0-9.-]/;
const TLD = /\.[A-Za-z]{2,}$/;

function maskEmails(text: string, found: Set<string>): string {
  let out = "";
  let from = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > from && LOCAL.test(text[start - 1]!)) start--;
    let end = at + 1;
    while (end < text.length && DOMAIN.test(text[end]!)) end++;
    // A sentence can end right after the address.
    while (end > at + 1 && text[end - 1] === ".") end--;
    if (start === at || !TLD.test(text.slice(at + 1, end))) continue;
    out += text.slice(from, start) + mask("email");
    found.add("email");
    from = end;
    at = end - 1;
  }
  return out + text.slice(from);
}

// An international number (+81 90-1234-5678), or three groups split by a hyphen, space or dot
// (03-1234-5678, (555) 123-4567). A date (2026-10-22) has a last group too short to match.
const PHONE = /(?<![\w+])(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]\d{2,4}){1,3}|(?:\(\d{2,4}\)\s?|\d{2,4}[\s.-])\d{2,4}[\s.-]\d{4})(?![\w])/g;
const CARD = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Hides the parts of a text that are shaped like personal data; `found` collects their kinds. */
export function maskText(text: string, found: Set<string>): string {
  let out = maskEmails(text, found);
  // Card numbers before phones, so a spaced card number is not read as phone groups.
  out = out.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? (found.add("card"), mask("card")) : m));
  out = out.replace(PHONE, (m) => ((m.match(/\d/g)?.length ?? 0) >= 9 ? (found.add("phone"), mask("phone")) : m));
  return out;
}

const ORDER = ["email", "phone", "card"];
const sorted = (kinds: Set<string>) => ORDER.filter((k) => kinds.has(k));

/** Whether a column's values are text, so their shape means something (a timestamp or a BIGINT arrives as a string too). */
export const isText = (type: string): boolean => /^(VARCHAR|TEXT|STRING)/i.test(type);

/**
 * Masks rows for display. `types` maps a column to its SQL type; values are read for their shape
 * only in text columns. Returns the rows and, in column order, what was hidden.
 */
export function maskRows(rows: Record<string, unknown>[], types: Map<string, string>): { rows: Record<string, unknown>[]; masked: Masked[] } {
  const byName = new Map<string, string>();
  for (const column of types.keys()) {
    const kind = nameKind(column);
    if (kind) byName.set(column, kind);
  }
  const byValue = new Map<string, Set<string>>();
  const masked = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => {
        if (value === null || value === undefined) return [column, value];
        const kind = byName.get(column);
        if (kind) return [column, mask(kind)];
        if (typeof value !== "string" || !isText(types.get(column) ?? "")) return [column, value];
        const found = byValue.get(column) ?? new Set<string>();
        const text = maskText(value, found);
        if (found.size) byValue.set(column, found);
        return [column, text];
      }),
    ),
  );
  const seen = rows.length ? [...types.keys()] : [];
  return {
    rows: masked,
    masked: [
      ...seen.filter((c) => byName.has(c)).map((c): Masked => ({ column: c, kinds: [byName.get(c)!], by: "name" })),
      ...seen.filter((c) => byValue.has(c)).map((c): Masked => ({ column: c, kinds: sorted(byValue.get(c)!), by: "value" })),
    ],
  };
}

/** The note that says what was hidden: `what` names the hidden things ("values", "min, max and avg values"). */
export function maskedNote(masked: Masked[], what: string): string[] {
  if (!masked.length) return [];
  const list = masked.map((m) => `${m.column} (${m.kinds.join(", ")}, by ${m.by === "name" ? "column name" : "value"})`).join(", ");
  return [`MASKED: ${what} that look like personal data are hidden: ${list}. Whoever runs fusenduck can show them with --unmask.`];
}
