// A minimal frontmatter parser.
// Supports the restricted YAML subset vajra emits and reports everything else as a
// problem instead of guessing:
//   key: scalar                 key: [a, b]            key: "quoted # not a comment"
//   key: >                      key:                   key:
//     folded text                 - k: v                 nested: scalar
//                                   k2: >
//                                     folded text
//                                 - plain item
// Plain scalars may continue on more-indented lines; ` #` starts a comment in plain scalars.
const KV = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/;
const BLOCK = /^[>|][+-]?$/;

function scalar(v) {
  v = v.trim();
  if (v === "") return "";
  const q = v[0];
  if (q === '"' || q === "'") {
    const close = v.indexOf(q, 1);
    if (close > 0) return v.slice(1, close);
  }
  v = v.replace(/\s+#.*$/, "");
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((s) => scalar(s));
  }
  return v;
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: null, body: text, problems: [] };
  const lines = m[1].split(/\r?\n/);
  const problems = [];
  const bad = (i, why) => problems.push(`frontmatter line ${i + 2}: ${why}: "${lines[i].trim().slice(0, 60)}"`);

  const entries = [];
  lines.forEach((l, i) => {
    if (l.trim() === "" || /^\s*#/.test(l)) return;
    const lead = l.match(/^\s*/)[0];
    if (lead.includes("\t")) { bad(i, "tabs are not allowed for indentation"); return; }
    entries.push({ i, ind: lead.length, t: l.trim() });
  });

  const start = (key, v, i) => (BLOCK.test(v) ? { key, i, mode: v[0], parts: [] } : { key, i, mode: v === "" ? "empty" : "plain", parts: v === "" ? [] : [v] });
  const finish = (p, nested) => {
    if (p.mode === "|") return p.parts.map((x) => x.t).join("\n");
    if (p.mode === ">") return p.parts.map((x) => x.t).join(" ");
    if (p.mode === "empty") return p.parts.length ? nested(p) : "";
    return p.parts.length === 1 ? scalar(p.parts[0]) : p.parts.map((x) => (typeof x === "string" ? x : x.t)).join(" ");
  };

  function readMap(group, keyCol, where, allowNested) {
    const obj = {};
    let pend = null;
    const nested = (p) => {
      if (!allowNested) { bad(p.i, `nested structure under "${p.key}" is not supported`); return ""; }
      const first = p.parts[0];
      return /^-(\s|$)/.test(first.t) ? readList(p.parts) : readMap(p.parts, first.ind, `"${p.key}"`, false);
    };
    const flush = () => { if (pend) { obj[pend.key] = finish(pend, nested); pend = null; } };
    for (const e of group) {
      const kv = e.t.match(KV);
      if (e.ind === keyCol && kv) {
        flush();
        if (Object.hasOwn(obj, kv[1])) bad(e.i, `duplicate key "${kv[1]}"`);
        pend = start(kv[1], (kv[2] ?? "").trim(), e.i);
      } else if (pend && e.ind > keyCol) {
        pend.parts.push(e);
      } else bad(e.i, `not understood in ${where}`);
    }
    flush();
    return obj;
  }

  function readList(group) {
    const dash = group[0].ind;
    const items = [];
    let cur = null;
    const close = () => {
      if (!cur) return;
      if (cur.map) items.push(readMap(cur.lines, cur.keyCol ?? 0, "list item", false));
      else items.push(cur.lines.length ? [cur.value, ...cur.lines.map((e) => e.t)].join(" ") : scalar(cur.value));
      cur = null;
    };
    for (const e of group) {
      if (e.ind === dash && /^-(\s|$)/.test(e.t)) {
        close();
        const after = e.t.slice(1).trimStart();
        const col = e.ind + (e.t.length - after.length);
        if (after === "") cur = { map: true, lines: [], keyCol: null };
        else if (KV.test(after) && !/^["']/.test(after)) cur = { map: true, lines: [{ i: e.i, ind: col, t: after }], keyCol: col };
        else cur = { map: false, value: after, lines: [] };
      } else if (cur && e.ind > dash) {
        if (cur.map && cur.keyCol === null) cur.keyCol = e.ind;
        cur.lines.push(e);
      } else bad(e.i, "expected a `- ` list item");
    }
    close();
    return items;
  }

  // Top level: every entry at indent 0 must be `key: ...`.
  const top = [];
  for (const e of entries) {
    if (e.ind === 0 && !KV.test(e.t)) { bad(e.i, "expected `key: value` at the top level"); continue; }
    top.push(e);
  }
  const data = readMap(top, 0, "the top level", true);
  problems.sort((a, b) => parseInt(a.slice(17)) - parseInt(b.slice(17)));
  return { data, body: text.slice(m[0].length), problems };
}

export function sections(body) {
  const out = new Map();
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { current = h[1]; out.set(current, []); continue; }
    if (current) out.get(current).push(line);
  }
  return out;
}
