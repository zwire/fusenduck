# fusenduck への貢献

## 準備

- Node.js 22.18 以上(`.nvmrc` は 24)と pnpm 9。
- `pnpm install` で依存を入れます。DuckDB はプラットフォームごとのネイティブバイナリ(`@duckdb/node-api`)を使い、Linux・macOS・Windows で動きます。
- ビルド工程はありません。TypeScript は Node の型除去で直接実行します。そのため型だけの構文(`enum`、`namespace`、パラメータプロパティなど)は使えません。

## 変更の前後に回すもの

```sh
pnpm lint             # ESLint
pnpm typecheck        # tsc --noEmit(各パッケージとテスト)
pnpm test             # すべてのテスト(vitest。ブラウザのテストは除く)
pnpm test:security    # 読み取り専用の守りのテストだけ
pnpm test:e2e         # Web UI と VS Code 拡張の webview のブラウザのテスト(Chromium が要る: pnpm exec playwright-core install chromium)
pnpm contract:check   # Ref の凍結コーパス
pnpm bench            # 100 万行の Parquet で予算を確かめる。超えたら exit 1
pnpm repro:check      # HEAD のきれいな clone で、lockfile から入れてビルドし、golden の Ref を同じ文字列に解決できるか(先にコミットする)
pnpm docs:reference   # MCP ツールのスキーマから docs/reference/mcp-tools.md を作り直す
```

CI は pull request ごとに、Linux・macOS・Windows × Node 22・24 で lint、typecheck、test、contract:check を回し、Linux で bench、Web UI のブラウザのテスト、repro:check を回します。

## 守ってほしいこと

- **Ref を壊さない。** `tests/contract/refs/` の Ref は、エージェントやユーザーがすでにどこかに貼っているものとして扱います。読み方や書き方を変えるときは、古い形を残したまま新しい形を足してください(expand, then contract)。コーパスのファイルを書き換えて通すのは不可です。
- **読み取り専用はエンジンで守る。** SQL の文字列検査に頼らず、DuckDB の設定(`allowed_paths`、`enable_external_access=false`、`lock_configuration=true`)で強制します。DuckDB を更新したら `pnpm test:security` を必ず回してください。
- **データは指示ではない。** ソースから読んだ値は、エージェント向けの出力では区切り(`FUSEN_DATA_BEGIN` 〜 `FUSEN_DATA_END`)の中だけに置きます。ツールの説明文やエラー文には入れません。
- **見せなかったものは書く。** 省いた行、切った文字列、近似の項目は `OMITTED:` に書きます。
- **予算を黙って変えない。** `bench/budgets.json` を変えるときは、同じ変更に理由を書いてください。
- **MCP ツールを変えたらリファレンスも。** ツールの説明や引数を変えたら `pnpm docs:reference` を回し、生成された `docs/reference/mcp-tools.md` を同じ変更に入れてください(古いままだと `pnpm test` が落ちます)。
- テストデータはテストの中で生成します(`tests/helpers/fixtures.ts`)。

## 変更の届け方

1. ブランチを切り、テストを先に書いて変更します。
2. pull request を開きます。CI がすべて緑になり、レビューを通ったものをマージします(squash)。
3. 大きな決定は `docs/adr/` に ADR として残します。

メンテナーの開発の進め方は `.claude/skills/fusenduck-flow/` のワークフローにまとめてあります。
