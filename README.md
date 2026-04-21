# article-export

Notion ページを Markdown に変換して標準出力に出力するスクリプト。

## セットアップ

```bash
npm install
cp .env.example .env
# .env の NOTION_TOKEN を Notion インテグレーションのトークンに書き換える
```

対象の Notion ページに、作成したインテグレーションを接続しておくこと。

## 使い方

```bash
node --env-file=.env main.js <pageId>
```

`<pageId>` は Notion ページ URL 末尾のハイフンなし32文字の ID。

例:

```bash
node --env-file=.env main.js cadb799680ff4dea9016854d930d845e > article.md
```

## 必要環境

- Node.js 20.6 以上（`--env-file` フラグ使用のため）
