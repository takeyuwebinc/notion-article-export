# ChangeSpec: ページ MD を単独ファイル化し添付・子ページをサイドカーディレクトリに配置

## 変更の目的

各ページの本体 MD を専用ディレクトリ配下ではなく、親階層に単独ファイル `<slug>.md` として出力する。添付および子ページは、本体 MD と同名のサイドカーディレクトリ `<slug>/` 配下に配置する。ページ本体をディレクトリ階層でラップせず単独ファイルとして扱えるようにし、添付・子を持たない葉ページがディレクトリを持たないシンプルな出力にするため。

## 現状

- 直前の変更により、各ページは `<parentRelDir>/<slug>/<slug>.md` として出力される（`assignPaths` が `outRelPath = ${relDir}/${slug}.md`、`relDir = parentRelDir ? parentRelDir + "/" + slug : slug`）。本体 MD は必ずディレクトリ配下にラップされる。
- 添付は本体 MD と同じディレクトリ `<pageRelDir>/<filename>` に配置される（`assignAssetLocalPaths`）。
- `node.slug` は `assignPaths` で設定済みで、衝突回避（`used` セット）は本体 MD 名 `<slug>.md` と子ノードの slug ディレクトリ名を含めて行う。
- README「生成される構造」「添付ファイルのローカルダウンロード」「ページ間リンク」は直前の ChangeSpec で更新済み。

### 関連ファイル

| ファイル | 役割 |
|---------|------|
| [main.js](main.js) | パス割当（`assignPaths`、`assignAssetLocalPaths`）、書き出し（`writeAll`）、衝突回避（`resolveAssetFilenameCollision`） |
| [README.md](README.md) | 出力構造・添付配置の公開仕様 |

## 変更内容

- **変更**: [main.js:557-566](main.js#L557-L566) `assignPaths()` を以下の構造に変更する:
  - 本体 MD のパス: `outRelPath = parentRelDir ? ${parentRelDir}/${slug}.md : ${slug}.md`
  - 子ノードへ渡すパス（サイドカーディレクトリ）: `childDir = parentRelDir ? ${parentRelDir}/${slug} : slug`
  - 子の再帰は `assignPaths(child, childDir)` を呼ぶ
  - `node.slug = slug` の保持は継続する
- **変更**: [main.js:663-682](main.js#L663-L682) `assignAssetLocalPaths()` の添付配置先とそれに伴う衝突回避を変更する:
  - 添付の配置先 `assetDir` はサイドカーディレクトリ（本体 MD と同名、拡張子なし）。`node.outRelPath` から `.md` 拡張子を除いたパスに等しい。具体的には `assetDir = node.outRelPath.replace(/\.md$/, "")` ないし、`pageRelDir` と `node.slug` から合成する。
  - `localRelPath = ${assetDir}/${filename}`
  - 衝突回避の `used` 初期値:
    - 子ノードの MD ファイル名（`<child.slug>.md`）
    - 子ノードのサイドカーディレクトリ名（`<child.slug>`）
  - 本体 MD 名 `<slug>.md` はサイドカーディレクトリ内には存在しない（親階層側にある）ため `used` から除外する。
- **変更**: [README.md](README.md) の「生成される構造」「添付ファイルのローカルダウンロード」「ページ間リンク」「YAML frontmatter」の各セクションを新構造に合わせて更新する:
  - ツリー図をサイドカー構造に差し替える
  - `<slug>.md` 冒頭に frontmatter が付与される点の表現は維持（変更不要）
  - 添付セクションの衝突回避対象を「子ノードの MD 名」「子ノードのサイドカー名」に更新（本体 MD 名との衝突はサイドカー内では発生しないため削除）
  - ページ間リンクの例を `./<slug>/<child>.md`、`../<slug>.md` 等、新構造に合わせる

以下は変更対象外:

- `<slug>` の生成ロジック（`dirSlug`、`sanitizeTitle`、`clampUtf8Bytes`）
- 添付のダウンロード・並列度・タイムアウト等の挙動
- リンク解決ロジック（`resolveLinks` は `outRelPath`・`localRelPath` の変更を透過的に扱える）
- 後方互換・マイグレーション（出力は使い捨て前提）

## 影響範囲

- **パス関連**: `assignPaths`、`assignAssetLocalPaths`、`writeAll`、`downloadAsset`、`resolveLinks` が `outRelPath` / `localRelPath` を参照する。値が変わるだけで `path.dirname` ベースの算出は自動追従する。
- **リンク書き換え**: `resolveLinks` の `toRelativePosix(pageDir, ...)` 計算は `pageDir` と対象パスが両方同時に変わる。ページ間相対パスは自然に更新される（例: 親→子 `./<slug>/<child>.md`、子→親 `../<slug>.md`）。
- **添付リンク**: 本文中の添付参照は `<pageRelDir>/<filename>` から `<pageRelDir>/<slug>/<filename>` に変わり、相対パスが 1 階層深くなる（例: `./image.png` → `./<slug>/image.png`）。
- **frontmatter の `files` プロパティ**: `notion-asset:` プレースホルダ経由で `resolveLinks` により解決されるため、同様に自動追従する。
- **ルート出力位置**: 直前まで `out/<root>/<root>.md` だったものが `out/<root>.md` に変わる。既存 `out/` 内の旧構造は削除されず残る（使い捨て前提）。
- **葉ページ（添付・子なし）**: サイドカーディレクトリは作られず、単独の `<slug>.md` のみが出力される。
- **テスト**: リポジトリにテストコードは存在しない。手動での再実行・目視確認による検証となる。

## 関連 ADR

- なし

## 受け入れ条件

- [ ] ルートページを実行すると、`out/<slug>.md` としてページ本体が出力される（ルートを包むディレクトリは作られない）
- [ ] 添付を持つページで、添付が `out/<slug>/<filename>` に保存される（本体 MD `out/<slug>.md` はサイドカーディレクトリの外）
- [ ] 子ページを持つページで、子ページが `out/<slug>/<child-slug>.md` として出力される
- [ ] 添付も子ページも持たない葉ページでは、サイドカーディレクトリが作成されず `<slug>.md` のみが出力される
- [ ] ページ間リンクが相対パスで正しく解決される（例: 親から子 `./<slug>/<child-slug>.md`、子から親 `../<slug>.md`、兄弟子ページ間 `./<sibling-slug>.md`）
- [ ] 本文中の画像・動画・PDF・ファイル参照が、`./<slug>/<filename>` 形式のローカル相対パスに書き換わる
- [ ] データベースページの `files` プロパティの frontmatter 値が、ローカル相対パス配列になる
- [ ] 添付ファイル名が当該ページの子ノードの MD 名（`<child-slug>.md`）と一致する場合、`<base>-<blockId 先頭 8>` 形式で解決される
- [ ] 添付ファイル名が当該ページの子ノードのサイドカーディレクトリ名（`<child-slug>`）と一致する場合、`<base>-<blockId 先頭 8>` 形式で解決される
- [ ] 同一ページ内の同名添付同士の衝突回避が従来通り `<base>-<blockId 先頭 8>` 形式で機能する（回帰確認）
- [ ] README の「生成される構造」「添付ファイルのローカルダウンロード」「ページ間リンク」が新構造と一致する
- [ ] 既存の動作（クロール、frontmatter 生成、ダウンロード、終了コード、警告出力）が変更前と同じ挙動を維持する
