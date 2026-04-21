# ChangeSpec: 添付ファイルのローカルダウンロード

## 変更の目的

現状、画像・動画・PDF・ファイルブロックおよびデータベースの `files` プロパティは Notion 内部 S3 の署名付き URL として Markdown／frontmatter に埋め込まれているが、この URL は署名の有効期限（約1時間）で失効するため、出力した成果物は時限式になっている。添付ファイルをローカルに取得して相対パス参照に置き換え、生成物をオフライン・長期保存可能な形にする。

## 現状

- [main.js](../../main.js) は `HierarchicalConverter` を通じて各ページブロックを Markdown 化するが、`image` / `video` / `pdf` / `file` ブロックはいずれも `@notion-md-converter/core` の**既定 transformer** を使っている（カスタム差し替えは `child_page` / `child_database` / `link_to_page` のみ）。既定 transformer は `createNoChangeFileObjectAdapter`（内部で `createFileAdapter` をラップ）経由で、内部ファイルは `.file.url`（署名付き S3 URL）、外部ファイルは `.external.url` をそのまま出力する。
- DB `files` プロパティは `main.js` の `convertProperty` で内部は `file.url`、外部は `external.url` を抽出し、URL 文字列の配列として frontmatter に格納される（`convertProperty` の `files` 分岐）。
- Notion 内部ファイルの署名付き URL は、Notion API ドキュメント「Retrieving existing files」および「File object」によれば**1時間で失効**し、`file.expiry_time` フィールド（ISO 8601 / UTC）に具体的失効時刻が記録される。再取得すると新しい URL と新しい `expiry_time` が返る。
  - 観測上、S3 ホスト（`prod-files-secure.s3.us-west-2.amazonaws.com` など）と URL パス部分は再取得しても同一で、`X-Amz-*` クエリパラメータのみが変わる。ただしこの性質は公式保証ではなく実装依存のため、パスを安定キーとして用いる本仕様は Notion 側の URL 署名方式変更でキー不成立となるリスクを持つ。
- ダウンロード処理・ローカル保存・URL 書き換えの仕組みは存在しない。Notion 内部ファイルはすべて時限 URL で出力される。
- 既存のリンク書き換えは `resolveLinks` が `notion-ref:<pageId>` プレースホルダを後段で相対パスへ解決する2フェーズ方式になっている。
- ページ取得の並列制御は、`crawl` 関数自体は `for...of await` で逐次だが、内部で呼び出す `$getPageFullContent` がライブラリ組み込みのセマフォ（並列度3）で `blocks.children.list` を制御している。今回追加するダウンロード並列度はこの水準に合わせる。
- `package.json` の `type` は `module`（ESM）、`engines` フィールドは未設定。現状の README は Node.js 20.6+ を前提としているが、標準 `fetch` の安定化は Node 21 以降であり、本変更では要求バージョンを Node.js 21+ に引き上げる（後述）。

### 関連ファイル

| ファイル | 役割 |
|---------|------|
| [main.js](../../main.js) | クロール・レンダリング・リンク解決・ファイル出力を一括で担うエントリポイント |
| [package.json](../../package.json) | ESM 設定、依存宣言、`start` スクリプト（`--env-file=.env`）。`engines` 追加の対象 |
| [README.md](../../README.md) | 使い方・生成構造・frontmatter 仕様・Node バージョン要件を記述 |
| [.gitignore](../../.gitignore) | 追跡対象外の宣言。`out/` の扱いを再検討 |
| 既存 ChangeSpec 履歴（git log）| 終了コード体系（root失敗=1/部分失敗=2/成功=0）の根拠 |

## 変更内容

### ダウンロード対象

- **追加**: 以下のいずれかの参照で **Notion 内部ファイル**（`file` 型、`file.url` 保持）を検出したら、ローカルにダウンロードする。
  - ブロック: `image` / `video` / `pdf` / `file`
  - DB プロパティ: `files` 型の各エントリ
