# ChangeSpec: 子データベースのページ取得を `@notionhq/client` v5 API に対応

## 変更の目的

`@notionhq/client@5.20.0` で `databases` ネームスペースから `query` が削除され `dataSources.query` に置換された（2025-09 版 Notion API で Data Source モデルを導入）ことにより、`@notion-md-converter/core@0.12.1` の `$getDatabasePages` を経由した DB ページ取得が `t.databases.query is not a function` で全失敗する。v5 クライアントのまま動作するようヘルパーを自前実装に差し替える。

## 現状

- [main.js:7-44](main.js#L7-L44) で `@notion-md-converter/core` から `$getDatabasePages` をインポートしている。
- [main.js:442](main.js#L442) の `crawl` 関数 `kind: "db"` 分岐で `$getDatabasePages(client, id)` を呼び、戻り値の配列を `for` で回して子ページを再帰クロールしている。直前の [main.js:423](main.js#L423) で `client.databases.retrieve({ database_id: id })` は成功している。
- `node_modules/@notion-md-converter/core/dist/index.mjs` の `$getDatabasePages` は `client.databases.query({ database_id, start_cursor })` をページネーションで呼ぶ実装。
- `node_modules/@notionhq/client/build/src/Client.d.ts:149-162` の `databases` には `retrieve/create/update` のみ。`query` は `dataSources`（同 163-184 行）に移動済み。
- v5 の `databases.retrieve` のレスポンスには `data_sources: Array<{ id, name }>` が含まれる（API 2025-09 仕様）。
- `$getPageFullContent`（`blocks.children.list` 使用）と `client.pages.retrieve`、`client.databases.retrieve` は v5 でも動作しており、本件の影響外。
- ページネーションのリトライ（rate_limited 時の指数バックオフ）は `@notion-md-converter/core` 内部の `retryWithBackoff`（エクスポート名 `retryWithBackoff`）に閉じている。

### 関連ファイル

| ファイル | 役割 |
|---------|------|
| [main.js](main.js) | エクスポート本体。DB ページ取得の呼び出し元。 |
| [package.json](package.json) | `@notionhq/client@^5.20.0` と `@notion-md-converter/core@^0.12.1` を宣言。 |

## 変更内容

- **追加**: [main.js](main.js) に `fetchDatabasePages(client, databaseId)` を実装する。
  - `client.databases.retrieve({ database_id: databaseId })` で `data_sources[]` を取得する。
  - 各 `data_source.id` について `client.dataSources.query({ data_source_id, start_cursor })` を `has_more` が `false` になるまでループし、全ページを連結して返す。`page_size` は Notion API のデフォルト（100）に委ねる。
  - `data_sources` が複数ある場合は全 Data Source の結果を単純連結する（通常は 1 件）。
  - `rate_limited` エラーに対応する軽量リトライ（指数バックオフ、最大 3 回）を同ファイル内に実装する。最大リトライ回数を超過した場合は最後の例外をそのまま throw し、呼び出し元 [main.js:443-447](main.js#L443-L447) の `catch` 節が `state.hasFailure = true` を立てて処理を継続する既存動作に合わせる。
- **変更**: [main.js:442](main.js#L442) の `$getDatabasePages(client, id)` 呼び出しを `fetchDatabasePages(client, id)` に差し替える。
- **削除**: [main.js:7-44](main.js#L7-L44) のインポート一覧から `$getDatabasePages` を除去する。

## 影響範囲

- DB をクロールする `crawl` の `kind: "db"` 分岐のみ。ページ単体取得・ブロック再帰取得・アセットダウンロード・リンク解決・Markdown 変換には影響しない。
- `@notion-md-converter/core` は他のシンボル（`NotionMarkdownConverter`、各種 `is*Block`、`$getPageFullContent` 等）を継続使用するため、依存自体の変更・削除は不要。
- `fetchDatabasePages` は内部で `client.databases.retrieve` を発行するため、`crawl` の `kind: "db"` 分岐では同 API が 2 回呼ばれる（呼び出し元 [main.js:423](main.js#L423) と合わせて）。DB あたり 1 回の増加であり、Notion API のレート制限（3 req/s）内で十分吸収できるため許容する。
- テスト: 本リポジトリにテストコードは存在しないため、既存テストの修正は不要。受け入れ検証は実行時の手動確認で行う。
- `@notion-md-converter/core` が将来 v5 API 対応版をリリースした場合、本 ChangeSpec の変更は巻き戻して再び `$getDatabasePages` を使う判断ができる（不可逆な変更ではない）。

## 関連 ADR

- なし。アーキテクチャ変更を伴わないヘルパー差し替えのため ADR は作成しない。

## 受け入れ条件

検証は Data Source 1 件の DB を対象とした実行時確認で行う。複数 Data Source の連結挙動と `rate_limited` 指数バックオフは、ユニットテストを持たない本リポジトリでは実経路で発火しないため受け入れ条件の検証対象外とし、実装の目視レビューで担保する。

- [ ] `node --env-file=.env main.js cadb799680ff4dea9016854d930d845e` を実行したとき、`t.databases.query is not a function` の警告が出ない。
- [ ] 同コマンドで、子データベース `産卵記録 (ee911870eb4f468bb182424b1e51baa1)` および `メンテナンス記録 (3d2d39dd097c49aaa06db65f899273f2)` の配下ページが Notion 上に存在する全件分、`out/` 以下にファイルとして出力される（件数は実行時に Notion 上で確認した実数と一致すること）。
- [ ] `crawl` の進捗ログ（`[N] タイトル (id)` 行）に、上記 2 つの DB 配下の各ページのタイトルと ID が列挙される。
- [ ] `state.hasFailure` に起因する非ゼロ終了コード（exit 2）が発生しない。
- [ ] `@notionhq/client` のバージョンは `^5.20.0` のまま変更されない。
