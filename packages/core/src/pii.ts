// Values that look like personal data are hidden from what fusenduck shows, unless whoever runs it
// asks otherwise (docs/vision.md, section 6). Two signals: a column (or a field of a nested value)
// whose name says what it holds (email, phone, name, ...), whose every value is hidden, and text
// that is shaped like an email address, a phone number or a card number, which is hidden where it
// appears. It is best effort: a query can reshape a value past both signals, and a predicate still
// reads the real values.

/** One column that had something hidden, and why. */
export interface Masked {
  column: string;
  /** The column's place in the result, from 1; the note names a column by it when its name is not plain. */
  position?: number;
  kinds: string[];
  by: "name" | "value";
}

export const mask = (kind: string): string => `«masked:${kind}»`;

// Column names are split into lowercase words: "birthDate", "BIRTH_DATE" and "birth date" all give
// birth, date, and "SSNNumber" gives ssn, number.
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const PERSON = new Set([
  "first", "last", "full", "given", "family", "middle", "customer", "user", "person", "contact", "member", "employee",
  "patient", "owner", "author", "student", "holder", "display", "account", "buyer", "seller", "recipient", "sender",
  "driver", "guest", "client", "applicant", "real", "legal",
]);
// A word that makes the column about the data, not the data itself: is_mobile, phone_count, email_verified, address_id.
const ABOUT = new Set(["is", "has", "count", "verified", "rate", "version", "file", "mac", "contract", "id", "type", "status", "flag", "enabled", "opt", "format", "domain"]);
// Japanese column names, matched anywhere in the name.
const JA: [RegExp, string][] = [
  [/メール/, "email"],
  [/電話|携帯|ＦＡＸ/, "phone"],
  [/氏名|名前|姓名|フリガナ|ふりがな/, "name"],
  [/生年月日|誕生日/, "birth"],
  [/住所|郵便番号|所在地/, "address"],
  [/マイナンバー|個人番号|口座番号|カード番号|旅券/, "id_number"],
];

/** The kind of personal data a column's name says it holds, if any. A bare "name" is not one: products have names. */
export function nameKind(column: string): string | undefined {
  for (const [re, kind] of JA) if (re.test(column)) return kind;
  const w = words(column);
  const has = (...any: string[]) => any.some((x) => w.includes(x));
  const pair = (a: string, b: string) => w.some((x, i) => x === a && w[i + 1] === b);
  if (
    has("ssn", "passport", "iban", "cvv", "mynumber", "cardnumber", "creditcard") ||
    pair("card", "number") || pair("card", "no") || pair("credit", "card") || pair("national", "id") || pair("tax", "id") || pair("my", "number")
  ) {
    return "id_number";
  }
  if (w.some((x) => ABOUT.has(x))) return undefined;
  if (has("email", "mail", "emailaddress") || pair("e", "mail")) return "email";
  if (has("phone", "telephone", "tel", "mobile", "fax", "phonenumber", "mobilephone", "telno", "cellphone")) return "phone";
  if (
    has("firstname", "lastname", "fullname", "surname", "username") ||
    w.some((x, i) => x === "name" && (PERSON.has(w[i - 1] ?? "") || PERSON.has(w[i + 1] ?? "")))
  ) {
    return "name";
  }
  if (has("birth", "birthday", "birthdate", "dob", "dateofbirth")) return "birth";
  if (has("address", "addr", "street", "zip", "zipcode", "postal", "postcode", "postalcode", "streetaddress")) return "address";
  return undefined;
}

// An email address is found from its "@" outward, so a long run of letters without one costs one pass
// (a plain regex would retry it from every position, which a cell of megabytes turns into minutes).
const LOCAL = /[\p{L}\p{N}._%+-]/u;
const DOMAIN = /[\p{L}\p{N}.-]/u;
const TLD = /\.\p{L}{2,}$/u;
// "icon@2x.png" names an image size, not a mailbox.
const SCALE = /^\d+(\.\d+)?x\./;

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
    const domain = text.slice(at + 1, end);
    if (start === at || !TLD.test(domain) || SCALE.test(domain)) continue;
    out += text.slice(from, start) + mask("email");
    found.add("email");
    from = end;
    at = end - 1;
  }
  return out + text.slice(from);
}

