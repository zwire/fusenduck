# fusenduck for VS Code

`.parquet` ファイルを開くと、表を見ながら行を選び、選んだ行だけを返す **Ref** をコピーできるエディターが開きます。Ref は `fusen://` で始まる 1 本の文字列で、AI エージェントは `fusen resolve` や MCP サーバー(`fusen_resolve`)でそのまま同じ行を取り出せます。画面は fusenduck の Web UI と同じです。

ステータス: 実験的(0.0.0、Marketplace と Open VSX には未公開)。

## 使い方

1. エクスプローラーで `.parquet` ファイルを開きます(ダブルクリックで fusenduck のエディターになります。別のビューアーで開きたいときは、右クリックの「Open With…」)。
2. 上にカード(行数、列の型、null 率、min/max)、下に 100 行ずつの表が出ます。`#` はファイル内の位置(0 から)です。
3. 行を選びます。クリックで 1 行、Shift+クリックで範囲、Ctrl(⌘)+クリックで追加と取り消し。ページをまたいでも選べます。
4. 必要なら絞ります。カードの列のチェックを外すとその列を Ref から外し、Filter rows 欄に SQL の条件(`region = 'south' AND amount > 500` など)を入れて Enter で、条件に合う行だけにします。
5. **Copy** を押すと Ref がクリップボードに入ります。何も選ばなければ、ファイル全体(条件があれば条件に合う行)の Ref です。

ファイルが書き換わったら、上の **Reload** で読み直します。開いたあとにファイルが変わると、Ref を作らずに「The file changed since it was opened. Open it again.」と出ます(見たものと違う行を指す Ref は作りません)。

## コマンドと設定

| コマンド | すること |
| --- | --- |
| `fusenduck: Show Log` | 出力パネルの fusenduck のログを開きます。エラーの種類(`Conversion Error` など)とスタックの行がここに出ます |

設定項目はありません。

## うまくいかないとき

- **「Details are withheld because they can contain values from the source.」と出る**: エンジンのエラー文はセルの値を含みうるので、画面には出しません。ログ(`fusenduck: Show Log`)にはセルの値を載せず、エラーの種類とスタックの行だけを書きます。メッセージまで見たいときは、環境変数 `FUSEN_DEBUG=1` を付けて VS Code を起動します(メッセージにはセルの値が入りえます)。
- **「fusenduck could not load its DuckDB engine.」と出る**: 拡張に入っている DuckDB が、この OS と CPU 向けではありません。いまの環境向けのビルドを入れ直し、ウィンドウを再読み込み(`Developer: Reload Window`)します。理由はログにあります。
- **「fusenduck opens files on this computer's disk only.」と出る**: Git の差分の左側など、ディスク上のファイルではないものは開けません。エクスプローラーからファイルを開きます。
- **Filter rows の理由**: 列名の打ち間違いなどは理由をそのまま表示し、それまでの表と条件は残ります。表を読む関数(`read_csv` など)、`*`、`COLUMNS(*)` は使えません。

## 守り

- 読み取り専用です。エンジン(DuckDB)が読めるのは開いたファイルのフォルダーだけで、外部アクセスとディスクへの書き出しを止めています。
- ポートを開きません。画面(webview)は拡張とメッセージでだけやり取りします。webview の CSP は、スクリプトをページごとの nonce 付きのものだけ、スタイルを拡張自身のファイルだけに絞り、通信をすべて止めています。
- セルの値は文字列としてだけ表示します。Copy でクリップボードに入れられるのは Ref だけです。
- ワークスペースを信頼していない(Restricted Mode)ときも動きます。拡張はワークスペースの設定やスクリプトを読まず、ファイルを読み取り専用で開くだけだからです。

## 対応プラットフォーム

DuckDB はネイティブのライブラリなので、`.vsix` は VS Code のプラットフォームごとに分かれます: `win32-x64`、`win32-arm64`、`darwin-x64`、`darwin-arm64`、`linux-x64`、`linux-arm64`、`alpine-x64`、`alpine-arm64`。VS Code 1.95 以降。

## 開発

リポジトリの直下で:

```sh
pnpm install
pnpm build                                              # apps/vscode/dist に拡張、webview、この OS 向けの DuckDB を出す
code --extensionDevelopmentPath="$PWD/apps/vscode"      # 拡張を読み込んだ VS Code を開く
pnpm --filter fusenduck package                         # apps/vscode/out/fusenduck-<target>-<version>.vsix を作る
pnpm --filter fusenduck package --target win32-x64   # 別のプラットフォーム向け(DuckDB はレジストリから取り、pnpm-lock.yaml の integrity と照合)
node apps/vscode/smoke.ts apps/vscode/out/fusenduck-linux-x64-0.0.0.vsix  # .vsix を展開して読み込み、ファイルを開けるか確かめる
code --install-extension apps/vscode/out/fusenduck-linux-x64-0.0.0.vsix   # 作った .vsix を入れる
```

別のプラットフォーム向けに `package` したあとは `dist/native` がそのプラットフォームの DuckDB になっているので、開発に戻るときは `pnpm build` を流し直します。

| ファイル | 中身 |
| --- | --- |
| `src/extension.ts` | 読み取り専用のカスタムエディター(`*.parquet`)と `fusenduck: Show Log`。DuckDB は最初のエディターで読み込み、読み込めなければそのエディターに理由を出す |
| `src/host.ts` | webview からのメッセージ(`init`、`open`、`rows`、`ref`、`copy`)に答える。`apps/web` の `View` を使い、開けるのはそのエディターのファイルだけ |
| `src/html.ts` | Web UI の `index.html` に webview 用の CSP と nonce を入れる。開けないときのメッセージのページ |
| `webview/main.ts` | Web UI の SPA を、ホストへのメッセージで動く `Api` で起動する |
| `webview/vscode.css` | VS Code のテーマの色とフォント |
| `build.ts` | esbuild でホスト側(core、Web UI の `View`、DuckDB の JavaScript)を `dist/extension.cjs` に 1 本にまとめ、`dist/webview.js` を作る。DuckDB のネイティブ部分は `dist/native` に置く |
| `engine.ts` | VS Code のプラットフォームと DuckDB のバイナリの対応。バイナリを `dist/native` に置く |
| `package.ts` | `dist` と README、LICENSE だけを別のフォルダーに並べ、vsce で `.vsix` にする |
| `smoke.ts` | `.vsix` を、VS Code の代わりの小さな `vscode` モジュールで読み込んで動かす |

設計は [ADR 0002](../../docs/adr/0002-web-ui-transport.md)、Ref と条件の詳しい扱いは [docs/guide.md](../../docs/guide.md) にあります。
