import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  $getDatabasePages,
  $getPageFullContent,
  BasicRichTextFormatter,
  NotionMarkdownConverter,
  extractPageId,
  isBookmarkBlock,
  isBreadcrumbBlock,
  isBulletedListItemBlock,
  isCalloutBlock,
  isCodeBlock,
  isColumnListBlock,
  isDividerBlock,
  isEmbedBlock,
  isEquationBlock,
  isFileBlock,
  isHeading1Block,
  isHeading2Block,
  isHeading3Block,
  isImageBlock,
  isLinkPreviewBlock,
  isNumberedListItemBlock,
  isParagraphBlock,
  isPdfBlock,
  isQuoteBlock,
  isSyncedBlock,
  isTableBlock,
  isTableOfContentsBlock,
  isToDoBlock,
  isToggleBlock,
  isVideoBlock,
} from "@notion-md-converter/core";
import { Client } from "@notionhq/client";

const stripHyphens = (id) => id.replace(/-/g, "");

const addHyphens = (idNoHyphens) => {
  const s = idNoHyphens;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
};

const notionUrl = (idNoHyphens) => `https://www.notion.so/${idNoHyphens}`;

const extractPageTitle = (pageMeta) => {
  const titleProp = Object.values(pageMeta.properties || {}).find((p) => p.type === "title");
  if (!titleProp) return "untitled";
  const text = (titleProp.title || []).map((t) => t.plain_text).join("");
  return text || "untitled";
};

const extractDbTitle = (dbMeta) => {
  const text = (dbMeta.title || []).map((t) => t.plain_text).join("");
  return text || "untitled";
};