// An international number (+81 90-1234-5678, +819012345678), a Japanese number written without
// separators (09012345678), or three groups split by hyphens or dots ((555) 123-4567, 03-1234-5678,
// 555.123.4567). Groups split by spaces only are not read as one: those are lists of numbers and
// coordinates far more often. A date (2026-10-22) has a last group too short to match, and a code
// that continues with a hyphen (SKU-123-456-7890) is not a number on its own.
const PHONE =
  /(?<![\w+\-.])(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){1,3}|0\d{9,10}|(?:\(\d{2,4}\)\s?|\d{2,4}-)\d{2,4}-\d{4}|\d{3}\.\d{3}\.\d{4})(?![\w-]|\.\d)/g;
// Separated in groups (4111 1111 1111 1111, 3782-822463-10005), or 15 to 16 digits in a row that
// start like a card does. A long run of digits is more often an id or a time in milliseconds.
const CARD = /(?<![\d-])(?:\d{4}(?:[ -]\d{4}){3}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{4,5}|[3-6]\d{14,15})(?![\d-])/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function maskShapes(text: string, found: Set<string>): string {
  let out = maskEmails(text, found);
  // Card numbers before phones, so a spaced card number is not read as phone groups.
  out = out.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? (found.add("card"), mask("card")) : m));
  out = out.replace(PHONE, (m) => ((m.match(/\d/g)?.length ?? 0) >= 9 ? (found.add("phone"), mask("phone")) : m));
  return out;
}

/**
 * Hides the parts of a text that are shaped like personal data; `found` collects their kinds.
 * Full-width digits and "＠" are read as their ASCII forms; a text in which that finds more is
 * shown in those forms.
 */
export function maskText(text: string, found: Set<string>): string {
  const plain = new Set<string>();
  const out = maskShapes(text, plain);
  const hidden = (s: string) => s.split("«masked:").length;
  if (/[^ -~\s]/.test(text)) {
    const wide = new Set<string>();
    const folded = maskShapes(text.normalize("NFKC"), wide);
    if (hidden(folded) > hidden(out)) {
      for (const k of wide) found.add(k);
      return folded;
    }
  }
  for (const k of plain) found.add(k);
  return out;
}

const ORDER = ["email", "phone", "card"];
// Shapes first in a fixed order, then the kinds that nested field names gave.
const sorted = (kinds: Set<string>) => [...ORDER.filter((k) => kinds.has(k)), ...[...kinds].filter((k) => !ORDER.includes(k)).sort()];

/** Whether a column's values can hold text, so their shape means something (a timestamp or a BIGINT arrives as a string too). */
export const holdsText = (type: string): boolean =>
  !/^(BOOLEAN|U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|INT\d*|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|DATE|TIME|TIMESTAMP|INTERVAL|UUID)\b/i.test(type);

// A nested value (LIST, STRUCT, MAP, JSON) is walked: a field named like personal data is hidden whole.
function maskValue(value: unknown, found: Set<string>): unknown {
  // A JSON value (a JSON column, or JSON inside a LIST or STRUCT) arrives as text.
  if (typeof value === "string") return /^\s*[{[]/.test(value) ? maskJson(value, found) : maskText(value, found);
  if (Array.isArray(value)) return value.map((v) => maskValue(v, found));
  if (value !== null && typeof value === "object") {
    // A MAP arrives as a list of { key, value } entries: the entry's key names the value.
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).length === 2 && typeof entry.key === "string" && "value" in entry) {
      const kind = nameKind(entry.key);
      if (kind && entry.value !== null && entry.value !== undefined) {
        found.add(kind);
        return { key: maskText(entry.key, found), value: mask(kind) };
      }
      return { key: maskText(entry.key, found), value: maskValue(entry.value, found) };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        const kind = nameKind(key);
        if (kind && v !== null && v !== undefined) {
          found.add(kind);
          return [maskText(key, found), mask(kind)];
        }
        return [maskText(key, found), maskValue(v, found)];
      }),
    );
  }
  return value;
}

