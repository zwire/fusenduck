# @fusenduck/mcp

MCP サーバー `fusen-mcp`。まだ公開していないので、リポジトリから `node packages/mcp/src/index.ts` で実行します。

```
fusen-mcp [--root <dir>]... [--http [--host <loopback>] [--port <n>]]
fusen-mcp --help
```

コマンドラインの誤りは exit 2、サーバーが起動できなかったとき(ポートが使用中など)は exit 1 です。

## ツール

引数の型と範囲の一覧は、スキーマから生成した [docs/reference/mcp-tools.md](../../docs/reference/mcp-tools.md) にあります。

| ツール | 引数 | 内容 |
| --- | --- | --- |
| `fusen_card` | `path` | data card。行の値は返さない |
| `fusen_peek` | `path`, `rows?`(0〜50、既定 5) | カード、最初の行、ファイル全体の Ref |
| `fusen_ref` | `path`, `query?`, `where?`, `columns?` | 選択を表す `fusen://` の Ref |
| `fusen_resolve` | `ref`, `limit?`(0〜1000、既定 100) | Ref の行。データが変わっていたら `DATA_CHANGED` |

読めるファイルは `--root` の下だけです(既定はカレントディレクトリ、複数指定可)。ツールの説明文は固定で、データはツールの結果の区切りの中にだけ出ます。エンジンのエラー文は伏せ、標準エラーにはエラーの種類と発生箇所だけを書きます(セルの値を含みうる全文は `FUSEN_DEBUG=1` のときだけ)。

## stdio

```sh
node packages/mcp/src/index.ts --root /path/to/data
```

## HTTP(Streamable HTTP)

```sh
FUSEN_MCP_TOKEN=<16 文字以上> node packages/mcp/src/index.ts --http --port 7457 --root /path/to/data
# → http://127.0.0.1:7457/mcp
```

- 待ち受けはループバック(`127.0.0.1`、`::1`、`localhost`)だけ。既定は `127.0.0.1:7457`。
- すべての要求に `Authorization: Bearer <token>` が要ります。`FUSEN_MCP_TOKEN` がなければ起動時に生成して標準エラーに表示します。
- `Host` ヘッダーも確かめ、DNS リバインディングを防ぎます。

詳しくは [docs/guide.md](../../docs/guide.md)。