- **対象外**: `external` 型（`.external.url`、失効しない外部 URL）、`bookmark` / `embed` / `link_preview`（Web リソース）。これらは従来通り URL のまま出力する。

### 保存先とファイル名

- **追加**: 保存先は「参照元ページのディレクトリ配下の `assets/`」に局所化する: `out/<page slug>/assets/<filename>`。**同一内部ファイルが複数ページから参照される場合、それぞれのページ配下に重複して保存される**（シンプルさ優先、将来のチューニング余地として許容）。
- **追加**: ファイル名は、Notion 内部 S3 URL の `pathname` 末尾セグメント（クエリ除外）を `decodeURIComponent` し、以下のサニタイズを適用する:
  - OS 互換のため `/ \ : * ? " < > |` および ASCII 制御文字（0x00–0x1F）を `_` に置換
  - 先頭・末尾の空白とドット（`.`）を除去
  - UTF-8 エンコード後のバイト長が **240 バイト以内**になるよう、拡張子を保ったまま basename 部分を切り詰める
  - 末尾セグメントが空文字や拡張子だけになった場合は `<blockId 先頭8文字>.bin` にフォールバック
- **追加**: 同一ページ配下で異なる URL パスが同じサニタイズ後ファイル名に衝突する場合、2件目以降は `<basename>-<blockId 先頭8文字><ext>` 形式で解決する。
- **追加**: 同一ページ配下で**同じ URL パス**（クエリ除外）が複数回参照された場合は1ファイルに集約し、すべての参照箇所が同じ相対パスを指す。

### ダウンロード処理

- **追加**: クロール完了後・レンダリング開始前の独立フェーズで、全ページから収集したアセット参照をダウンロードする。
- **追加**: **並列度 3**（`$getPageFullContent` のライブラリ組み込みセマフォと同水準）。簡易セマフォで制御。
- **追加**: 個別ダウンロードの**タイムアウトは 60 秒**（大容量動画も想定）。`AbortController` で実装し、タイムアウト超過は失敗扱い。再試行は行わない（簡潔さ優先）。
- **追加**: `fetch` を使用し、2xx 以外 / ネットワーク断 / タイムアウトは失敗扱い。
- **追加**: レスポンスボディは `stream.pipeline` で `fs.createWriteStream` に書き出す（メモリに全体を載せない）。中断時の部分書き込みファイルは残存しうるが、次回実行の上書きで解消される（後述）。
- **追加**: 進捗は stderr に `[asset n/m] <filename>` 形式で出力する（n はアセット通し番号、m は総数）。
- **追加**: 失敗時の扱い:
  - 個別アセット取得失敗 → stderr に `[warn] asset download failed: <blockId> <url>: <reason>` を出して**そのアセットだけスキップ**し、処理継続。該当参照箇所は**元の Notion 署名付き URL のまま**残す（時限式になるが、出力ファイルがまったく生成できないよりマシ）。
  - 1件でも失敗があれば `hasFailure` を立て、他フェーズの失敗と合算して最終 exit code `2` を維持する。
- **追加**: 再実行時の挙動は**常に上書き**（`fs.createWriteStream` 既定動作）。部分書き込み残留を上書きで解消するため。

### レンダリングとリンク書き換え

- **追加**: `HierarchicalConverter` に `image` / `video` / `pdf` / `file` のカスタム transformer を追加し、内部ファイルについては URL 位置に **プレースホルダ `notion-asset:<assetKey>`** を埋め込む。外部ファイルは既定 transformer と同じく URL をそのまま埋める。
  - `image` → `![<caption>](notion-asset:<assetKey>)`
  - `pdf` / `file` → `[<caption>](notion-asset:<assetKey>)`
  - `video` → `<video src="notion-asset:<assetKey>" ...>`（HTML 属性形式、既定 transformer の出力形を踏襲）
