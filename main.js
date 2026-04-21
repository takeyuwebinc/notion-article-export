import { $getPageFullContent, NotionMarkdownConverter } from "@notion-md-converter/core";
import { Client } from "@notionhq/client";

const main = async () => {
  const pageId = process.argv[2];
  if (!pageId) {
    console.error("Usage: node main.js <pageId>");
    process.exit(1);
  }

  const client = new Client({
    auth: process.env.NOTION_TOKEN,
  });

  const content = await $getPageFullContent(client, pageId);

  const executor = new NotionMarkdownConverter();
  const result = executor.execute(content);
  console.log(result);
};

main();
