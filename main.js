import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import {
  $getPageFullContent,
  BasicRichTextFormatter,
  NotionMarkdownConverter,
  createMarkdownFileTransformer,
  createMarkdownImageTransformer,
  createMarkdownPDFTransformer,
  createMarkdownVideoTransformer,
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
  isNotionExternalFile,
  isNotionInternalFile,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withRateLimitRetry = async (fn) => {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err?.code !== "rate_limited") throw err;
      if (attempt === maxAttempts - 1) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
};

const fetchDatabasePages = async (client, databaseId) => {
  const dbMeta = await withRateLimitRetry(() =>
    client.databases.retrieve({ database_id: databaseId })
  );
  const dataSources = dbMeta.data_sources || [];
  const pages = [];
  for (const ds of dataSources) {
    let cursor;
    do {
      const res = await withRateLimitRetry(() =>
        client.dataSources.query({
          data_source_id: ds.id,
          start_cursor: cursor,
        })
      );
      pages.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }
  return pages;
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

const ASSET_KEY_LEN = 16;
const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const ASSET_FILE_TYPES = new Set(["image", "video", "pdf", "file"]);

const getInternalFileUrl = (fileValue) => {
  if (!isNotionInternalFile(fileValue)) return null;
  const url = fileValue.file?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
};

const getExternalFileUrl = (fileValue) => {
  if (!isNotionExternalFile(fileValue)) return null;
  const url = fileValue.external?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
};

const extractUrlPath = (signedUrl) => {
  try {
    return new URL(signedUrl).pathname;
  } catch {
    return signedUrl.split("?")[0];
  }
};

const computeAssetKey = (pageId, urlPath) =>
  createHash("sha256").update(`${pageId}\0${urlPath}`).digest("hex").slice(0, ASSET_KEY_LEN);

const splitExt = (filename) => {
  const dot = filename.lastIndexOf(".");
  const hasExt = dot > 0 && dot < filename.length - 1;
  return hasExt
    ? { base: filename.slice(0, dot), ext: filename.slice(dot) }
    : { base: filename, ext: "" };
};

const toRelativePosix = (fromDir, targetFullPath) => {
  let rel = path.relative(fromDir, targetFullPath).split(path.sep).join("/");
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = `./${rel}`;
  return rel;
};

const sanitizeAssetFilename = (urlPath, blockId) => {
  const segment = urlPath.split("/").filter((s) => s.length > 0).pop() || "";
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  const shortId = (blockId || "").replace(/-/g, "").slice(0, 8);
  const fallback = `${shortId || "asset"}.bin`;
  if (!decoded || /^\.+$/.test(decoded) || /^\.[^.]*$/.test(decoded)) return fallback;
  const cleaned = decoded
    .replace(/[\/\\:\*\?"<>\|\x00-\x1F]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!cleaned) return fallback;
  const { base, ext } = splitExt(cleaned);
  if (!base) return fallback;
  if (byteLength(`${base}${ext}`) <= MAX_NAME_BYTES) return `${base}${ext}`;
  const clampedBase = clampUtf8Bytes(base, MAX_NAME_BYTES - byteLength(ext));
  return `${clampedBase || shortId || "asset"}${ext}`;
};

const resolveAssetFilenameCollision = (filename, blockId, usedNames) => {
  if (!usedNames.has(filename)) return filename;
  const { base, ext } = splitExt(filename);
  const shortId = (blockId || "").replace(/-/g, "").slice(0, 8) || "asset";
  return `${base}-${shortId}${ext}`;
};

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

const convertProperty = (prop, assetContext) => {
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
        .map((f) => {
          const internalUrl = getInternalFileUrl(f);
          if (internalUrl) {
            if (!assetContext) return internalUrl;
            const urlPath = extractUrlPath(internalUrl);
            const assetKey =
              assetContext.pageAssets?.get(urlPath)?.assetKey ??
              computeAssetKey(assetContext.pageId, urlPath);
            return `notion-asset:${assetKey}`;
          }
          return getExternalFileUrl(f);
        })
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
          .map((item) => convertProperty(item, assetContext))
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

const convertProperties = (properties, assetContext) => {
  const out = {};
  for (const [key, prop] of Object.entries(properties || {})) {
    const v = convertProperty(prop, assetContext);
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
    this.pageAssetsByPageId = context.pageAssetsByPageId || new Map();
    this.currentPageId = null;

    const adapter = (fileObject) => {
      const internalUrl = getInternalFileUrl(fileObject);
      if (internalUrl) {
        if (this.currentPageId) {
          const urlPath = extractUrlPath(internalUrl);
          const asset = this.pageAssetsByPageId.get(this.currentPageId)?.get(urlPath);
          const assetKey = asset?.assetKey ?? computeAssetKey(this.currentPageId, urlPath);
          return { url: `notion-asset:${assetKey}` };
        }
        return { url: internalUrl };
      }
      return { url: getExternalFileUrl(fileObject) || "" };
    };

    this.transformers.image = createMarkdownImageTransformer({ fileAdapter: adapter });
    this.transformers.video = createMarkdownVideoTransformer({ fileAdapter: adapter });
    this.transformers.pdf = createMarkdownPDFTransformer({
      fileAdapter: adapter,
      outputType: "markdown-link",
    });
    this.transformers.file = createMarkdownFileTransformer({ fileAdapter: adapter });
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
      pages = await fetchDatabasePages(client, id);
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
  node.slug = slug;
  node.outRelPath = `${relDir}/${slug}.md`;
  for (const child of node.children) {
    assignPaths(child, relDir);
  }
};

const renderFrontmatter = (node, pageAssets) => {
  const fm = {
    id: addHyphens(node.id),
    title: node.title,
    notion_url: node.url || notionUrl(node.id),
    created_time: node.createdTime,
    last_edited_time: node.lastEditedTime,
  };
  if (node.kind === "db_page" && node.properties) {
    const assetContext = pageAssets ? { pageId: node.id, pageAssets } : undefined;
    Object.assign(fm, convertProperties(node.properties, assetContext));
  }
  return yaml.dump(fm, { lineWidth: -1, noRefs: true });
};

const renderPage = (node, converter, pageAssets) => {
  const fmStr = renderFrontmatter(node, pageAssets);
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

const registerAsset = ({ pageId, url, blockId, pageAssets, allAssets }) => {
  const urlPath = extractUrlPath(url);
  if (pageAssets.has(urlPath)) return;
  const record = {
    assetKey: computeAssetKey(pageId, urlPath),
    pageId,
    urlPath,
    signedUrl: url,
    blockId,
    filename: null,
    localRelPath: null,
    downloaded: false,
  };
  pageAssets.set(urlPath, record);
  allAssets.push(record);
};

const collectAssetsFromBlocks = (blocks, pageId, pageAssets, allAssets) => {
  for (const block of blocks) {
    if (ASSET_FILE_TYPES.has(block.type)) {
      const url = getInternalFileUrl(block[block.type]);
      if (url) {
        registerAsset({
          pageId,
          url,
          blockId: stripHyphens(block.id || ""),
          pageAssets,
          allAssets,
        });
      }
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      collectAssetsFromBlocks(block.children, pageId, pageAssets, allAssets);
    }
  }
};

const collectAssetsFromProperties = (properties, pageId, pageAssets, allAssets) => {
  for (const prop of Object.values(properties || {})) {
    if (prop?.type !== "files") continue;
    for (const f of prop.files || []) {
      const url = getInternalFileUrl(f);
      if (!url) continue;
      registerAsset({ pageId, url, blockId: pageId, pageAssets, allAssets });
    }
  }
};

const collectAssets = (state) => {
  const pageAssetsByPageId = new Map();
  const allAssets = [];
  for (const node of state.visited.values()) {
    const pageAssets = new Map();
    pageAssetsByPageId.set(node.id, pageAssets);
    if (node.kind === "db") continue;
    if (Array.isArray(node.blocks)) {
      collectAssetsFromBlocks(node.blocks, node.id, pageAssets, allAssets);
    }
    if (node.kind === "db_page" && node.properties) {
      collectAssetsFromProperties(node.properties, node.id, pageAssets, allAssets);
    }
  }
  return { pageAssetsByPageId, allAssets };
};

const assignAssetLocalPaths = (state, pageAssetsByPageId) => {
  for (const [pageId, pageAssets] of pageAssetsByPageId) {
    if (pageAssets.size === 0) continue;
    const node = state.visited.get(pageId);
    if (!node?.outRelPath) continue;
    const pageRelDir = path.posix.dirname(node.outRelPath.split(path.sep).join("/"));
    const used = new Set();
    used.add(`${node.slug}.md`);
    for (const child of node.children) {
      if (child.slug) used.add(child.slug);
    }
    for (const asset of pageAssets.values()) {
      const base = sanitizeAssetFilename(asset.urlPath, asset.blockId);
      const filename = resolveAssetFilenameCollision(base, asset.blockId, used);
      used.add(filename);
      asset.filename = filename;
      asset.localRelPath = `${pageRelDir}/${filename}`;
    }
  }
};

const downloadAsset = async (asset, outDir) => {
  const fullPath = path.join(outDir, asset.localRelPath.split("/").join(path.sep));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const res = await fetch(asset.signedUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error("empty response body");
  await pipeline(res.body, createWriteStream(fullPath));
};

const downloadAssets = async (assets, outDir) => {
  const total = assets.length;
  if (total === 0) return { hasFailure: false };
  let nextIndex = 0;
  let completed = 0;
  let hasFailure = false;
  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= total) return;
      const asset = assets[i];
      try {
        await downloadAsset(asset, outDir);
        asset.downloaded = true;
      } catch (err) {
        hasFailure = true;
        const reason =
          err?.name === "TimeoutError" || err?.name === "AbortError"
            ? "timeout"
            : err?.message || String(err);
        process.stderr.write(
          `[warn] asset download failed: ${asset.blockId} ${asset.signedUrl}: ${reason}\n`,
        );
      } finally {
        completed += 1;
        process.stderr.write(`[asset ${completed}/${total}] ${asset.filename}\n`);
      }
    }
  };
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);
  return { hasFailure };
};

const resolveLinks = (renderedMap, state, assetsByKey, outDir) => {
  const warned = new Set();
  const resolvedMap = new Map();
  for (const [pageId, { content, node }] of renderedMap) {
    const fullPath = path.join(outDir, node.outRelPath);
    const pageDir = path.dirname(fullPath);
    let resolved = content.replace(/notion-ref:([a-f0-9]{32})/g, (_, targetId) => {
      const targetNode = state.visited.get(targetId);
      if (targetNode && targetNode.outRelPath) {
        return toRelativePosix(pageDir, path.join(outDir, targetNode.outRelPath));
      }
      if (!warned.has(targetId)) {
        warned.add(targetId);
        process.stderr.write(`[warn] unresolved page link: ${notionUrl(targetId)}\n`);
      }
      return notionUrl(targetId);
    });
    resolved = resolved.replace(/notion-asset:([a-f0-9]{16})/g, (match, key) => {
      const asset = assetsByKey.get(key);
      if (!asset) return match;
      if (asset.downloaded && asset.localRelPath) {
        const targetPath = path.join(outDir, asset.localRelPath.split("/").join(path.sep));
        return toRelativePosix(pageDir, targetPath);
      }
      return asset.signedUrl;
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

  const { pageAssetsByPageId, allAssets } = collectAssets(state);
  assignAssetLocalPaths(state, pageAssetsByPageId);

  const assetsByKey = new Map(allAssets.map((a) => [a.assetKey, a]));

  const { hasFailure: dlFailure } = await downloadAssets(allAssets, outDir);
  if (dlFailure) state.hasFailure = true;

  const rtFormatter = new MentionHrefRewriter();
  const converter = new HierarchicalConverter(
    { tools: { richTextFormatter: rtFormatter } },
    {
      dbChildren: state.dbChildren,
      pageTitles: state.pageTitles,
      pageAssetsByPageId,
    },
  );

  const renderedMap = new Map();
  for (const node of state.visited.values()) {
    if (!node.outRelPath) continue;
    converter.currentPageId = node.id;
    const content = renderPage(node, converter, pageAssetsByPageId.get(node.id));
    renderedMap.set(node.id, { content, node });
  }

  const resolvedMap = resolveLinks(renderedMap, state, assetsByKey, outDir);
  await writeAll(resolvedMap, renderedMap, outDir);

  process.exit(state.hasFailure ? 2 : 0);
};

main();
