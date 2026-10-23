import { keyKind } from "../../packages/core/src/pii.ts";
for (const n of [1e4, 1e5]) { const s = "{" + " ".repeat(n) + "x"; const t = Date.now(); keyKind(s, "MAP(VARCHAR, VARCHAR)"); console.log(n, Date.now() - t, "ms"); }
