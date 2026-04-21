# article-export

Notion ページを、サブページやデータベース内ページを含めて階層クロールし、
ローカルディレクトリに Markdown として書き出すスクリプト。

## セットアップ

```bash
npm install
cp .env.example .env
# .env の NOTION_TOKEN を Notion インテグレーションのトークンに書き換える
```

ルートとなる親ページおよび、クロール対象となる全てのサブページ・データベースに、
作成したインテグレーションを接続しておくこと。未接続のページはクロール対象外となり、
警告を出して処理は継続される。

## 使い方

```bash
node --env-file=.env main.js <pageId> [outDir]
```

- `<pageId>`: Notion ページ URL 末尾のハイフンなし 32 文字の ID
- `[outDir]`: 出力先ディレクトリ（省略時は `./out`）

例:

```bash
node --env-file=.env main.js cadb799680ff4dea9016854d930d845e ./out
```

`npm start` 経由でも実行できる（引数は `--` の後ろに置く）:

```bash
npm start -- cadb799680ff4dea9016854d930d845e ./out
```

## 生成される構造

各ページは個別のディレクトリに配置され、本文は `index.md` として出力される。
ディレクトリ名は `<サニタイズ済みタイトル>-<pageId 先頭 8 文字>` の形式。

```
out/
└── <root>/
    ├── index.md
    ├── <child_page>/
    │   └── index.md
    └── <child_database>/
        ├── index.md
        ├── <db_page_1>/
        │   └── index.md
        └── <db_page_2>/
            └── index.md
```

- タイトル中の OS 非互換文字（`/ \ : * ? " < > |` および制御文字）は `_` に置換される
- タイトル空の場合は `untitled-<shortId>`
- ファイル名は UTF-8 で 240 バイト以内に収まるよう、タイトル部が自動で切り詰められる
- 出力先が既に存在する場合、ファイルは上書きされるが、クロール対象外となった前回出力は削除されない（使い捨て前提）

## YAML frontmatter

各 `index.md` 冒頭に以下の共通項目が付与される:

- `id`（ハイフン付き Notion ID）
- `title`
- `notion_url`
- `created_time`, `last_edited_time`

データベース内ページでは、加えて Notion プロパティが型変換されて展開される。
サポート外の型のプロパティは出力から省略される（`null` にはしない）。

| Notion 型 | YAML への表現 |
|---|---|
| title, rich_text, url, email, phone_number | 文字列 |
| number, checkbox | そのままの値 |
| select, status | 選択肢名（文字列） |
| multi_select | 選択肢名の配列 |
| date | `{ start, end, time_zone }` |
| people | 名前（無ければ `id`）の配列 |
| files | URL 文字列の配列 |
| relation | 相手ページ ID の配列 |
| formula | 計算結果（number / string / boolean / date） |
| created_by, last_edited_by | ユーザー名（無ければ `id`） |
| unique_id | `<prefix>-<number>` 文字列 |
| rollup | array なら配列、単一値ならその型 |

## ページ間リンク

本文中の `child_page` / `child_database` / `link_to_page` ブロック、および
rich_text 中のページ／データベース mention は、出力後のファイル間の相対パスに
書き換えられる（例: `./sub/index.md`、`../db/page-a1b2c3d4/index.md`）。

クロール対象外のページへの参照は `https://www.notion.so/<id>` に置換され、
stderr に `[warn] unresolved page link: <url>` が出力される（同一 ID につき 1 回）。

## 終了コード

- `0`: 全ページが正常にクロール・出力された
- `1`: ルートページの取得に失敗した（致命）
- `2`: 一部の子ページ／DB ページが失敗し、残りは出力された（部分出力）

進捗・警告・エラーはすべて stderr に出力され、stdout は使用しない。

## 必要環境

- Node.js 20.6 以上（`--env-file` フラグ使用のため）
