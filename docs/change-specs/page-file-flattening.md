# ChangeSpec: ページファイル名の変更と添付の同階層配置

## 変更の目的

各ページの出力先を `<slug>/index.md` から `<slug>/<slug>.md` に変更し、添付ファイルを `assets/` サブディレクトリではなく MD ファイルと同じディレクトリに配置する。ディレクトリ一覧や任意のファイラでページ本体を単独ファイル名で識別しやすくするため、および添付を参照する際の相対パスを短くシンプルにするため。

## 現状

- `assignPaths()` が各ノードに `<parentRelDir>/<slug>/index.md` を割り当てる（`slug = <サニタイズ済みタイトル>-<shortId 8文字>`）。すべてのページが例外なく専用ディレクトリ配下の `index.md` として出力される。
- `assignAssetLocalPaths()` が各添付に `<pageRelDir>/assets/<filename>` を割り当てる。
- 添付ファイル名の衝突回避は同一ページ内の添付同士のみを対象とし、衝突時は `<base>-<blockId 先頭 8>` 形式で解決する。本体 MD 名・子ページディレクトリ名との衝突は現状考慮されていない（`assets/` により分離されていたため発生しなかった）。
- README の「生成される構造」「添付ファイルのローカルダウンロード」セクションが現状仕様を記載している。
- 出力先は使い捨て前提で、再実行時は上書きするがクロール対象外となった前回出力は削除しない（README 記載）。

### 関連ファイル

| ファイル | 役割 |
|---------|------|
| [main.js](main.js) | パス割当（`assignPaths`、`assignAssetLocalPaths`）、書き出し（`writeAll`）、衝突回避（`resolveAssetFilenameCollision`） |
| [README.md](README.md) | 出力構造・添付配置の公開仕様 |

## 変更内容

- **変更**: [main.js:561](main.js#L561) `assignPaths()` の `outRelPath` を `${relDir}/index.md` から `${relDir}/${slug}.md` に変更する。衝突回避で `<slug>.md` および子ノードの slug ディレクトリ名を参照する必要があるため、`slug` はノード（`node.slug`）に保持する。
- **変更**: [main.js:674](main.js#L674) `assignAssetLocalPaths()` の `localRelPath` を `${pageRelDir}/assets/${filename}` から `${pageRelDir}/${filename}` に変更する。
- **変更**: `assignAssetLocalPaths()` の衝突回避対象を拡張する。ページごとに初期化する `used` セット（[main.js:668](main.js#L668) の `new Set()`）の初期値として、以下をすべて含める:
  - 本体 MD のファイル名（`<slug>.md`）
  - 当該ページが持つすべての子ノードの slug ディレクトリ名（`node.children` の各 `child.slug`）
  衝突時は既存の `resolveAssetFilenameCollision()` のロジック（`-<blockId 先頭 8>` 付加）を使用する。
- **変更**: [README.md:39-61](README.md#L39-L61) の「生成される構造」セクションを新しい出力構造に合わせて更新する。
- **変更**: [README.md:65](README.md#L65) 「各 `index.md` 冒頭に以下の共通項目が付与される」を新ファイル名（`<slug>.md`）を指す表現に変更する。
- **変更**: [README.md:90-116](README.md#L90-L116) の「添付ファイルのローカルダウンロード」セクションから `assets/` サブディレクトリの記述を削除し、同階層配置に合わせて更新する。衝突回避の記述（本体MD名・子ページ名との衝突も含む点）も追記する。
- **変更**: [README.md:118-122](README.md#L118-L122) の「ページ間リンク」セクションの相対パス例示（`./sub/index.md`、`../db/page-a1b2c3d4/index.md`）を新形式（`./sub/sub-<shortId>.md` 等）に更新する。

以下は変更対象外:

- ページ階層のディレクトリネスト構造（現状維持）
- `<slug>` の生成ロジック（`dirSlug`、`sanitizeTitle`、`clampUtf8Bytes`）
- 添付のダウンロード・並列度・タイムアウト等の挙動
- リンク解決ロジック（`resolveLinks` は `outRelPath`・`localRelPath` の変更を透過的に扱える）
- 葉ページ（添付・子なし）の扱い（新形式でも `<slug>/<slug>.md` としてディレクトリにラップする方針を維持し、葉ページのみ単独ファイル化する特殊扱いはしない）
- 後方互換・マイグレーション（出力は使い捨て前提）

## 影響範囲

- **パス関連**: `assignPaths`、`assignAssetLocalPaths`、`writeAll`、`downloadAsset`、`resolveLinks` が `outRelPath` / `localRelPath` を参照する。値が変わるだけなので `path.dirname` ベースの算出は自動追従する。
- **リンク書き換え**: `resolveLinks` の `toRelativePosix(pageDir, ...)` 計算は `pageDir` と対象パスが両方同時に変わるため、ページ間リンクの相対パスも自然に更新される（例: `./sub/index.md` → `./sub/sub-<shortId>.md`）。特別な対応は不要。
- **添付リンク**: 本文中の添付参照は `<pageRelDir>/assets/<filename>` から `<pageRelDir>/<filename>` を指すよう相対パスが短くなる（例: `./assets/image.png` → `./image.png`）。
- **frontmatter の `files` プロパティ**: `notion-asset:` プレースホルダ経由で `resolveLinks` により解決されるため、同様に自動追従する（例: `./assets/file.pdf` → `./file.pdf`）。
- **テスト**: リポジトリにテストコードは存在しない。手動での再実行・目視確認による検証となる。
- **既存出力**: 既存の `out/` 配下の `index.md` や `assets/` ディレクトリは削除されず残留する。README の使い捨て前提の記述に従い、必要ならユーザーが手動で `out/` を削除してから再実行する。

## 関連 ADR

- なし

## 受け入れ条件

- [ ] ルートページを実行すると、`out/<slug>/<slug>.md` としてページ本体が出力される（`index.md` は生成されない）
- [ ] 添付を持つページで、添付が `out/<slug>/<filename>` に保存される（`assets/` ディレクトリは生成されない）
- [ ] 子ページを持つページで、子ページが `out/<slug>/<child-slug>/<child-slug>.md` として出力される
- [ ] ページ間リンクが相対パスで正しく解決される（例: 親から子 `./<child-slug>/<child-slug>.md`、子から親 `../<slug>.md`）
- [ ] 本文中の画像・動画・PDF・ファイル参照が、`./<filename>` 形式のローカル相対パスに書き換わる
- [ ] データベースページの `files` プロパティの frontmatter 値が、ローカル相対パス配列になる
- [ ] 添付ファイル名が本体 MD 名（`<slug>.md`）と一致する場合、`<base>-<blockId 先頭 8>` 形式で解決される
- [ ] 添付ファイル名が当該ページの子ノードの slug ディレクトリ名と一致する場合、`<base>-<blockId 先頭 8>` 形式で解決される
- [ ] 同一ページ内の同名添付同士の衝突回避が従来通り `<base>-<blockId 先頭 8>` 形式で機能する（回帰確認）
- [ ] README の「生成される構造」「添付ファイルのローカルダウンロード」「ページ間リンク」および frontmatter 冒頭の記述（L65）が新しい出力構造と一致する
- [ ] 既存の動作（クロール、frontmatter 生成、ダウンロード、終了コード、警告出力）が変更前と同じ挙動を維持する
