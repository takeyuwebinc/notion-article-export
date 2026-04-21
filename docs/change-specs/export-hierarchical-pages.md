# ChangeSpec: サブページ／データベース含む階層構造エクスポート

## 変更の目的

現状は単一 Notion ページ1件のみを Markdown として stdout に出力できる。Notion では記事が親ページ配下にサブページやデータベースをぶら下げて構成されることが多く、関連コンテンツを一括してローカルに書き出せるようにしたい。

## 現状

- [main.js](../../main.js) は `process.argv[2]` で pageId を受け取り、`$getPageFullContent` で取得した結果を `NotionMarkdownConverter.execute` に渡し、`console.log` で stdout に単一 Markdown を出力する。
- `@notion-md-converter/core` の `$getPageFullContent` は `blocks.children.list` を再帰的に呼ぶが、Notion API の仕様上 `child_page` ブロックは `has_children=false` として返るため（[Notion 公式: Working with page content](https://developers.notion.com/docs/working-with-page-content)）、サブページ本文までは取得されない。子ページを読むには child_page の `id` を pageId として再度 `$getPageFullContent` を呼ぶ必要がある。`child_database` も同等の扱いで、内部ページは別途 `databases.query` 相当で列挙する必要がある。
- `NotionMarkdownConverter` のデフォルト transformer マップに `child_page` / `child_database` は登録されておらず（`initializeTransformers` で未設定）、現状の出力では両ブロックは黙殺されて痕跡が残らない。
- データベース内ページ列挙用に `$getDatabasePages(client, databaseId)` が、URL→pageId 変換用に `extractPageId` が提供されている。
- `$getPageFullContent` は内部でセマフォ（同時並列3）と `retryWithBackoff`（429 系のみ再試行）を持ち、Notion API のレート制限（3req/s 目安）に一定配慮している。
- 出力先は stdout 単一ストリーム。ディレクトリ書き出し・複数ファイル生成の仕組みは無い。
- `package.json` の `type` は `module`（ESM）。依存は `@notion-md-converter/core` と `@notionhq/client` のみ。

### 関連ファイル

| ファイル | 役割 |
|---------|------|
| [main.js](../../main.js) | エントリポイント。pageId から Markdown を生成し stdout に出力 |
| [package.json](../../package.json) | ESM 設定と依存宣言、`npm start` で `--env-file=.env` 経由の実行 |
| [README.md](../../README.md) | セットアップと使い方 |

## 変更内容

### CLI 仕様

- **変更**: 第2引数で**出力先ディレクトリ**を受け取るようにする。未指定時は `./out` を既定とする。
  - 新 usage: `node --env-file=.env main.js <pageId> [outDir]`
  - 出力先が存在しない場合は再帰作成。既存の場合は**事前削除はしない**。同名ファイルは上書きする。今回クロール対象外となった前回出力の孤児ファイルは残留しうる（使い捨てスクリプト前提で明示的にユーザーに管理させる）。
  - 起点 pageId が取得できない（未接続・権限不足・404）場合は `[error] root page fetch failed: <reason>` を stderr に出して **exit 1**。

### 階層クロール

- **追加**: ルート pageId を起点とするクロール処理。各ページのブロック列を走査し、以下のページ参照を検出するたびに対応する処理を起動する:
  - `child_page` ブロック → child_page の `id` で `$getPageFullContent` を再帰取得
  - `child_database` ブロック → `$getDatabasePages` でページ一覧取得後、各ページを `child_page` と同様に再帰取得
  - `link_to_page` ブロック（ページ or データベース参照） → **クロール対象に含める**（本文中にも相対リンクとして出力）
  - rich_text 中の `mention` タイプのうち `page` / `database` 参照 → 書き換え対象とするが**クロール対象には含めない**（本文外の参照は辿らない）
- **追加**: 訪問済み pageId の集合で重複取得と循環参照を防止する。クロールはトップダウンに**直列実行**とし、`$getPageFullContent` 内部のセマフォ(3) とリトライに API 制御を委ねる（簡潔さ優先、将来のチューニング余地として許容）。
- **追加**: 進捗を stderr に1行/ページで出力（`[n] <title> (<pageId>)` 形式）。stdout はリダイレクト互換のため汚染しない。
- **追加**: 取得失敗時（認証エラー・権限エラー・404・ネットワーク断）:
  - **ルートページ**の取得失敗 → exit 1（致命扱い）
  - **子ページ／DB ページ**の取得失敗 → stderr に `[warn] fetch failed: <pageId>: <reason>` を出して**そのサブツリーをスキップ**し、処理継続
  - 全体が1件でも失敗を含む場合、正常終了時の exit code は `2`（部分出力）とする（未失敗時は `0`）
- **追加**: クロール結果は中間表現の木構造で保持する: `{ id, title, kind: "page"|"db_page", properties?, blocks, children: Node[], outRelPath }`。

### ディレクトリ展開

- **追加**: ルートを含む**全ページをディレクトリ化**し、本文は各ディレクトリ配下の `index.md` に出力する（`out/<slug>/index.md`、子ページは `out/<slug>/<child-slug>/index.md`）。
- **追加**: ディレクトリ／ファイル名規則「`<タイトル>-<shortId>`」（shortId = ハイフン無し Notion ページID の先頭8文字）:
  - **サニタイズ**: OS 互換のため以下を `_` に置換する: `/ \ : * ? " < > |` および ASCII 制御文字（0x00–0x1F）。先頭・末尾の空白とドット（`.`）は除去。
  - タイトルが空文字の場合は `untitled-<shortId>`。
  - ファイル名は UTF-8 エンコード後のバイト長が **240 バイト以内**に収まるよう、タイトル部分を切り詰めてから `-<shortId>` を付加（ext4 の 255 バイト上限に対し `-<shortId>` とマージンを考慮）。

### YAML frontmatter

- **追加**: 出力する各 `index.md` の先頭に YAML frontmatter を付与する。全ページ共通項目:
  - `id`（ハイフン付き Notion ページID）
  - `title`
  - `notion_url`
  - `created_time`, `last_edited_time`
- **追加**: データベース配下ページでは、上記に加えて**プロパティ**を frontmatter に展開する。プロパティ型ごとの変換ルール:

| Notion 型 | YAML への表現 |
|---|---|
| title, rich_text, url, email, phone_number | 文字列（rich_text は plain 結合） |
| number, checkbox | そのままの値 |
| select, status | 選択肢名（文字列） |
| multi_select | 選択肢名の配列 |
| date | `{ start, end, time_zone }` のオブジェクト |
| people | 名前（無い場合は `id`）の配列 |
| files | URL 文字列の配列 |
| relation | 相手ページIDの配列 |
| formula | 計算結果の `number` / `string` / `boolean` / `date` 値 |
| created_by, last_edited_by | ユーザー名（無ければ `id`）の文字列 |
| unique_id | `<prefix>-<number>` 形式の文字列 |
| rollup | 集計結果が array の場合は配列に、単一値の場合は対応する原型に従う |

- **サポート外の値は frontmatter のキー自体を省略する**（`null` を出さない）。キーの衝突・欠落で後工程が困惑しないため。
- プロパティ名に YAML 予約語や非 ASCII を含むキーが来ても、`js-yaml` の `dump` 任せで適切にエスケープする。

### リンク書き換え（プレースホルダ統一方式）

本文 Markdown 中のページ参照は、**クロールと独立したフェーズで一括解決**する。これにより transformer 段階での相対パス計算（クロール途中で出力先が未確定）を回避し、責務を一本化する。

- **追加**: カスタム transformer は具体 URL ではなく**プレースホルダ**を埋め込む:
  - `child_page` → `[<title>](notion-ref:<pageId>)`
  - `child_database` → `## <DB名>` 見出し＋DB 内ページへの箇条書き（各項目は `- [<title>](notion-ref:<pageId>)`）
  - `link_to_page` → `[<解決したタイトル>](notion-ref:<pageId>)`
  - rich_text 中の `mention`（page/database 型）→ 既定 transformer を差し替え、リンク URL を `notion-ref:<pageId>` に置換
- **追加**: クロール終了後、全ページの Markdown 本文に対し `notion-ref:<pageId>` を次のルールで解決する:
  - クロール済み pageId → 出力ファイル間の**相対パス**（`path.relative` ベース、POSIX 区切りで正規化）に置換
  - **クロール対象外**（未接続・権限無し・`mention` のみの参照等）→ 元 Notion URL（`https://www.notion.so/<ハイフン無しID>`）に置換し、**stderr に警告** `[warn] unresolved page link: <url>` を出力（重複 pageId は警告を1回に集約）
- **追加**: pageId の正規化には既存の `extractPageId` を使用し、`notion.so` URL からの抽出・ハイフンの有無を吸収する。

### ブロック transformer のカスタマイズ

- **追加**: `NotionMarkdownConverter` に以下のカスタム transformer を注入する（いずれもプレースホルダ出力に徹する）:
  - `child_page`
  - `child_database`
  - `link_to_page`
  - 既定の rich_text フォーマッタを継承しつつ、`mention` 型のページ/データベース参照だけ URL をプレースホルダに差し替える

### ライブラリ追加

- **追加**: `js-yaml` を `dependencies` に追加（frontmatter シリアライズ用。`JSON.stringify` は YAML として不正）。

### ファイル構成

- **変更**: [main.js](../../main.js) を次の責務に分割する（ファイルは単一のまま `main.js` 内の関数として定義、依存注入なし）:
  - `crawl(client, rootId)` — 階層クロール、訪問済み管理、木構造構築
  - `assignPaths(tree, outDir)` — ディレクトリ名決定とサニタイズ、`outRelPath` 付与
  - `renderPage(node, converter)` — frontmatter 合成 + Markdown 変換（プレースホルダ入り）
  - `resolveLinks(renderedMap, idToPathMap)` — プレースホルダ解決
  - `writeAll(renderedMap, outDir)` — ファイルシステムへの書き出し

## 影響範囲

- [main.js](../../main.js) は全面書き換え。
- [package.json](../../package.json) の `dependencies` に `js-yaml` 追加、`start` スクリプトの引数表記を更新。`package-lock.json` も自動更新される。
- [README.md](../../README.md) の使い方セクションを更新（`[outDir]` 引数、生成される階層構造、frontmatter の仕様、リンク書き換えと警告、終了コード）。
- 既存の stdout 出力は廃止される。stdout に Markdown を流していた呼び出し箇所（シェルリダイレクト等）は動かなくなる。外部からの呼び出しは無い前提（本リポジトリは単一スクリプトのみ）。
- Notion 側：親ページ＋全サブページ・DB にインテグレーションが接続されている必要がある。未接続は警告扱い。
- テスト：リポジトリに自動テストは存在しない。実在する Notion 構造での手動検証で確認する。

## 関連 ADR

- なし（既存ライブラリの提供 API の素直な組み合わせ。複数案比較を要する設計判断は発生せず）

## 受け入れ条件

- [ ] ルートページに `child_page` 1つ、`child_database`（内部に2ページ）1つを持つサンプルを実行すると、`out/<root>/index.md`、`out/<root>/<child_page>/index.md`、`out/<root>/<db>/index.md`、`out/<root>/<db>/<db_page_1>/index.md`、`out/<root>/<db>/<db_page_2>/index.md` が生成される。
- [ ] 全 `index.md` 冒頭に YAML frontmatter があり、`id` / `title` / `notion_url` / `created_time` / `last_edited_time` が含まれる。
- [ ] DB 内ページの `index.md` の frontmatter に、Notion 側プロパティ（title, select, multi_select, number, date, checkbox, relation, people, files のうち存在するもの）が本仕様の型変換ルールどおりに出力されている。サポート外型のキーは省略される。
- [ ] 親ページ本文中の `child_page` / `child_database` / `link_to_page` / ページ mention が、出力後ファイル間の**相対パス**（例: `./sub/index.md`、`../db/page-a1b2c3d4/index.md`）として Markdown リンクに書き込まれている。文字列として当該リンクが対象ファイルに存在することを grep で検証可能。
- [ ] クロール範囲外の Notion ページへのリンクは `https://www.notion.so/<id>` 形式に置換され、stderr に `[warn] unresolved page link:` 警告が出る。同一 pageId について警告は1回のみ。
- [ ] タイトルに `/`, `\`, `:`, 日本語記号などを含むページでも、ファイル名がサニタイズされて書き出しが成功する。UTF-8 で 240 バイトを超える長いタイトルでも失敗せず、短縮IDが末尾に保持される。
- [ ] 本文中で同一 pageId が複数回参照されても、Notion API への取得は pageId あたり1回のみ（訪問済み集合で重複排除）。
- [ ] 循環参照（A→B→A）を含む構造でも無限ループせず有限時間で終了する。
- [ ] 画像ブロックは Notion S3 の URL をそのまま Markdown 画像 `![alt](url)` として出力する（ダウンロードしない）。
- [ ] ルートページ取得失敗時は exit 1、子ページの部分失敗時は exit 2、完全成功時は exit 0 で終了する。
- [ ] stdout には何も出力されない（stderr のみ使用）。