const sanitizeTitle = (title) => {
  return title
    .replace(/[\/\\:\*\?"<>\|\x00-\x1F]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
};

const byteLength = (str) => new TextEncoder().encode(str).length;

const clampUtf8Bytes = (str, maxBytes) => {
  if (byteLength(str) <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(str.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo);
};

const SHORT_ID_LEN = 8;
const MAX_NAME_BYTES = 240;

const dirSlug = (title, shortId) => {
  const suffix = `-${shortId}`;
  const cleaned = sanitizeTitle(title || "");
  if (!cleaned) return `untitled${suffix}`;
  const clamped = clampUtf8Bytes(cleaned, MAX_NAME_BYTES - byteLength(suffix));
  if (!clamped) return `untitled${suffix}`;
  return `${clamped}${suffix}`;
};

const escapeLinkText = (text) => text.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");

const walkRefs = (blocks, refs = []) => {
  for (const block of blocks) {
    if (block.type === "child_page") {
      refs.push({ kind: "child_page", id: stripHyphens(block.id), blockId: block.id });
    } else if (block.type === "child_database") {
      refs.push({ kind: "child_database", id: stripHyphens(block.id), blockId: block.id });
    } else if (block.type === "link_to_page") {
      const target = block.link_to_page;
      if (target?.type === "page_id" && target.page_id) {
        refs.push({ kind: "link_page", id: stripHyphens(target.page_id) });
      } else if (target?.type === "database_id" && target.database_id) {
        refs.push({ kind: "link_database", id: stripHyphens(target.database_id) });
      }
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      walkRefs(block.children, refs);
    }
  }
  return refs;
};

const convertProperty = (prop) => {
  if (!prop || typeof prop !== "object") return undefined;
  switch (prop.type) {
    case "title":
    case "rich_text": {
      const arr = prop[prop.type] || [];
      return arr.map((t) => t.plain_text).join("");
    }
    case "url":
    case "email":
    case "phone_number": {
      const v = prop[prop.type];
      return v || undefined;
    }
    case "number":
      return prop.number ?? undefined;
    case "checkbox":
      return prop.checkbox ?? undefined;
    case "select":
      return prop.select?.name;
    case "status":
      return prop.status?.name;
    case "multi_select":
      return (prop.multi_select || []).map((s) => s.name);
    case "date":
      if (!prop.date) return undefined;
      return { start: prop.date.start, end: prop.date.end, time_zone: prop.date.time_zone };
    case "people":
      return (prop.people || []).map((u) => u.name || u.id);
    case "files":
      return (prop.files || [])
        .map((f) => (f.type === "file" ? f.file?.url : f.type === "external" ? f.external?.url : null))
        .filter((u) => typeof u === "string" && u.length > 0);
    case "relation":
      return (prop.relation || []).map((r) => r.id);
    case "formula": {
      const f = prop.formula;
      if (!f) return undefined;
      if (f.type === "number") return f.number ?? undefined;
      if (f.type === "string") return f.string ?? undefined;
      if (f.type === "boolean") return f.boolean ?? undefined;
      if (f.type === "date") {
        if (!f.date) return undefined;
        return { start: f.date.start, end: f.date.end, time_zone: f.date.time_zone };
      }
      return undefined;
    }
    case "created_by":
    case "last_edited_by": {
      const u = prop[prop.type];
      return u?.name || u?.id;
    }
    case "unique_id": {
      const u = prop.unique_id;
      if (!u) return undefined;
      return u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
    }
    case "rollup": {
      const r = prop.rollup;
      if (!r) return undefined;
      if (r.type === "array") {
        return (r.array || [])
          .map((item) => convertProperty(item))
          .filter((v) => v !== undefined);
      }
      if (r.type === "number") return r.number ?? undefined;
      if (r.type === "date") {
        if (!r.date) return undefined;
        return { start: r.date.start, end: r.date.end, time_zone: r.date.time_zone };
      }
      return undefined;
    }
    default:
      return undefined;
  }
};

const convertProperties = (properties) => {
  const out = {};
  for (const [key, prop] of Object.entries(properties || {})) {
    const v = convertProperty(prop);
    if (v !== undefined) out[key] = v;
  }
  return out;
};

class MentionHrefRewriter extends BasicRichTextFormatter {
  format(richText, options) {
    const rewritten = richText.map((token) => {
      if (token?.type === "mention" && token.mention) {
        const m = token.mention;
        let targetId = null;
        if (m.type === "page" && m.page?.id) targetId = m.page.id;
        else if (m.type === "database" && m.database?.id) targetId = m.database.id;
        if (targetId) {
          return { ...token, href: `notion-ref:${stripHyphens(targetId)}` };
        }
      }
      return token;
    });
    return super.format(rewritten, options);
  }
}

class HierarchicalConverter extends NotionMarkdownConverter {
  constructor(options, context) {
    super(options);
    this.dbChildren = context.dbChildren;
    this.pageTitles = context.pageTitles;
  }

  transformBlocks(blocks) {
    const ctx = {
      execute: (bs) => this.transformBlocks(bs),
      blocks,
      currentBlock: blocks[0],
      currentBlockIndex: 0,
      tools: this.tools,
    };
    return blocks
      .map((block, index) => {
        ctx.currentBlock = block;
        ctx.currentBlockIndex = index;
        if (block.type === "child_page") return this.#renderChildPage(block);
        if (block.type === "child_database") return this.#renderChildDatabase(block);
        if (block.type === "link_to_page") return this.#renderLinkToPage(block);
        if (isBookmarkBlock(block)) return this.transformers.bookmark?.(ctx) ?? "";
        if (isBreadcrumbBlock(block)) return this.transformers.breadcrumb?.(ctx) ?? "";
        if (isCalloutBlock(block)) return this.transformers.callout?.(ctx) ?? "";
        if (isCodeBlock(block)) return this.transformers.code?.(ctx) ?? "";
        if (isColumnListBlock(block)) return this.transformers.column_list?.(ctx) ?? "";
        if (isDividerBlock(block)) return this.transformers.divider?.(ctx) ?? "";
        if (isEquationBlock(block)) return this.transformers.equation?.(ctx) ?? "";
        if (isHeading1Block(block) || isHeading2Block(block) || isHeading3Block(block))
          return this.transformers.heading?.(ctx) ?? "";
        if (isLinkPreviewBlock(block)) return this.transformers.link_preview?.(ctx) ?? "";
        if (isBulletedListItemBlock(block)) return this.transformers.bulleted_list_item?.(ctx) ?? "";
        if (isNumberedListItemBlock(block)) return this.transformers.numbered_list_item?.(ctx) ?? "";
        if (isToDoBlock(block)) return this.transformers.to_do?.(ctx) ?? "";
        if (isParagraphBlock(block)) return this.transformers.paragraph?.(ctx) ?? "";
        if (isQuoteBlock(block)) return this.transformers.quote?.(ctx) ?? "";
        if (isSyncedBlock(block)) return this.transformers.synced_block?.(ctx) ?? "";
        if (isTableOfContentsBlock(block)) return this.transformers.table_of_contents?.(ctx) ?? "";
        if (isTableBlock(block)) return this.transformers.table?.(ctx) ?? "";
        if (isToggleBlock(block)) return this.transformers.toggle?.(ctx) ?? "";
        if (isEmbedBlock(block)) return this.transformers.embed?.(ctx) ?? "";
        if (isImageBlock(block)) return this.transformers.image?.(ctx) ?? "";
        if (isVideoBlock(block)) return this.transformers.video?.(ctx) ?? "";
        if (isPdfBlock(block)) return this.transformers.pdf?.(ctx) ?? "";
        if (isFileBlock(block)) return this.transformers.file?.(ctx) ?? "";
        return null;
      })
      .filter((v) => v != null)
      .join("\n");
  }

  #renderChildPage(block) {
    const id = stripHyphens(block.id);
    const rawTitle = block.child_page?.title;
    const title = rawTitle || this.pageTitles.get(id) || id;
    return `[${escapeLinkText(title)}](notion-ref:${id})`;
  }

  #renderChildDatabase(block) {
    const id = stripHyphens(block.id);
    const rawTitle = block.child_database?.title;
    const title = rawTitle || this.pageTitles.get(id) || id;
    const children = this.dbChildren.get(block.id) || [];
    if (children.length === 0) return `## ${title}`;
    const list = children
      .map((c) => `- [${escapeLinkText(c.title)}](notion-ref:${c.id})`)
      .join("\n");
    return `## ${title}\n\n${list}`;
  }

  #renderLinkToPage(block) {
    const target = block.link_to_page;
    let rawId;
    if (target?.type === "page_id") rawId = target.page_id;
    else if (target?.type === "database_id") rawId = target.database_id;
    if (!rawId) return null;
    const id = stripHyphens(rawId);
    const title = this.pageTitles.get(id) || id;
    return `[${escapeLinkText(title)}](notion-ref:${id})`;
  }
}

