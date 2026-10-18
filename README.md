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
```
