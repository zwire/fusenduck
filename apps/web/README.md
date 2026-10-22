# @fusenduck/web

Web UI `fusen-web`。ループバックで待ち受けるローカルサーバーが、SPA と小さな JSON API を同じオリジンで配ります。設計は [ADR 0002](../../docs/adr/0002-web-ui-transport.md)、使い方は [docs/guide.md](../../docs/guide.md) の 9 章にあります。

```sh
pnpm build   # SPA(spa/*.ts)を tsc で dist/ に出す
node apps/web/src/index.ts [--root <dir>]... [--host <loopback>] [--port <n>] [--no-open]
# → fusen-web: opening http://127.0.0.1:<port>/#c=<code> in your browser (the link works once, within 60 seconds)
```

## 構成

| ファイル | 中身 |
| --- | --- |
| `src/index.ts` | 起動の入口(引数の解釈、URL の表示とブラウザの起動、終了時にエンジンを閉じる) |
| `src/browser.ts` | 既定のブラウザで URL を開く(`open` / `rundll32` / `xdg-open`、シェルを通さない。ディスプレイがなければ開かない) |
| `src/server.ts` | HTTP: 引き換えコードとトークン、Host・Origin・JSON・Bearer の検査、CSP などのヘッダ、静的ファイル |
| `src/files.ts` | ルートの下の Parquet ファイルの一覧(シンボリックリンクはたどらない、隠しファイルは飛ばす、件数に上限) |
| `src/view.ts` | 開いた 1 ファイル: エンジン(1 ソース 1 つ、操作は 1 つずつ)、行のページ(条件つきも)、位置の範囲・条件・列から Ref |
| `spa/api.ts` | SPA から core への呼び先。`Api` を差し替えれば、ローカルサーバー以外(VS Code の webview など)からも使える |
| `spa/app.ts` | ファイルの一覧と絞り込み、表、列のチェック、行の条件、選択、Copy。値は `textContent` でだけ DOM に入れる |

## API(内部用、版なし)

すべて `POST`、本文は JSON、`/api/session` 以外は `Authorization: Bearer <token>` が要ります。

| パス | 本文 | 返すもの |
| --- | --- | --- |
| `/api/session` | `{ code }` | `{ token }`。コードは 1 回だけ、60 秒まで |
| `/api/files` | `{}` | `{ roots: [{ root, files: [{ path, name, size, modified }], truncated }], truncated }`。name はルートからの `/` 区切りのパス、path は開くときに渡すパス |
| `/api/open` | `{ path }` | `{ source, fingerprint, card, ref, selectable }` |
| `/api/rows` | `{ source, fingerprint, offset, limit?, where? }` | `{ rows: [{ pos, cells }], next, cut, matched }`。limit は 1〜500(既定 100)。`where` があれば合う行だけで、`offset` と `next` は位置(位置で選べないファイルでは合う行の中の順番)、`matched` は合う行の数 |
| `/api/ref` | `{ source, fingerprint, ranges: [[a, b], ...], where?, columns? }` | `{ ref }`。範囲は結合して 1,000 個まで。範囲と `where` の両方があれば両方に合う行、範囲が空なら `where` の行。`where` に表を読む関数と `*`・`COLUMNS(*)` は使えない。`columns` はファイルの列の順に並べ直し、全部なら `cols=` を付けない |

ファイルが開いたときから変わっていれば `409` と `{ error, changed: true }` を返します。エラー文は core が組み立てたものだけで、エンジンのエラー文は伏せます。