const crawl = async (client, idInput, state, opts = {}) => {
  const id = extractPageId(idInput);
  if (state.visited.has(id)) return state.visited.get(id);

  const kind = opts.kind || "page";

  if (kind === "db") {
    const dbMeta = await client.databases.retrieve({ database_id: id });
    const title = extractDbTitle(dbMeta);
    const node = {
      id,
      title,
      kind: "db",
      url: dbMeta.url || notionUrl(id),
      createdTime: dbMeta.created_time,
      lastEditedTime: dbMeta.last_edited_time,
      blocks: [],
      children: [],
    };
    state.visited.set(id, node);
    state.pageTitles.set(id, title);
    state.visitOrder += 1;
    process.stderr.write(`[${state.visitOrder}] ${title} (${id})\n`);

    let pages;
    try {
      pages = await $getDatabasePages(client, id);
    } catch (err) {
      state.hasFailure = true;
      process.stderr.write(`[warn] fetch failed: ${id}: ${err.message}\n`);
      return node;
    }
    for (const page of pages) {
      try {
        const child = await crawl(client, page.id, state, { kind: "db_page" });
        node.children.push(child);
      } catch (err) {
        state.hasFailure = true;
        process.stderr.write(`[warn] fetch failed: ${stripHyphens(page.id)}: ${err.message}\n`);
      }
    }
    return node;
  }

  const pageMeta = await client.pages.retrieve({ page_id: id });
  const title = extractPageTitle(pageMeta);
  const blocks = await $getPageFullContent(client, id);

  const node = {
    id,
    title,
    kind,
    properties: kind === "db_page" ? pageMeta.properties : undefined,
    url: pageMeta.url || notionUrl(id),
    createdTime: pageMeta.created_time,
    lastEditedTime: pageMeta.last_edited_time,
    blocks,
    children: [],
  };
  state.visited.set(id, node);
  state.pageTitles.set(id, title);
  state.visitOrder += 1;
  process.stderr.write(`[${state.visitOrder}] ${title} (${id})\n`);

  const refs = walkRefs(blocks);
  for (const ref of refs) {
    try {
      if (ref.kind === "child_page") {
        const child = await crawl(client, ref.id, state, { kind: "page" });
        if (!state.parentOf.has(child.id)) {
          state.parentOf.set(child.id, node.id);
          node.children.push(child);
        }
      } else if (ref.kind === "link_page") {
        const child = await crawl(client, ref.id, state, { kind: "page" });
        if (!state.parentOf.has(child.id)) {
          state.parentOf.set(child.id, node.id);
          node.children.push(child);
        }
      } else if (ref.kind === "child_database") {
        const dbNode = await crawl(client, ref.id, state, { kind: "db" });
        if (!state.parentOf.has(dbNode.id)) {
          state.parentOf.set(dbNode.id, node.id);
          node.children.push(dbNode);
        }
        state.dbChildren.set(ref.blockId, dbNode.children.map((c) => ({ id: c.id, title: c.title })));
      } else if (ref.kind === "link_database") {
        const dbNode = await crawl(client, ref.id, state, { kind: "db" });
        if (!state.parentOf.has(dbNode.id)) {
          state.parentOf.set(dbNode.id, node.id);
          node.children.push(dbNode);
        }
      }
    } catch (err) {
      state.hasFailure = true;
      process.stderr.write(`[warn] fetch failed: ${ref.id}: ${err.message}\n`);
    }
  }

  return node;
};

