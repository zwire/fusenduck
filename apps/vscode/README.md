# fusenduck for VS Code

`.parquet` ファイルを VS Code で開くと、Web UI(`apps/web`)と同じ画面のエディターが開きます。行を選んで Copy すると、選んだ行だけを返す Ref がクリップボードに入ります。設計は [ADR 0002](../../docs/adr/0002-web-ui-transport.md)、使い方は [docs/guide.md](../../docs/guide.md) の 9 章にあります。

```sh
pnpm build                                          # dist/ に拡張と webview を出す
code --extensionDevelopmentPath="$PWD/apps/vscode"  # 開発用に読み込む
```

## 構成

| ファイル | 中身 |
| --- | --- |
| `src/extension.ts` | 読み取り専用のカスタムエディター(`*.parquet`)。webview を作り、メッセージをホストに渡す |
| `src/host.ts` | webview からのメッセージ(`init`、`open`、`rows`、`ref`、`copy`)に答える。`apps/web` の `View` を使い、開けるのはそのエディターのファイルだけ |
| `src/html.ts` | Web UI の `index.html` に webview 用の CSP と nonce を入れる |
| `webview/main.ts` | Web UI の SPA を、ホストへのメッセージで動く `Api` で起動する |
| `webview/vscode.css` | VS Code のテーマの色とフォント |
| `build.ts` | esbuild で `dist/extension.cjs`(ホスト。DuckDB はネイティブなので外に置く)と `dist/webview.js` を作り、`index.html` と `style.css` を写す |

拡張のホストは TypeScript をそのまま動かせないので、ホスト側だけ esbuild でまとめます。SPA 自体(`apps/web/spa`)は変えずに再利用します。

`dist/extension.cjs` は実行時に `@duckdb/node-api`(ネイティブ)を隣の `node_modules` から読みます。vsce で `.vsix` にまとめるときは、この依存を各 OS のバイナリごと含める手当てが要ります(公開の段階で決めます)。
