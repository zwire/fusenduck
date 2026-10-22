# @fusenduck/core

fusenduck のエンジン、Ref モデル、描画。CLI と MCP サーバーはどちらもこのパッケージを通してデータを読みます。

| ファイル | 内容 |
| --- | --- |
| `src/engine.ts` | DuckDB を開き、読み取り専用の設定(`allowed_paths`、外部アクセスの禁止、メモリ上限、設定の固定)をかける。クエリのタイムアウト |
| `src/card.ts` | data card(行数、型、null 率、min/max、近似の distinct 数) |
| `src/fingerprint.ts` | データの指紋(行数、サイズ、Parquet フッターの列統計) |
| `src/ref.ts` | Ref の文法(`parseRef` / `formatRef`)、述語とクエリの検査、`id=` の計算 |
| `src/resolve.ts` | `mintRef`、`resolveRef`、`peek`。`--root` の検査、コストの上限、あいまいの検出 |
| `src/render.ts` | エージェント向けの描画(区切り、注意書き、`OMITTED:`) |
| `src/errors.ts` | `FusenError` と、エンジンのエラーを固定文言にする `describeError` |

主な既定値: `DEFAULT_LIMIT`(100 行)、`DEFAULT_MAX_BYTES`(512MB)、`DEFAULT_TIMEOUT_MS`(10 秒)、`DEFAULT_PEEK_ROWS`(5)/ `MAX_PEEK_ROWS`(50)、`MAX_AMBIGUITY_ROWS`(10,000)。

使い方と出力の形は [docs/guide.md](../../docs/guide.md)、決定の経緯は [ADR 0001](../../docs/adr/0001-engine-ref-rendering.md) を参照。
