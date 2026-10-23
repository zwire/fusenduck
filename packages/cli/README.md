# @fusenduck/cli

CLI `fusen`。まだ公開していないので、リポジトリから `node packages/cli/src/index.ts` で実行します。

```
fusen card <file.parquet>
fusen peek <file.parquet> [--rows <n>]
fusen ref <file.parquet> [--query <select over data>] [--where <predicate>] [--columns a,b]
fusen resolve <ref> [--limit <n>] [--root <dir>]...
fusen --help | --version
```

| コマンド | 出すもの |
| --- | --- |
| `card` | data card。行の値は出さない |
| `peek` | カード、最初の `--rows` 行(既定 5、最大 50)、ファイル全体の Ref |
| `ref` | 選択を表す `fusen://` の Ref。`--query` はファイルを `data` という表として読む単一の SELECT |
| `resolve` | Ref の行(既定 100 行まで)。データが変わっていたら行を返さず `DATA_CHANGED`。開けるのは `--root` の下だけ(既定はカレントディレクトリ) |

成功すると結果を標準出力に出して exit 0(`DATA_CHANGED` の結果も 0)、失敗すると `fusen: <理由>` を標準エラーに出して exit 1、コマンドラインの誤りは理由と使い方を出して exit 2 です。自分で書いた `--where` や `--query` の書き間違い(存在しない列など)は、そのまま理由に出ます。エンジンのエラー文はセルの値を含みうるので既定では伏せます。`FUSEN_DEBUG=1` で詳細を表示します。

詳しくは [docs/guide.md](../../docs/guide.md)。