const assignPaths = (node, parentRelDir) => {
  const shortId = node.id.slice(0, SHORT_ID_LEN);
  const slug = dirSlug(node.title, shortId);
  const relDir = parentRelDir ? `${parentRelDir}/${slug}` : slug;
  node.outRelPath = `${relDir}/index.md`;
  for (const child of node.children) {
    assignPaths(child, relDir);
  }
};

const renderFrontmatter = (node) => {
  const fm = {
    id: addHyphens(node.id),
    title: node.title,
    notion_url: node.url || notionUrl(node.id),
    created_time: node.createdTime,
    last_edited_time: node.lastEditedTime,
  };
  if (node.kind === "db_page" && node.properties) {
    Object.assign(fm, convertProperties(node.properties));
  }
  return yaml.dump(fm, { lineWidth: -1, noRefs: true });
};

const renderPage = (node, converter) => {
  const fmStr = renderFrontmatter(node);
  let body;
  if (node.kind === "db") {
    const title = node.title;
    const items = node.children
      .map((c) => `- [${escapeLinkText(c.title)}](notion-ref:${c.id})`)
      .join("\n");
    body = items ? `## ${title}\n\n${items}` : `## ${title}`;
  } else {
    body = converter.execute(node.blocks);
  }
  return `---\n${fmStr}---\n\n${body}\n`;
};

const resolveLinks = (renderedMap, state, outDir) => {
  const warned = new Set();
  const resolvedMap = new Map();
  for (const [pageId, { content, node }] of renderedMap) {
    const fullPath = path.join(outDir, node.outRelPath);
    const pageDir = path.dirname(fullPath);
    const resolved = content.replace(/notion-ref:([a-f0-9]{32})/g, (_, targetId) => {
      const targetNode = state.visited.get(targetId);
      if (targetNode && targetNode.outRelPath) {
        const targetPath = path.join(outDir, targetNode.outRelPath);
        let rel = path.relative(pageDir, targetPath);
        rel = rel.split(path.sep).join("/");
        if (!rel.startsWith(".") && !rel.startsWith("/")) rel = `./${rel}`;
        return rel;
      }
      if (!warned.has(targetId)) {
        warned.add(targetId);
        process.stderr.write(`[warn] unresolved page link: ${notionUrl(targetId)}\n`);
      }
      return notionUrl(targetId);
    });
    resolvedMap.set(pageId, resolved);
  }
  return resolvedMap;
};

const writeAll = async (resolvedMap, renderedMap, outDir) => {
  await fs.mkdir(outDir, { recursive: true });
  for (const [pageId, content] of resolvedMap) {
    const { node } = renderedMap.get(pageId);
    const fullPath = path.join(outDir, node.outRelPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
};

const main = async () => {
  const pageIdInput = process.argv[2];
  const outDir = process.argv[3] || "./out";
  if (!pageIdInput) {
    process.stderr.write("Usage: node --env-file=.env main.js <pageId> [outDir]\n");
    process.exit(1);
  }

  const client = new Client({ auth: process.env.NOTION_TOKEN });

  const state = {
    visited: new Map(),
    dbChildren: new Map(),
    pageTitles: new Map(),
    parentOf: new Map(),
    visitOrder: 0,
    hasFailure: false,
  };

  let rootNode;
  try {
    rootNode = await crawl(client, pageIdInput, state, { kind: "page" });
  } catch (err) {
    process.stderr.write(`[error] root page fetch failed: ${err.message}\n`);
    process.exit(1);
  }

  assignPaths(rootNode, "");

  const rtFormatter = new MentionHrefRewriter();
  const converter = new HierarchicalConverter(
    { tools: { richTextFormatter: rtFormatter } },
    { dbChildren: state.dbChildren, pageTitles: state.pageTitles },
  );

  const renderedMap = new Map();
  for (const node of state.visited.values()) {
    if (!node.outRelPath) continue;
    const content = renderPage(node, converter);
    renderedMap.set(node.id, { content, node });
  }

  const resolvedMap = resolveLinks(renderedMap, state, outDir);
  await writeAll(resolvedMap, renderedMap, outDir);

  process.exit(state.hasFailure ? 2 : 0);
};

main();