- **追加**: DB `files` プロパティの frontmatter 出力を、内部ファイルについては `notion-asset:<assetKey>` プレースホルダに変更する（外部ファイルは URL のまま）。
- **追加**: `assetKey` は「ページスコープ内でユニークな安定キー」とし、具体的には**ページ ID + URL パス（クエリ除外）のハッシュ先頭16文字**（`node:crypto` の SHA-256）を用いる。プレースホルダ文字列として YAML / Markdown / HTML のいずれに埋めても衝突・破損しないよう hex 表現とする。
- **変更**: `resolveLinks` を拡張し、既存の `notion-ref:<pageId>` に加えて `notion-asset:<assetKey>` も解決対象にする。
  - ダウンロード成功アセット → 該当ページの `index.md` から見た相対パス（POSIX 区切り）に置換
  - ダウンロード失敗アセット → 元の Notion 内部 URL に置換（既に警告済みなので resolve 時の追加警告は出さない）
- **追加**: `notion-asset:<assetKey>` の正規表現は `notion-asset:[a-f0-9]{16}` 形式で、既存 `notion-ref` 解決の regex と衝突しない。

### 内部構造

- **追加**: クロール中（`crawl` 関数）に各ノードの `blocks` と `properties` を走査し、内部ファイル参照を収集する新規関数 `collectAssets(node)` を追加する。各アセットは次のレコードで管理する:
  - `{ assetKey, pageId, urlPath, signedUrl, filename, localRelPath }`
  - `localRelPath` は `<page slug>/assets/<filename>` 形式で、`assignPaths` 直後のタイミングで確定する。
- **追加**: 収集したアセットはページ単位の `Map<assetKey, AssetRecord>` および全体の `Map<assetKey, AssetRecord>` に格納する。
- **追加**: ダウンロード関数 `downloadAssets(assets, concurrency=3)` を新設し、簡易セマフォで並列ダウンロードする。

### Node.js バージョン引き上げ

- **変更**: 要求 Node バージョンを **20.6+ から 21+ に引き上げる**。
  - `package.json` に `"engines": { "node": ">=21" }` を追加
  - `README.md` の必要環境セクションを Node 21+ に更新
  - 理由: 本変更で標準 `fetch` に依存する。Node 18〜20 でも `fetch` は組み込み済みだが experimental 扱いで、v21.0 で stable 解除された

## 影響範囲

- [main.js](../../main.js): `HierarchicalConverter` にカスタム transformer（image/video/pdf/file）を追加、`convertProperty` の `files` 分岐でプレースホルダ化、クロール・パス割当後に `collectAssets` → `downloadAssets` フェーズを挿入、`resolveLinks` の regex と置換ロジックを拡張。
- [package.json](../../package.json): `engines.node >= 21` を追加。依存追加なし（`fetch` / `node:crypto` / `node:stream` / `node:fs/promises` は標準）。`package-lock.json` に変更は発生しない見込み。
- [README.md](../../README.md): 「添付ファイルのローカルダウンロード」節を追加（`assets/` ディレクトリ構成、タイムアウト60秒、並列度3、内部/外部区別、失敗時の挙動）。必要環境を Node 21+ に更新。frontmatter 仕様セクションの `files` 行を「相対パス配列、外部 URL は URL のまま」に更新。
- [.gitignore](../../.gitignore): 現状 `node_modules` / `.env` のみ。`out/` 配下にバイナリ添付ファイルが大量に入る可能性があるため、**`out/` を `.gitignore` に追加する運用**を README で案内する（本 ChangeSpec では `.gitignore` 自体は変更せず、README の推奨事項として記載）。
- クロール総処理時間は（全アセット合計サイズ ÷ 実効帯域幅）だけ増加する。大容量動画が含まれる場合の挙動に注意。
- 既存の `notion-ref:` 解決動作には影響しない（regex が独立、相互排他）。
- 既存 ChangeSpec で定義された終了コード体系は維持（ダウンロード失敗も `hasFailure` 経由で exit 2 に合流）。
- Notion 側の URL 署名方式が変更された場合（観測前提が崩れた場合）、同一ファイルが毎回別キーとして扱われ重複ダウンロードされる可能性があるが、出力の正しさには影響しない（リンク解決は同一実行内で閉じる）。
- テスト: リポジトリに自動テストは存在しない。実在する Notion 構造（内部画像／外部画像／DB `files` プロパティ混在／日本語ファイル名）での手動検証で確認する。

