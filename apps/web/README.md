# @fusenduck/web

Web UI `fusen-web`。ループバックで待ち受けるローカルサーバーが、SPA と小さな JSON API を同じオリジンで配ります。設計は [ADR 0002](../../docs/adr/0002-web-ui-transport.md)、使い方は [docs/guide.md](../../docs/guide.md) の 9 章にあります。

```sh
pnpm build   # SPA(spa/*.ts)を tsc で dist/ に出す
node apps/web/src/index.ts [--root <dir>]... [--host <loopback>] [--port <n>]
# → fusen-web: open this URL within 60 seconds (it works once): http://127.0.0.1:<port>/#c=<code>
```

## 構成

| ファイル | 中身 |
| --- | --- |
| `src/index.ts` | 起動の入口(引数の解釈、URL の表示、終了時にエンジンを閉じる) |
| `src/server.ts` | HTTP: 引き換えコードとトークン、Host・Origin・JSON・Bearer の検査、CSP などのヘッダ、静的ファイル |
| `src/view.ts` | 開いた 1 ファイル: エンジン(1 ソース 1 つ、操作は 1 つずつ)、行のページ、位置の範囲から Ref |
| `spa/api.ts` | SPA から core への呼び先。`Api` を差し替えれば、ローカルサーバー以外(VS Code の webview など)からも使える |
| `spa/app.ts` | 表、選択、Copy。値は `textContent` でだけ DOM に入れる |

## API(内部用、版なし)

すべて `POST`、本文は JSON、`/api/session` 以外は `Authorization: Bearer <token>` が要ります。

| パス | 本文 | 返すもの |
| --- | --- | --- |
| `/api/session` | `{ code }` | `{ token }`。コードは 1 回だけ、60 秒まで |
| `/api/open` | `{ path }` | `{ source, fingerprint, card, ref, selectable }` |
| `/api/rows` | `{ source, fingerprint, offset, limit? }` | `{ rows: [{ pos, cells }], next, cut }`。limit は 1〜500(既定 100) |
| `/api/ref` | `{ source, fingerprint, ranges: [[a, b], ...] }` | `{ ref }`。範囲は結合して 1,000 個まで |

ファイルが開いたときから変わっていれば `409` と `{ error, changed: true }` を返します。エラー文は core が組み立てたものだけで、エンジンのエラー文は伏せます。
