# ChangeSpec: crawl の parentOf 先回り設定による子孫優先問題の修正

## 変更の目的

ページ間の循環参照（子孫ページから祖先ページへの `link_to_page` など）がある場合、本来の親が `children` に子を登録できず、`assignPaths` で到達できないページが発生する。結果として当該ページには `outRelPath` が割り当てられず、配下のアセットは `[warn] page has assets but no output path` としてスキップされる（[docs/change-specs/fix-expired-asset-url.md](./fix-expired-asset-url.md) で追加された診断ログで顕在化）。実行例 `node --env-file=.env main.js 98a5d53344d842a5ad155d4a43adfcc4` では GA4 関連 3 ページ（`1862e239f6178001...`, `1862e239f617808f...`, `1862e239f6178003...`）がこの事象に該当する。

## 現状

### crawl の親子関係決定ロジック

[main.js:457-560](../../main.js#L457-L560) の `crawl` 関数は、ref ループ内で子を crawl した**後**に親を登録する:

```js
const child = await crawl(client, ref.id, state, { kind: "page" });
if (!state.parentOf.has(child.id)) {
  state.parentOf.set(child.id, node.id);
  node.children.push(child);
}
```

このパターンは以下 5 箇所で使われている:

| 種別 | 該当位置 |
|------|---------|
| db ページ列挙 | [main.js:489-500](../../main.js#L489-L500) |
| child_page | [main.js:527-532](../../main.js#L527-L532) |
| link_page | [main.js:533-538](../../main.js#L533-L538) |
| child_database | [main.js:539-545](../../main.js#L539-L545) |
| link_database | [main.js:546-551](../../main.js#L546-L551) |

### バグの発生条件と機序

循環参照パス `P → C → D → C`（D が C への `link_to_page` を持つ、または child_database 等経由）では以下の順序で処理が進む:

1. P が ref C を crawl 開始
2. C が visited に追加され、C の ref ループへ
3. C が ref D を crawl 開始
4. D が visited に追加され、D の ref ループへ
5. D の ref に C への逆参照がある → `crawl(C)` を呼ぶが、visited なので既存 C ノードを返す
6. D の登録コード: `parentOf.has(C.id)` は **false**（P はまだ C の crawl 戻りを待機中で `parentOf[C]` をセットしていない）→ D が `parentOf[C] = D` を先回りセット、`D.children.push(C)`
7. D が戻り、C が戻る
8. P の登録コード: `parentOf.has(C.id)` は **true**（D がセット済み）→ `P.children.push(C)` がスキップされる

結果として C は `P.children` に入らず、しかし `D.children` の中で循環参照しているだけなので、`assignPaths(rootNode, "")` の深さ優先走査からは到達不能になる（`assignPaths` は [main.js:563](../../main.js#L563) で `if (node.outRelPath) return;` による無限再帰防止を行うが、そもそも到達していないので `outRelPath` は未設定のまま）。

`state.visited` には C は入っているため、後続の `collectAssets` で C のアセットは `allAssets` に積まれる。続く `assignAssetLocalPaths`（[main.js:688-715](../../main.js#L688-L715)）で `node.outRelPath` を見るとき、C に `outRelPath` が無いため `[warn] page has assets but no output path: C.id` が出てアセットはスキップされる。

### 関連ファイル

| ファイル | 役割 |
|---------|------|
| [main.js](../../main.js) | 単一ファイル実装の CLI 全体 |
| [main.js:457-560](../../main.js#L457-L560) | `crawl` 関数本体（db kind と page kind の両分岐を含む） |
| [main.js:562-571](../../main.js#L562-L571) | `assignPaths`（`children` 経由の深さ優先でパス割り当て） |
| [main.js:898-902](../../main.js#L898-L902) | `main` での root 起点設定（`state.parentOf.set(rootId, null);` のあと crawl 呼び出し） |

## 変更内容

`crawl` の ref 処理 5 箇所すべてに **pre-claim パターン** を適用する。`crawl` 呼び出しの**前**に `parentOf.has(childId)` を判定し、未設定ならその場で `parentOf.set(childId, node.id)` して所有権を確定させる。判定結果（= 自分が claim したか）を局所フラグで保持し、`crawl` から戻った後の `children.push` をそのフラグで制御する。

この変更により、子孫側の `crawl` が回り込んで同じ子の `parentOf` を先回りセットしても、その時点で既に祖先側が claim 済みとなるため、子孫側からの claim はすべて no-op になる。

### 具体的変更箇所

- **変更**: [main.js:489-500](../../main.js#L489-L500) db ページ列挙
  - `child.id` を先に求める方法が使えない（db ページは Notion API の `page.id` を経由し `extractPageId` で正規化する必要がある）ため、`extractPageId(page.id)` で事前に `childId` を計算し、`parentOf.has(childId)` による claim 判定 → `parentOf.set` → `crawl` 呼び出し → フラグに応じて `node.children.push` の順に組み替える。
- **変更**: [main.js:527-532](../../main.js#L527-L532) child_page アーム
  - 同様に `extractPageId(ref.id)` で `childId` を先に求め、pre-claim パターンへ組み替え。
- **変更**: [main.js:533-538](../../main.js#L533-L538) link_page アーム
  - 同上。
- **変更**: [main.js:539-545](../../main.js#L539-L545) child_database アーム
  - 同上。ただし `state.dbChildren.set(ref.blockId, dbNode.children.map(...))` は claim の可否に関わらず現状通り実行する（この side effect は元々 claim 判定の外にあり、UI リンク用途のため維持）。
- **変更**: [main.js:546-551](../../main.js#L546-L551) link_database アーム
  - child_database と同様の組み替え。`state.dbChildren.set` はこのアームには元からないので追加・変更なし。

### 設計上の補足

- `parentOf.has` の判定結果を局所変数（例: `claimedByUs`）に束ねて、`crawl` の await 前後で同じ値を参照できるようにする。
- 再入時の安全性: `crawl` は再帰呼び出しで複数レベルの `for (const ref of refs)` が同時に「生きた」状態になる（深い階層の for ループが await 解消前に上位の for ループが resume されない）。ただし JavaScript は単一スレッド・非プリエンプティブに実行され、`await` の境界以外で他のコードが `state.parentOf` を書き換えることはない。各 `await` 境界で見た `parentOf.has` の結果は、同期コードで次に自分が書き換えるまで保持される。pre-claim は `crawl` 呼び出しの **直前の同期コード**で行い、post-push は `crawl` 戻り直後の**同期コード**で判定するため、局所変数 `claimedByUs` の正当性は保たれる。
- root ノードは `main` が `state.parentOf.set(rootId, null);` で事前に claim 済み。本変更でこの挙動は変更しない。
- 既存の `parentOf` の semantics（「このノードの親は誰か」）は維持する。変更されるのは「いつ `set` するか」のみ。

## 影響範囲

- [main.js:457-560](../../main.js#L457-L560) `crawl` の ref 処理 5 箇所。関数シグネチャ・戻り値は変更なし。各アームで局所変数 `claimedByUs` と pre-claim 用の同期ブロックが追加される。
- `state.parentOf` / `state.visited` / `node.children` の semantics は不変。
- 既存の循環参照対策である [main.js:563](../../main.js#L563) `assignPaths` の `if (node.outRelPath) return;` は引き続き有効。本変更でも `assignPaths` の挙動は変わらない。
- Notion API 呼び出し回数の変化なし（visited で重複は既に抑制されている）。
- テスト: リポジトリにテストコードなし。手動検証で確認する。

## 関連 ADR

なし。`parentOf` の既存 semantics 範囲内での不具合修正であり、新たな設計判断を含まない。

## 受け入れ条件

- [ ] 再現コマンド `node --env-file=.env main.js 98a5d53344d842a5ad155d4a43adfcc4` を実行し、`[warn] page has assets but no output path:` が 1 件も出力されないこと
- [ ] 同じ実行で、GA4 関連ページ（ID `1862e239f6178001...`, `1862e239f617808f...`, `1862e239f6178003...`）が `out/` 配下の Markdown として出力され、配下のアセットも正常にダウンロードされていること
- [ ] 循環参照を含まないページツリーの export 結果は、変更前と同一（ファイル構成・各ファイル内容）であること。既知のプロジェクト ID で実装前後の `out/` ディレクトリを比較して差分ゼロを確認する
- [ ] 5 つの ref アーム（child_page / link_page / child_database / link_database / db ページ列挙）それぞれについて、少なくとも 1 件の正常系ページが `assignPaths` で `outRelPath` を受け取ることを確認する。既知のプロジェクトで全 arm を網羅するページ ID を指定して手動検証する
- [ ] `state.dbChildren` の内容（child_database の UI リンク用途）が変更前と同一であること。具体的には、既知プロジェクトの出力 Markdown 中で `## {db名}` セクションの子ページリストが変更前と一致していることで確認する