## 関連 ADR

- なし（既存の `notion-ref` プレースホルダ方式を同パターンで拡張するのみ。新規の戦略判断は発生しない）

## 受け入れ条件

- [ ] ルートページ本文中の `image` ブロック（内部ファイル）が、`out/<page>/assets/<filename>` にダウンロードされ、Markdown 中の画像参照が `./assets/<filename>` の相対パスに書き換えられている。
- [ ] `pdf` / `file` / `video` ブロックの内部ファイルも同様にダウンロードされ、それぞれ Markdown リンク／HTML `src` 属性の URL 位置が相対パスに書き換えられている。
- [ ] DB 内ページの `files` プロパティが frontmatter に相対パス配列として出力される（例: `files: ['./assets/a.pdf', './assets/b.pdf']`）。内部と外部 URL が混在する場合、外部 URL は URL のまま残り、内部は相対パスに置換されている。
- [ ] サブページ配下の内部ファイルは、そのサブページディレクトリ配下 `assets/` に保存される（ルートページに集約されない）。
- [ ] **同一内部ファイルがページ A とページ B の両方から参照される場合**、`out/<A>/assets/` と `out/<B>/assets/` の両方にファイルが重複して保存され、各ページの参照は自ページ配下の相対パスを指す。
- [ ] `bookmark` / `embed` / `link_preview` ブロックは従来通り URL のまま出力され、ダウンロード対象にならない。
- [ ] 外部ファイル（`external` 型）は従来通り URL のまま出力される。
- [ ] 同一ページ内で同じ URL パス（クエリ除外）の参照が複数あっても、ダウンロードは1回のみで、全参照が同じ相対パスを指す。
- [ ] 日本語ファイル名（URL エンコードされた例: `%E3%83%86%E3%82%B9%E3%83%88.pdf`）はデコード後の `テスト.pdf` として `assets/` に保存され、Markdown / frontmatter の参照も同名を指す。
- [ ] UTF-8 で 240 バイトを超える長いファイル名でも、拡張子を保ったまま basename 部が切り詰められて書き出しが成功する（例: `.pdf` が末尾に保持される）。
- [ ] **同一ページ内で異なる URL パスがサニタイズ後に同名になる衝突ケース**では、2件目以降が `<basename>-<blockId 先頭8文字><ext>` として保存され、Markdown リンクは正しくそれぞれのファイルを指す。
- [ ] **URL 末尾セグメントが空または拡張子のみのケース**では、ファイル名が `<blockId 先頭8文字>.bin` として保存される。
- [ ] ダウンロード失敗（HTTP エラー／ネットワーク断／60 秒タイムアウト）があっても処理は中断せず、該当参照は Notion 内部 URL のまま残り、`[warn] asset download failed: <blockId> <url>: <reason>` が stderr に出力される。全体の exit code は 2。
- [ ] 並列ダウンロードが同時に最大 3 件まで実行されることが確認できる（stderr の進捗ログや観測で確認）。
- [ ] 進捗ログが `[asset n/m] <filename>` 形式で stderr に出力される（n は1始まり、m は総数）。
- [ ] 全ファイル成功時の exit code は 0、ルートページ取得失敗時は 1（既存動作と同じ）。
- [ ] 並列ダウンロード中に stdout には何も出力されない（進捗・警告はすべて stderr）。
- [ ] 再実行時、既存の `assets/` 配下ファイルは上書きされる。
- [ ] `package.json` に `"engines": { "node": ">=21" }` が設定され、README の必要環境が Node 21+ に更新されている。
- [ ] README の frontmatter 仕様テーブルで `files` 型が「相対パス配列（外部 URL はそのまま）」に更新され、`out/` を `.gitignore` 追加推奨する案内が含まれる。
