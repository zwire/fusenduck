# fusenduck

ゼロ設定・読み取り専用でテーブル/ファイルデータを覗き、見たものをそのままAIエージェントのコンテキスト(Ref/クエリ)として渡せる、IDE非依存のデータ参照レイヤー。データの一部に「付箋」を貼って渡すイメージ。CLIコマンドは `fusen`。

構想は [docs/vision.md](docs/vision.md) を参照。ステータス: 構想段階。開発の進め方は [.claude/skills/fusenduck-flow](.claude/skills/fusenduck-flow/SKILL.md) のワークフローに従う。

fusenduck は独立したプロジェクトで、DuckDB プロジェクトおよび DuckDB Foundation とは提携関係にありません。

## 構成

```
packages/
  core/   エンジン、Refモデル、プロトコル
  cli/    CLI / TUI クライアント
  mcp/    MCP サーバ
```

## 開発

要件: Node.js >= 22(`.nvmrc` は 24)、pnpm 9。

```sh
pnpm install
pnpm typecheck
pnpm test
```

最初のスライス(Parquet を 1 つ開く、data card、Ref の作成と解決)は次のように試せます。

```sh
node packages/cli/src/index.ts card data.parquet
# カード、最初の数行、ファイル全体を指す Ref を 1 回で
node packages/cli/src/index.ts peek data.parquet [--rows 5]
node packages/cli/src/index.ts ref data.parquet --where "region = 'south'"
# ファイルを `data` という名前で読む SELECT を持たせることもできます
node packages/cli/src/index.ts ref data.parquet --query "SELECT region, sum(amount) AS total FROM data GROUP BY region" --where "total > 0"
node packages/cli/src/index.ts resolve '<上で出た Ref>' [--root <dir>]
```

Ref は自分でファイルの場所を持つので、`resolve` は `--root` で許可したディレクトリの下のファイルだけを開きます(既定はカレントディレクトリ)。

エージェントからは MCP サーバー経由で同じ操作(`fusen_card`、`fusen_peek`、`fusen_ref`、`fusen_resolve`)を呼べます。読めるファイルは `--root` の下だけです。

```sh
node packages/mcp/src/index.ts --root /path/to/data
```

TypeScript は Node の型除去で直接実行します(ビルド工程はまだありません)。決定の経緯は [docs/adr](docs/adr/0001-engine-ref-rendering.md) を参照。
