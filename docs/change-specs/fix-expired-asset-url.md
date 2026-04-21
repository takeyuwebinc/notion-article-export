# ChangeSpec: 添付ファイルの署名URL期限切れ耐性とダウンロードの堅牢化

## 変更の目的

大規模なページツリーを export する際、`crawl` 完了から `downloadAssets` 実行までに時間が経ち、Notion が発行した S3 署名 URL（`X-Amz-Expires=3600`、1時間）が失効してダウンロードに失敗するケースがある。また、失敗時のログが分かりにくい（実際には JavaScript の TypeError `Cannot read properties of null (reading 'split')` が URL 期限切れのように誤解される状況がある）ため、期限切れ耐性と失敗時の堅牢性を同時に改善する。

## 現状

### アセットダウンロードのフロー

[main.js](../../main.js) の `main` 関数（[main.js:775-836](../../main.js#L775-L836)）は、以下の順序で処理を行う:

1. `crawl` で全ページをクロールし、各ブロックの署名 URL を含むブロック情報を取得（[main.js:798](../../main.js#L798)）
2. `assignPaths` で各ノードの出力パスを決定（[main.js:804](../../main.js#L804)）
3. `collectAssets` で全ブロックからアセットを集約し、`allAssets[]` と `pageAssetsByPageId` に登録（[main.js:806](../../main.js#L806)、[main.js:620-666](../../main.js#L620-L666)）
4. `assignAssetLocalPaths` で各アセットの保存先パス（`filename` / `localRelPath`）を決定（[main.js:807](../../main.js#L807)、[main.js:668-689](../../main.js#L668-L689)）
5. `downloadAssets` で `DOWNLOAD_CONCURRENCY=3`（[main.js:142](../../main.js#L142)）の並列ワーカーで全アセットを順次ダウンロード（[main.js:811](../../main.js#L811)、[main.js:700-732](../../main.js#L700-L732)）

署名 URL はステップ 1 の `crawl` 時点で Notion API のレスポンスに含まれる値をそのまま保持している。ステップ 5 に到達した時点で `X-Amz-Date` から 1 時間以上経過している場合、HTTP 403 が返る。

### 現状の失敗時の挙動

`downloadAsset`（[main.js:691-698](../../main.js#L691-L698)）は以下の実装:

```js
const downloadAsset = async (asset, outDir) => {
  const fullPath = path.join(outDir, asset.localRelPath.split("/").join(path.sep));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const res = await fetch(asset.signedUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error("empty response body");
  await pipeline(res.body, createWriteStream(fullPath));
};
```

以下の弱点がある:

- `asset.localRelPath` が `null` の場合、先頭の `.split("/")` で TypeError が投げられ `[warn] asset download failed: ... Cannot read properties of null (reading 'split')` として報告される。`assignAssetLocalPaths` は `node.outRelPath` が無いページのアセットをスキップする（[main.js:672](../../main.js#L672)）ため、ここで `filename` / `localRelPath` が `null` のまま `allAssets` に残り、ダウンロード時点でクラッシュする。
- HTTP 403（期限切れ）はただの失敗として扱われ、再試行や URL 再取得は行われない。
- 署名 URL の再取得手段は実装されていない。Notion の API では `blocks.retrieve({ block_id })` を呼び出すとブロック内のファイルに対して新しい署名 URL が付与されて返る。

### Notion API の署名 URL の仕様

- Notion が返す内部ファイル URL は AWS S3 の pre-signed URL。`X-Amz-Expires=3600`（1時間）で発行される。
- `blocks.retrieve` で同じブロックを再取得すると、新しい `X-Amz-Date` と署名を持つ URL が返る。
- 署名 URL の有効期限を超過した場合、HTTP 403 が返る（レスポンスボディは XML のエラー）。

### 関連ファイル

| ファイル | 役割 |
|---------|------|
| [main.js](../../main.js) | Notion からページを export する CLI の全処理を 1 ファイルに実装 |
| [main.js:691-698](../../main.js#L691-L698) | `downloadAsset` 関数（単一アセットのダウンロード） |
| [main.js:700-732](../../main.js#L700-L732) | `downloadAssets` 関数（並列ワーカー） |
| [main.js:603-618](../../main.js#L603-L618) | `registerAsset` 関数（アセットレコード生成） |
| [main.js:668-689](../../main.js#L668-L689) | `assignAssetLocalPaths` 関数（保存先パス割り当て） |

## 変更内容

### 1. null localRelPath への防御とログ改善

- **変更**: `downloadAssets` のワーカーループ内で、`asset.localRelPath` が `null` のアセットはダウンロードを試みずにスキップする。スキップ時は `[warn] asset skipped (no local path): {blockId}` の形式で警告ログを出し、`hasFailure = true` を立てる。`downloadAsset` 本体には null チェックを入れない（呼び出し側で弾くため）。
- **変更**: `assignAssetLocalPaths` で `node?.outRelPath` が無いページの `pageAssets.size > 0` を検出したとき、現状の `continue` に加えて警告ログ `[warn] page has assets but no output path: {pageId}` を出力する。根本原因の特定に役立てる診断情報。このログが出た場合も `state.hasFailure = true` を立てられるよう、`assignAssetLocalPaths` は `hasFailure` フラグを返す（現状は戻り値なし）。`main` 側で受け取って `state.hasFailure` に反映する。

### 2. アセットレコードに blockId ベースの再取得情報を保持

- **変更**: `registerAsset`（[main.js:603-618](../../main.js#L603-L618)）が生成する asset レコードに、現在の `blockId`（stripHyphens 済み）とは別に、再取得に使う `sourceBlockId`（ハイフン付きの Notion API 用 ID）を保持する。現状 `blockId` は表示用に stripHyphens されているため、`blocks.retrieve` には使いにくい。
  - ページプロパティ由来のアセット（[main.js:640-649](../../main.js#L640-L649)）は block ではなくページなので、`sourceKind: "page"` と `sourcePageId` を代わりに保持する。
- **変更**: `collectAssetsFromBlocks` および `collectAssetsFromProperties` が `registerAsset` に渡すパラメータを上記に合わせて拡張。

### 3. 署名 URL の再取得とリトライロジック

- **追加**: `refreshAssetUrl(client, asset)` 関数を [main.js](../../main.js) の `downloadAsset` の直前（概ね L691 付近）に追加。既存の `isNotionInternalFile` / `extractUrlPath` / `withRateLimitRetry` / `getInternalFileUrl` に依存する。
  - `sourceKind: "block"` の場合: `client.blocks.retrieve({ block_id: sourceBlockId })` を呼び、レスポンスから新しい内部ファイル URL を取り出して `asset.signedUrl` を更新する。取得したブロックの `type` が `image` / `video` / `pdf` / `file` のいずれかで、`isNotionInternalFile` を通る場合のみ URL を抽出。
  - `sourceKind: "page"` の場合: `client.pages.retrieve({ page_id: sourcePageId })` を呼び、ページの `files` プロパティから `extractUrlPath` で比較して `urlPath` が一致するファイルの内部 URL を取り出して更新する。
  - URL が取得できない場合はエラーを投げる。
  - `client.blocks.retrieve` / `client.pages.retrieve` 自体が失敗した場合（レートリミット以外のネットワーク・権限エラー等）、例外は上位に伝播させる。上位の呼び出し側（`downloadAsset` 内のリトライ箇所）で catch し、元の 403 エラーと合わせて warn に記録してスキップする。
  - Notion API のレートリミットに備えて既存の `withRateLimitRetry` を通す。
- **変更**: `downloadAsset` を修正し、HTTP 403 を検知した場合に限り、レスポンスボディを `res.text()` で読み取って `"Request has expired"` が含まれているかを判定する（それ以外の 403 は権限不足等の本質的エラーとして扱い、再試行しない）。条件に合致した場合は `refreshAssetUrl` を呼び、成功したら新しい URL で `fetch` を 1 回だけ再実行する。
- **変更**: 期限切れリトライは 1 アセットあたり最大 1 回。再試行後も失敗した場合（新しい URL でも 403、または `refreshAssetUrl` が失敗）は警告ログ `[warn] asset download failed after url refresh: {blockId} {reason}` を出してスキップする。

### 4. 定数の整理

- **追加**: [main.js:141-144](../../main.js#L141-L144) の定数定義ブロックに、期限切れトリガーの HTTP ステータスを表す定数を追加（例: `ASSET_URL_REFRESH_STATUS = 403`）。

## 影響範囲

- [main.js:141-144](../../main.js#L141-L144) 定数ブロック: `ASSET_URL_REFRESH_STATUS` 定数を追加。
- [main.js:603-618](../../main.js#L603-L618) `registerAsset`: レコード形状が拡張される（`sourceKind` / `sourceBlockId` / `sourcePageId`）。
- [main.js:620-649](../../main.js#L620-L649) `collectAssetsFromBlocks` / `collectAssetsFromProperties`: `registerAsset` への呼び出し引数が拡張される。
- [main.js:668-689](../../main.js#L668-L689) `assignAssetLocalPaths`: 警告ログ追加、戻り値として `hasFailure` を返すよう変更。既存のスキップ動作は維持。
- L691 付近: 新規関数 `refreshAssetUrl(client, asset)` を追加。既存の `isNotionInternalFile` / `getInternalFileUrl` / `extractUrlPath` / `withRateLimitRetry` に依存。
- [main.js:691-698](../../main.js#L691-L698) `downloadAsset`: 403 検知時に `res.text()` でボディを読み、`"Request has expired"` の場合は `refreshAssetUrl` 経由で URL を更新して 1 回リトライ。`client` 引数を追加。
- [main.js:700-732](../../main.js#L700-L732) `downloadAssets`: null `localRelPath` の事前スキップ処理を追加。`client` 引数を追加して `downloadAsset` に渡す。
- [main.js:795-836](../../main.js#L795-L836) `main`: `downloadAssets` 呼び出しに `client` を追加。`assignAssetLocalPaths` の戻り値 `hasFailure` を `state.hasFailure` に反映。
- Notion API 呼び出し回数: 期限切れがない通常系では現状と同じ。期限切れが発生するたびに該当アセットにつき 1 回の `blocks.retrieve` または `pages.retrieve` が増える。
- テスト: このリポジトリには現状テストコードは存在しない（package.json に test script なし、テストファイルなし）。受け入れ条件はすべて手動検証で確認する。

## 関連 ADR

なし。既存の単一ファイル実装の範囲内での変更であり、アーキテクチャパターンの変更は含まない。

## 受け入れ条件

- [ ] 署名 URL が期限切れのアセットに対して、`blocks.retrieve` / `pages.retrieve` で再取得した URL を使って正常にダウンロードできる（手動検証: `asset.signedUrl` を期限切れ相当の URL に差し替えるパッチをあててローカル実行し、リトライ経路を通すことで確認する）
- [ ] `localRelPath` が `null` のアセットがあっても、TypeError でクラッシュせず `[warn] asset skipped (no local path): {blockId}` が出力される
- [ ] `outRelPath` が無いページがアセットを保持している場合、`[warn] page has assets but no output path: {pageId}` の形式で警告が出る
- [ ] 上記いずれかの警告が発生した場合、プロセスの終了コードが 2（`state.hasFailure` 経由）になる
- [ ] 403 かつ `"Request has expired"` でない場合（権限エラー等）、URL 再取得は試行されず、従来通りのエラー warn が出る
- [ ] URL 再取得後のリトライでも失敗した場合、`[warn] asset download failed after url refresh: {blockId} {reason}` が出てプロセスは継続する
- [ ] `refreshAssetUrl` が `blocks.retrieve` / `pages.retrieve` の失敗で例外を投げた場合も、`downloadAsset` 内で捕捉されて warn・スキップされる
- [ ] ページプロパティの files 型（例: データベースのファイル添付）のアセットに対しても URL 再取得が動作する
