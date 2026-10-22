# fusenduck

ゼロ設定・読み取り専用でテーブル/ファイルデータを覗き、見たものをそのまま AI エージェントのコンテキスト(Ref/クエリ)として渡せる、IDE 非依存のデータ参照レイヤー。データの一部に「付箋」を貼って渡すイメージ。CLI コマンドは `fusen`。

ステータス: 実験的(0.0.0、未公開)。対応するソースは Parquet ファイルだけです。

fusenduck は独立したプロジェクトで、DuckDB プロジェクトおよび DuckDB Foundation とは提携関係にありません。

## いまできること

- **カード** `fusen card`: 行数、型、null 率、min/max、おおよその distinct 数。行の値は見せない。
- **peek** `fusen peek`: カード、最初の数行、ファイル全体の Ref を 1 回で。
- **Ref** `fusen ref`: 見た範囲(述語、列、集計の SELECT)を `fusen://` の 1 本の文字列に。セッション不要で、貼り付けておけば誰でも同じ行を取り出せる。
- **resolve** `fusen resolve`: Ref から行を返す。データが変わっていたら行を返さず `DATA_CHANGED` を返す。
- **位置で選ぶ**: キー列のない表は `file_row_number` で行を選べる。
- **あいまいの明示**: 同じ行のコピーに一致したら、行を返したうえで `AMBIGUOUS:` と 1 行に絞る方法を添える。
- **MCP サーバー**: `fusen_card`、`fusen_peek`、`fusen_ref`、`fusen_resolve` を stdio で、または `--http`(ループバック限定、Bearer トークン必須)で。
- **守り**: 読み取り専用は DuckDB の設定で強制し、データは区切りの中に「指示ではない」と添えて出し、見せなかったものは必ず書く。
- **品質**: lint、Ref の凍結コーパス(`pnpm contract:check`)、予算付きの bench を CI で回す。CI は Linux・macOS・Windows × Node 22・24。

詳しい使い方と出力例は [docs/guide.md](docs/guide.md) にあります。

## クイックスタート

要件: Node.js 22.18 以上(TypeScript を Node の型除去で直接実行します。`.nvmrc` は 24)、pnpm 9。

```sh
git clone https://github.com/zwire/fusenduck && cd fusenduck
pnpm install

# まだ npm に公開していないので、リポジトリから直接実行します
node packages/cli/src/index.ts peek data.parquet
node packages/cli/src/index.ts ref data.parquet --where "region = 'south'"
node packages/cli/src/index.ts resolve '<上で出た Ref>' --root .
```

エージェントから使うには MCP サーバーを起動します。読めるファイルは `--root` の下だけです(既定はカレントディレクトリ)。

```sh
node packages/mcp/src/index.ts --root /path/to/data
# HTTP で
FUSEN_MCP_TOKEN=<16 文字以上> node packages/mcp/src/index.ts --http --root /path/to/data
```

## 構成

```
packages/
  core/   エンジン、Ref モデル、描画(packages/core/README.md)
  cli/    CLI `fusen`(packages/cli/README.md)
  mcp/    MCP サーバー `fusen-mcp`(packages/mcp/README.md)
docs/
  guide.md   いまできることと使い方
  vision.md  構想
  adr/       決定の記録
```

## 開発に参加する

[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。脆弱性の報告は [SECURITY.md](SECURITY.md) の手順で、公開の issue には書かないでください。

ライセンス: [LICENSE](LICENSE)