// Text that parses as JSON has its fields walked like a STRUCT's. Writing it out again would change
// what nothing was hidden in (big numbers, 1.0, spacing), so it is rewritten only when the walk hid
// something; otherwise its shapes are masked in place.
function maskJson(text: string, found: Set<string>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return maskText(text, found);
  }
  const walked = new Set<string>();
  const shown = maskValue(parsed, walked);
  if (!walked.size) return maskText(text, found);
  for (const k of walked) found.add(k);
  return JSON.stringify(shown);
}

// The keys in a nested value written out as text, as the card's min and max are: {'a': 1} (STRUCT),
// {a=1} (MAP, whose keys are bare and may hold spaces) and {"a":1} (JSON). A key runs from a "{" or
// "," to the next ":" or "="; read in one pass, so a long value cannot make the search slow.
const nested = (type: string): boolean => /^(STRUCT|MAP|UNION|JSON)\b/i.test(type) || /\]$/.test(type);

/** The kind a nested value's text gives away by a key named like personal data, if any. */
export function keyKind(text: string, type: string): string | undefined {
  if (!nested(type)) return undefined;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" || c === ",") start = i + 1;
    else if ((c === ":" || c === "=") && start >= 0) {
      const kind = nameKind(text.slice(start, i).trim().replace(/^(['"])([\s\S]*)\1$/, "$2"));
      if (kind) return kind;
      start = -1;
    }
  }
  return undefined;
}

/**
 * Masks rows for display. `types` maps a column to its SQL type; values are read for their shape
 * only in columns that can hold text. Returns the rows and, in column order, what was hidden.
 */
export function maskRows(rows: Record<string, unknown>[], types: Map<string, string>): { rows: Record<string, unknown>[]; masked: Masked[] } {
  const byName = new Map<string, string>();
  for (const column of types.keys()) {
    const kind = nameKind(column);
    if (kind) byName.set(column, kind);
  }
  const hiddenByName = new Set<string>();
  const byValue = new Map<string, Set<string>>();
  const masked = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => {
        if (value === null || value === undefined) return [column, value];
        const kind = byName.get(column);
        if (kind) {
          hiddenByName.add(column);
          return [column, mask(kind)];
        }
        if (!holdsText(types.get(column) ?? "")) return [column, value];
        const found = byValue.get(column) ?? new Set<string>();
        const shown = maskValue(value, found);
        if (found.size) byValue.set(column, found);
        return [column, shown];
      }),
    ),
  );
  const columns = [...types.keys()];
  return {
    rows: masked,
    masked: [
      ...columns.filter((c) => hiddenByName.has(c)).map((c): Masked => ({ column: c, position: columns.indexOf(c) + 1, kinds: [byName.get(c)!], by: "name" })),
      ...columns.filter((c) => byValue.has(c)).map((c): Masked => ({ column: c, position: columns.indexOf(c) + 1, kinds: sorted(byValue.get(c)!), by: "value" })),
    ],
  };
}

export { sorted as orderKinds };

// A column name is source text, and the note sits outside the data block: only a name that is one
// plain word is repeated there (a line break could forge the end of the block, and spaces could
// carry a sentence); any other column is named by its place.
const PLAIN = /^[\p{L}\p{N}_.-]{1,64}$/u;

/** The note that says what was hidden: `what` names the hidden things ("values", "min, max and avg values"). */
export function maskedNote(masked: Masked[], what: string): string[] {
  if (!masked.length) return [];
  const list = masked.map((m) => `${PLAIN.test(m.column) ? m.column : (m.position ? `column ${m.position}` : "a column with an unusual name")} (${m.kinds.join(", ")}, by ${m.by === "name" ? "column name" : "value"})`).join(", ");
  return [`MASKED: ${what} that look like personal data are hidden: ${list}. Whoever runs fusenduck can show them with --unmask.`];
}
