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
node packages/cli/src/index.ts ref data.parquet --where "region = 'south'"
node packages/cli/src/index.ts resolve '<上で出た Ref>' [--root <dir>]
```

Ref は自分でファイルの場所を持つので、`resolve` は `--root` で許可したディレクトリの下のファイルだけを開きます(既定はカレントディレクトリ)。

TypeScript は Node の型除去で直接実行します(ビルド工程はまだありません)。決定の経緯は [docs/adr](docs/adr/0001-engine-ref-rendering.md) を参照。
