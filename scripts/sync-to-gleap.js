#!/usr/bin/env node
/**
 * sync-to-gleap.js
 *
 * Syncs all documentation from this Mintlify repository to the Gleap Help Center.
 * Supports 6 languages (en, es, fr, de, ja, zh), collections, sub-collections,
 * articles, images, and incremental sync via content hashing.
 *
 * Usage:
 *   node scripts/sync-to-gleap.js
 *   npm run sync-gleap
 *
 * Required env vars (set in .env or environment):
 *   GLEAP_API_KEY      — Gleap API key (Project Settings → Security → API Key)
 *   GLEAP_PROJECT_ID   — Gleap Project ID
 *
 * Optional:
 *   DOCS_BASE_URL           — Base URL for resolving image paths (default: https://docs.checkoutrules.com)
 *   GLEAP_HELP_CENTER_DOMAIN — Help center domain for verification (e.g. help.checkoutrules.com).
 *                             If unset, derived from DOCS_BASE_URL only when hostname starts with "docs."
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { marked } from "marked";
import { decodeHTML } from "entities";
import { parse } from "node-html-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");
const SNIPPETS_ROOT = resolve(ROOT_DIR, "snippets");
const DOCS_FILE = resolve(ROOT_DIR, "docs.json");
const LANGUAGES = ["en", "es", "fr", "de", "ja", "zh"];
const GLEAP_API_BASE = "https://api.gleap.io/v3";
const SYNC_HASH_TAG_PREFIX = "sync-hash:";
const DEFAULT_REQUEST_TIMEOUT = 30_000;

// ─── Environment loading ───────────────────────────────────────────────────────

function loadEnv() {
  const envFile = resolve(ROOT_DIR, ".env");
  if (!existsSync(envFile)) return;
  const lines = readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

// ─── Gleap API client ──────────────────────────────────────────────────────────

class GleapClient {
  constructor(apiKey, projectId) {
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      Project: projectId,
      "Content-Type": "application/json",
    };
  }

  async request(
    method,
    path,
    body = null,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT,
  ) {
    const url = `${GLEAP_API_BASE}${path}`;
    const opts = { method, headers: this.headers };
    if (body !== null) opts.body = JSON.stringify(body);

    const controller = new AbortController();
    opts.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err.name === "AbortError";
      throw new Error(
        `Gleap API ${method} ${path} ${timedOut ? `timed out after ${timeoutMs}ms` : `failed: ${err.message}`}`,
      );
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gleap API ${res.status} for ${method} ${path}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  getCollections() {
    return this.request("GET", "/helpcenter/collections");
  }
  getAllCollections() {
    return this.request("GET", "/helpcenter/collections/all");
  }
  createCollection(data) {
    return this.request("POST", "/helpcenter/collections", data);
  }
  updateCollection(id, data) {
    return this.request("PUT", `/helpcenter/collections/${id}`, data);
  }

  getCollection(id) {
    return this.request("GET", "/helpcenter/collections/" + id);
  }
  publishCollection(id) {
    return this.request(
      "PUT",
      "/helpcenter/collections/" + id + "/toggle-publish",
      { unpublished: false },
    );
  }

  getArticles(collectionId) {
    return this.request(
      "GET",
      "/helpcenter/collections/" + collectionId + "/articles",
    );
  }
  createArticle(collectionId, data) {
    return this.request(
      "POST",
      "/helpcenter/collections/" + collectionId + "/articles",
      data,
    );
  }
  updateArticle(collectionId, articleId, data) {
    return this.request(
      "PUT",
      "/helpcenter/collections/" + collectionId + "/articles/" + articleId,
      data,
    );
  }
}

function hashContent(obj) {
  return createHash("md5")
    .update(JSON.stringify(stableSortValue(obj)))
    .digest("hex");
}

function stableSortValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableSortValue);
  }
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stableSortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Normalize parent to raw _id string. Gleap API may return parent as:
 * - null
 * - string (raw _id)
 * - object { _id: "...", ... } (populated reference)
 */
function toParentId(parent) {
  if (!parent) return null;
  if (typeof parent === "string") return parent;
  if (typeof parent === "object" && parent._id) return parent._id;
  return null;
}

function buildSyncTags(existingTags, desiredHash) {
  const preserved = (existingTags || []).filter(function (tag) {
    return typeof tag === "string" && !tag.startsWith(SYNC_HASH_TAG_PREFIX);
  });
  preserved.push(SYNC_HASH_TAG_PREFIX + desiredHash);
  return preserved;
}

// ─── MDX → HTML conversion ────────────────────────────────────────────────────

/**
 * Resolve MDX snippet imports by inlining their content.
 * Handles: import ComponentName from "/snippets/...";
 * Then replaces <ComponentName /> usages with the snippet file content.
 * Only harvests and removes imports from the preamble (top-of-file imports
 * before the first blank line or first non-import content) so code samples
 * keep their import lines.
 */
function resolveSnippets(content) {
  const importMap = {};
  const importRegex = /^import\s+(\w+)\s+from\s+["']([^"']+)["'];?\s*$/gm;
  const importLinePattern = /^import\s+\w+\s+from\s+["'][^"']+["'];?\s*$/;

  const lines = content.split("\n");
  let preambleEndIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      preambleEndIndex = i + 1;
      continue;
    }
    if (importLinePattern.test(trimmed)) {
      preambleEndIndex = i + 1;
      continue;
    }
    preambleEndIndex = i;
    break;
  }

  const preambleText = lines.slice(0, preambleEndIndex).join("\n");
  let match;
  while ((match = importRegex.exec(preambleText)) !== null) {
    importMap[match[1]] = match[2];
  }

  const preambleWithoutImports = lines
    .slice(0, preambleEndIndex)
    .filter(function (line) {
      const t = line.trim();
      if (t === "") return true;
      return !importLinePattern.test(t);
    });
  const remainder = lines.slice(preambleEndIndex);
  content =
    preambleWithoutImports.join("\n") +
    (remainder.length ? "\n" + remainder.join("\n") : "");
  content = content.trim();

  // Inline each snippet
  for (const componentName of Object.keys(importMap)) {
    const importPath = importMap[componentName];
    const normalised = importPath.startsWith("/")
      ? importPath.slice(1)
      : importPath;
    const snippetPath = resolve(ROOT_DIR, normalised);
    const rel = relative(SNIPPETS_ROOT, snippetPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `Snippet path escapes allowed root: import "${componentName}" from "${importPath}" resolves outside ${SNIPPETS_ROOT}`,
      );
    }
    if (!existsSync(snippetPath)) {
      throw new Error(
        `Snippet file not found: "${componentName}" from "${importPath}" at ${snippetPath}`,
      );
    }
    let snippetContent;
    try {
      snippetContent = readFileSync(snippetPath, "utf8");
    } catch (e) {
      throw new Error(
        `Cannot read snippet file: "${componentName}" at ${snippetPath}: ${e.message}`,
      );
    }

    // Replace self-closing <ComponentName /> and block <ComponentName>...</ComponentName>
    const selfClose = new RegExp("<" + componentName + "\\s*/>", "g");
    const blockTag = new RegExp(
      "<" + componentName + "\\s*>([\\s\\S]*?)<\\/" + componentName + ">",
      "g",
    );
    content = content.replace(selfClose, () => snippetContent);
    content = content.replace(blockTag, () => snippetContent);
  }

  return content;
}

/**
 * Convert MDX content (after frontmatter is stripped) to HTML.
 * Handles Mintlify JSX components: Note, Warning, Tip, Info, Steps, Step, Card, CardGroup, etc.
 */
function mdxToHtml(rawContent, docsBaseUrl) {
  let content = resolveSnippets(rawContent);

  // Markdown treats some 4-space indented raw HTML blocks as code.
  // Normalize the patterns used in these docs so embedded screenshots don't
  // become literal `&lt;img ...&gt;` text on Gleap.
  content = content.replace(/^ {4}(<(?:img|iframe)\b.*)$/gm, "$1");
  content = content.replace(
    /^ {4}((?:src|alt|className|title|style|allow)\s*=.*)$/gm,
    "$1",
  );
  content = content.replace(/^ {4}(allowFullScreen)$/gm, "$1");
  content = content.replace(/^ {4}(\/>|><\/iframe>)$/gm, "$1");

  // Unwrap layout-only components before Markdown -> HTML conversion.
  content = content.replace(/<Frame>([\s\S]*?)<\/Frame>/g, "$1");

  // ── Fix image src: /images/... → absolute URL ──
  content = content.replace(
    /(<img\s[^>]*?)src="\/images\//g,
    '$1src="' + docsBaseUrl + "/images/",
  );

  // ── Fix Markdown-style internal guide links before HTML conversion ──
  content = content.replace(
    /\]\((\/guides\/[^)\s]+(?:#[^)]+)?)\)/g,
    "](" + docsBaseUrl + "$1)",
  );

  // ── Fix internal doc links → absolute ──
  content = content.replace(
    /href="(\/guides\/[^"]+)"/g,
    'href="' + docsBaseUrl + '$1"',
  );

  // ── Mintlify callout components ──
  content = content.replace(
    /<Note>([\s\S]*?)<\/Note>/g,
    '<blockquote class="note">$1</blockquote>',
  );
  content = content.replace(
    /<Warning>([\s\S]*?)<\/Warning>/g,
    '<blockquote class="warning">$1</blockquote>',
  );
  content = content.replace(
    /<Tip>([\s\S]*?)<\/Tip>/g,
    '<blockquote class="tip">$1</blockquote>',
  );
  content = content.replace(
    /<Info>([\s\S]*?)<\/Info>/g,
    '<blockquote class="info">$1</blockquote>',
  );

  // ── Steps / Step ──
  content = content.replace(/<Steps>([\s\S]*?)<\/Steps>/g, "<ol>$1</ol>");
  content = content.replace(
    /<Step\s+title="([^"]*)">([\s\S]*?)<\/Step>/g,
    "<li><strong>$1</strong>$2</li>",
  );

  // ── Card / CardGroup ──
  content = content.replace(
    /<Card\s+([^>]*)>([\s\S]*?)<\/Card>/g,
    function (_, attrs, inner) {
      const titleMatch = attrs.match(/title="([^"]*)"/);
      const hrefMatch = attrs.match(/href="([^"]*)"/);
      const title = titleMatch ? titleMatch[1] : "";
      const href = hrefMatch ? hrefMatch[1] : "#";
      const resolvedHref = href.startsWith("/") ? docsBaseUrl + href : href;
      const desc = inner.trim();
      return (
        '<a href="' +
        resolvedHref +
        '"><strong>' +
        title +
        "</strong>" +
        (desc ? ": " + desc : "") +
        "</a>"
      );
    },
  );
  content = content.replace(
    /<CardGroup[^>]*>([\s\S]*?)<\/CardGroup>/g,
    '<div class="card-group">$1</div>',
  );

  // ── Accordion ──
  content = content.replace(
    /<Accordion\s+title="([^"]*)">([\s\S]*?)<\/Accordion>/g,
    "<details><summary>$1</summary>$2</details>",
  );
  content = content.replace(
    /<AccordionGroup>([\s\S]*?)<\/AccordionGroup>/g,
    "$1",
  );

  // ── Tabs ──
  content = content.replace(/<Tabs>([\s\S]*?)<\/Tabs>/g, "$1");
  content = content.replace(
    /<Tab\s+title="([^"]*)">([\s\S]*?)<\/Tab>/g,
    "<h4>$1</h4>$2",
  );

  // ── Fix JSX iframe attributes ──
  content = content.replace(/className=/g, "class=");
  // style={{ border: 0 }} → style="border: 0"
  content = content.replace(/style=\{\{([^}]*)\}\}/g, function (_, inner) {
    const css = inner
      .trim()
      .replace(/:\s*/g, ": ")
      .replace(/,\s*/g, "; ")
      .replace(/['"`]/g, "");
    return 'style="' + css + '"';
  });
  content = content.replace(/allowFullScreen/g, "allowfullscreen");

  // ── Remove any remaining self-closing unknown JSX tags (PascalCase) ──
  content = content.replace(/<[A-Z][A-Za-z]*\s[^>]*\/>/g, "");
  // ── Remove any remaining block unknown JSX tags ──
  content = content.replace(/<\/?[A-Z][A-Za-z]*[^>]*>/g, "");

  // ── Convert remaining Markdown to HTML ──
  let html = marked.parse(content);

  // Markdown image syntax (![alt](/images/...)) is converted to <img> tags by
  // marked.parse(), so the pre-parse src replacement above misses them.
  // Run the same normalisation on the rendered HTML output.
  html = html.replace(
    /(<img\s[^>]*?)src="\/images\//g,
    '$1src="' + docsBaseUrl + "/images/",
  );

  return html;
}

function htmlToPlainText(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownToPlainText(markdown) {
  const html = marked.parseInline(String(markdown || ""));
  return decodeHTML(htmlToPlainText(html));
}

function normaliseText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ");
}

function mergeMarks(base, extra) {
  const merged = base.concat(extra);
  const seen = new Set();
  return merged.filter(function (mark) {
    const key = JSON.stringify(mark);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createTextNode(text, marks) {
  const value = normaliseText(decodeHTML(String(text || "")));
  if (!value.trim()) return [];
  const node = { type: "text", text: value };
  if (marks && marks.length > 0) node.marks = marks;
  return [node];
}

function getMarksForNode(node, inheritedMarks) {
  const marks = inheritedMarks.slice();
  const tag = (node.tagName || "").toLowerCase();

  if (tag === "strong" || tag === "b") marks.push({ type: "bold" });
  if (tag === "em" || tag === "i") marks.push({ type: "italic" });
  if (tag === "code") marks.push({ type: "code" });
  if (tag === "a") {
    const href = node.getAttribute("href");
    if (href) {
      marks.push({
        type: "link",
        attrs: {
          href: href,
          target: href.startsWith("http") ? "_blank" : null,
          rel: href.startsWith("http") ? "noopener noreferrer nofollow" : null,
          class: null,
        },
      });
    }
  }

  return mergeMarks([], marks);
}

function inlineNodesFromHtmlNode(node, inheritedMarks) {
  if (node.nodeType === 3) {
    return createTextNode(node.rawText, inheritedMarks);
  }

  if (node.nodeType !== 1) return [];

  const tag = (node.tagName || "").toLowerCase();
  if (tag === "br") return [{ type: "hardBreak" }];

  const marks = getMarksForNode(node, inheritedMarks);
  let content = [];
  for (const child of node.childNodes || []) {
    content = content.concat(inlineNodesFromHtmlNode(child, marks));
  }
  return content;
}

function paragraphNodeFromElement(node) {
  const imageChildren = (node.childNodes || []).filter(function (child) {
    return (
      child.nodeType === 1 && (child.tagName || "").toLowerCase() === "img"
    );
  });

  // Markdown image paragraphs usually become <p><img ... /></p>; keep them as image blocks.
  if (imageChildren.length === 1 && (node.childNodes || []).length === 1) {
    return [imageNodeFromElement(imageChildren[0])];
  }

  const content = inlineNodesFromHtmlNode(node, []);
  if (content.length === 0) return [];
  return [
    {
      type: "paragraph",
      attrs: { id: null, textAlign: null },
      content: content,
    },
  ];
}

function imageNodeFromElement(node) {
  return {
    type: "image",
    attrs: {
      src: node.getAttribute("src") || "",
      alt: node.getAttribute("alt") || "",
      title: node.getAttribute("title") || null,
      width: null,
      height: null,
    },
  };
}

function listItemNodeFromElement(node) {
  let content = [];
  const elementChildren = (node.childNodes || []).filter(function (child) {
    return child.nodeType === 1;
  });

  if (elementChildren.length === 0) {
    const inline = inlineNodesFromHtmlNode(node, []);
    if (inline.length > 0) {
      content.push({
        type: "paragraph",
        attrs: { id: null, textAlign: null },
        content: inline,
      });
    }
  } else {
    for (const child of node.childNodes || []) {
      content = content.concat(blockNodesFromHtmlNode(child));
    }
  }

  if (content.length === 0) {
    content.push({
      type: "paragraph",
      attrs: { id: null, textAlign: null },
      content: [{ type: "text", text: "" }],
    });
  }

  return { type: "listItem", content: content };
}

function blockNodesFromHtmlNode(node) {
  if (node.nodeType === 3) {
    if (!normaliseText(node.rawText).trim()) return [];
    return [
      {
        type: "paragraph",
        attrs: { id: null, textAlign: null },
        content: createTextNode(node.rawText, []),
      },
    ];
  }

  if (node.nodeType !== 1) return [];

  const tag = (node.tagName || "").toLowerCase();

  if (
    tag === "h1" ||
    tag === "h2" ||
    tag === "h3" ||
    tag === "h4" ||
    tag === "h5" ||
    tag === "h6"
  ) {
    const level = Number(tag.slice(1));
    const content = inlineNodesFromHtmlNode(node, []);
    return content.length > 0
      ? [{ type: "heading", attrs: { level: level }, content: content }]
      : [];
  }

  if (tag === "p") return paragraphNodeFromElement(node);

  if (tag === "img") return [imageNodeFromElement(node)];

  if (tag === "ul" || tag === "ol") {
    const items = (node.childNodes || [])
      .filter(function (child) {
        return (
          child.nodeType === 1 && (child.tagName || "").toLowerCase() === "li"
        );
      })
      .map(listItemNodeFromElement);
    if (items.length === 0) return [];
    return [
      { type: tag === "ol" ? "orderedList" : "bulletList", content: items },
    ];
  }

  if (tag === "blockquote") {
    let content = [];
    for (const child of node.childNodes || []) {
      content = content.concat(blockNodesFromHtmlNode(child));
    }
    return content.length > 0 ? [{ type: "blockquote", content: content }] : [];
  }

  if (tag === "hr") return [{ type: "horizontalRule" }];

  if (tag === "pre") {
    const codeEl = (node.childNodes || []).find(function (child) {
      return (
        child.nodeType === 1 && (child.tagName || "").toLowerCase() === "code"
      );
    });
    const rawText = codeEl ? codeEl.rawText : node.rawText;
    const text = decodeHTML(rawText || "");
    const langClass = codeEl ? codeEl.getAttribute("class") || "" : "";
    const langMatch = langClass.match(/(?:^|\s)language-(\S+)/);
    const language = langMatch ? langMatch[1] : null;
    return [
      {
        type: "codeBlock",
        attrs: { language: language },
        content: [{ type: "text", text: text }],
      },
    ];
  }

  if (tag === "iframe") {
    const src = node.getAttribute("src") || "";
    if (!src) return [];
    return [
      {
        type: "iframe",
        attrs: {
          src: src,
          title: node.getAttribute("title") || null,
          width: node.getAttribute("width") || null,
          height: node.getAttribute("height") || null,
        },
      },
    ];
  }

  if (tag === "div") {
    const className = node.getAttribute && (node.getAttribute("class") || "");
    if (className && className.includes("card-group")) {
      const anchors = (node.childNodes || []).filter(function (child) {
        return (
          child.nodeType === 1 && (child.tagName || "").toLowerCase() === "a"
        );
      });
      if (anchors.length > 0) {
        return [
          {
            type: "bulletList",
            content: anchors.map(function (anchor) {
              return {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: null, textAlign: null },
                    content: inlineNodesFromHtmlNode(anchor, []),
                  },
                ],
              };
            }),
          },
        ];
      }
    }

    let content = [];
    for (const child of node.childNodes || []) {
      content = content.concat(blockNodesFromHtmlNode(child));
    }
    return content;
  }

  if (tag === "details" || tag === "summary") {
    let content = [];
    for (const child of node.childNodes || []) {
      content = content.concat(blockNodesFromHtmlNode(child));
    }
    return content;
  }

  // Fallback for unhandled tags: flatten children into supported block nodes.
  let content = [];
  for (const child of node.childNodes || []) {
    content = content.concat(blockNodesFromHtmlNode(child));
  }
  return content;
}

function htmlToGleapDoc(html) {
  const root = parse("<div>" + html + "</div>", { comment: false });
  const wrapper = root.firstChild || root;
  let content = [];

  for (const child of wrapper.childNodes || []) {
    content = content.concat(blockNodesFromHtmlNode(child));
  }

  if (content.length === 0) {
    content.push({
      type: "paragraph",
      attrs: { id: null, textAlign: null },
      content: [{ type: "text", text: htmlToPlainText(html) || "" }],
    });
  }

  return { type: "doc", content: content };
}

// ─── Navigation structure parsing ─────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function canonicalPath(pagePath) {
  // "guides/en/get-started/introduction" → "get-started/introduction"
  const match = pagePath.match(/^guides\/[a-z]{2}\/(.+)$/);
  return match ? match[1] : pagePath;
}

function buildCollectionExternalId(slugs) {
  // Parent-qualified IDs prevent collisions between top-level groups and
  // same-named sub-groups that live under different parents.
  return "group:" + slugs.join("/");
}

/**
 * Build the full sync structure from docs.json.
 *
 * Returns:
 *   collections — ordered array (top-level first, then sub-collections)
 *   articles    — array with their canonical path and target collection
 */
function buildStructure(docsJson) {
  const langNavs = {};
  for (const langEntry of docsJson.navigation.languages) {
    langNavs[langEntry.language] = langEntry.groups;
  }

  const enGroups = langNavs["en"];
  const collections = [];
  const articles = [];

  for (let gi = 0; gi < enGroups.length; gi++) {
    const enGroup = enGroups[gi];
    const groupSlug = slugify(enGroup.group);
    const groupExternalId = buildCollectionExternalId([groupSlug]);

    // Collect translated group names for each language
    const groupTitles = {};
    for (const lang of LANGUAGES) {
      if (langNavs[lang] && langNavs[lang][gi]) {
        groupTitles[lang] = langNavs[lang][gi].group;
      }
    }

    collections.push({
      externalId: groupExternalId,
      titles: groupTitles,
      parentExternalId: null,
    });

    // Enumerate the sub-groups (objects) separately to keep index alignment
    const enSubGroups = enGroup.pages.filter(function (p) {
      return typeof p === "object" && p.group;
    });

    for (const page of enGroup.pages) {
      if (typeof page === "string") {
        // Direct article under this top-level group
        articles.push({
          externalId: "article:" + canonicalPath(page),
          canonicalPath: canonicalPath(page),
          collectionExternalId: groupExternalId,
        });
      } else if (typeof page === "object" && page.group) {
        // Sub-group
        const subGroupSlug = slugify(page.group);
        const subGroupExternalId = buildCollectionExternalId([
          groupSlug,
          subGroupSlug,
        ]);
        const subGroupIndex = enSubGroups.indexOf(page);

        const subGroupTitles = {};
        for (const lang of LANGUAGES) {
          if (langNavs[lang] && langNavs[lang][gi]) {
            const langSubGroups = langNavs[lang][gi].pages.filter(function (p) {
              return typeof p === "object" && p.group;
            });
            if (langSubGroups[subGroupIndex]) {
              subGroupTitles[lang] = langSubGroups[subGroupIndex].group;
            }
          }
        }

        collections.push({
          externalId: subGroupExternalId,
          titles: subGroupTitles,
          parentExternalId: groupExternalId,
        });

        for (const subPage of page.pages) {
          if (typeof subPage === "string") {
            articles.push({
              externalId: "article:" + canonicalPath(subPage),
              canonicalPath: canonicalPath(subPage),
              collectionExternalId: subGroupExternalId,
            });
          }
        }
      }
    }
  }

  return { collections: collections, articles: articles };
}

function flattenCollections(collections) {
  const flat = [];

  function visit(collection) {
    flat.push(collection);
    if (Array.isArray(collection.subCollections)) {
      for (const child of collection.subCollections) visit(child);
    }
  }

  for (const collection of collections || []) visit(collection);
  return flat;
}

// ─── Article content loading ───────────────────────────────────────────────────

function loadArticleContent(articlePath, docsBaseUrl) {
  const titles = {};
  const descriptions = {};
  const htmlByLang = {};
  const contentByLang = {};
  const plainContentByLang = {};

  for (const lang of LANGUAGES) {
    const filePath = resolve(
      ROOT_DIR,
      "guides/" + lang + "/" + articlePath + ".mdx",
    );
    if (!existsSync(filePath)) continue;

    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = matter(raw);
      const fm = parsed.data;
      const content = parsed.content;

      titles[lang] = fm.title || "";
      descriptions[lang] = markdownToPlainText(fm.description || "");
      htmlByLang[lang] = mdxToHtml(content, docsBaseUrl);
      contentByLang[lang] = htmlToGleapDoc(htmlByLang[lang]);
      plainContentByLang[lang] = htmlToPlainText(htmlByLang[lang]);
    } catch (err) {
      console.warn(
        "  ⚠ Could not load guides/" +
          lang +
          "/" +
          articlePath +
          ".mdx: " +
          err.message,
      );
    }
  }

  return {
    titles: titles,
    descriptions: descriptions,
    content: contentByLang,
    plainContent: plainContentByLang,
  };
}

// ─── Main sync ─────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();

  const apiKey = process.env.GLEAP_API_KEY;
  const projectId = process.env.GLEAP_PROJECT_ID;
  const docsBaseUrl = (
    process.env.DOCS_BASE_URL || "https://docs.checkoutrules.com"
  ).replace(/\/$/, "");

  if (!apiKey || !projectId) {
    console.error("\nError: GLEAP_API_KEY and GLEAP_PROJECT_ID are required.");
    console.error("Copy .env.example to .env and add your credentials.\n");
    process.exit(1);
  }

  const client = new GleapClient(apiKey, projectId);
  const docsJson = JSON.parse(readFileSync(DOCS_FILE, "utf8"));
  const { collections, articles } = buildStructure(docsJson);

  console.log("\n🔄 Gleap Help Center Sync");
  console.log("   Collections: " + collections.length);
  console.log("   Articles:    " + articles.length);
  console.log("   Languages:   " + LANGUAGES.join(", "));
  console.log("   Docs URL:    " + docsBaseUrl);
  console.log("");

  // ── Build collection ID map directly from Gleap ───────────────────────────
  process.stdout.write("Fetching existing Gleap collections... ");
  const existingCollections = flattenCollections(
    await client.getAllCollections(),
  );
  console.log("found " + existingCollections.length);

  const extIdToGleapId = {};
  const existingCollectionsByExternalId = {};
  for (const collection of existingCollections) {
    if (collection.externalId) {
      extIdToGleapId[collection.externalId] = collection._id;
      existingCollectionsByExternalId[collection.externalId] = collection;
    }
  }

  // ── Sync collections (top-level first, then sub-collections) ──────────────
  const topLevel = collections.filter(function (c) {
    return !c.parentExternalId;
  });
  const subLevel = collections.filter(function (c) {
    return c.parentExternalId;
  });

  console.log("Syncing collections...");
  let colCreated = 0,
    colUpdated = 0,
    colSkipped = 0;

  for (const col of [...topLevel, ...subLevel]) {
    const desiredParentId = col.parentExternalId
      ? extIdToGleapId[col.parentExternalId] || null
      : null;
    const desiredHash = hashContent({
      title: col.titles,
      parent: desiredParentId,
      externalId: col.externalId,
    });
    const existingCollection =
      existingCollectionsByExternalId[col.externalId] || null;
    let gleapId = extIdToGleapId[col.externalId];

    if (existingCollection) {
      const currentHash = hashContent({
        title: existingCollection.title || {},
        parent: toParentId(existingCollection.parent),
        externalId: existingCollection.externalId || null,
      });
      if (currentHash === desiredHash) {
        console.log('  ✓ "' + col.titles.en + '" (unchanged)');
        colSkipped++;
        continue;
      }
    }

    const payload = {
      title: col.titles,
      externalId: col.externalId,
    };
    if (desiredParentId) payload.parent = desiredParentId;

    if (gleapId) {
      console.log('  ↻ Updating "' + col.titles.en + '"...');
      await client.updateCollection(gleapId, payload);
      colUpdated++;
    } else {
      console.log('  + Creating "' + col.titles.en + '"...');
      const created = await client.createCollection(payload);
      gleapId = created._id;
      extIdToGleapId[col.externalId] = gleapId;
      existingCollectionsByExternalId[col.externalId] = created;
      colCreated++;
    }
  }

  // ── Ensure all collections are published (publicly visible) ───────────────
  for (const col of [...topLevel, ...subLevel]) {
    const gleapId = extIdToGleapId[col.externalId];
    if (gleapId) {
      try {
        await client.publishCollection(gleapId);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ── Fetch existing articles from all current collections ──────────────────
  console.log("\nFetching existing Gleap articles...");
  const allCollectionsAfterSync = flattenCollections(
    await client.getAllCollections(),
  );
  const gleapArticleByExternalId = {}; // externalId → { article, collectionId }

  for (const collection of allCollectionsAfterSync) {
    try {
      const existing = await client.getArticles(collection._id);
      for (const article of existing) {
        if (article.externalId) {
          gleapArticleByExternalId[article.externalId] = {
            article: article,
            collectionId: collection._id,
          };
        }
      }
    } catch (err) {
      console.warn(
        '  ⚠ Could not fetch articles for "' +
          ((collection.title && collection.title.en) || collection._id) +
          '": ' +
          err.message,
      );
    }
  }

  // ── Sync articles ──────────────────────────────────────────────────────────
  console.log("\nSyncing articles...");
  let artCreated = 0,
    artUpdated = 0,
    artSkipped = 0,
    artErrors = 0;
  const syncedArticles = {};

  for (const article of articles) {
    const { titles, descriptions, content, plainContent } = loadArticleContent(
      article.canonicalPath,
      docsBaseUrl,
    );

    if (!titles.en) {
      console.warn(
        '  ⚠ No content for "' + article.canonicalPath + '", skipping',
      );
      artErrors++;
      continue;
    }

    const gleapColId = extIdToGleapId[article.collectionExternalId];

    if (!gleapColId) {
      console.warn(
        '  ⚠ Collection "' +
          article.collectionExternalId +
          '" not found in Gleap, skipping "' +
          titles.en +
          '"',
      );
      artErrors++;
      continue;
    }

    const existingEntry = gleapArticleByExternalId[article.externalId];
    const existingArticle = existingEntry ? existingEntry.article : null;
    const existingColId = existingEntry ? existingEntry.collectionId : null;
    const desiredHash = hashContent({
      title: titles,
      description: descriptions,
      content: content,
      plainContent: plainContent,
      collectionId: gleapColId,
      externalId: article.externalId,
    });
    const desiredSyncTag = SYNC_HASH_TAG_PREFIX + desiredHash;

    if (
      existingArticle &&
      existingColId === gleapColId &&
      Array.isArray(existingArticle.tags) &&
      existingArticle.tags.includes(desiredSyncTag)
    ) {
      console.log(
        '  ✓ "' + titles.en + '" (' + article.canonicalPath + ") (unchanged)",
      );
      artSkipped++;
      syncedArticles[article.externalId] = {
        gleapId: existingArticle._id,
        collectionGleapId: existingColId,
      };
      continue;
    }

    const payload = {
      title: titles,
      description: descriptions,
      content: content, // localized Gleap/Tiptap doc objects
      plainContent: plainContent, // localized plain-text strings
      tags: buildSyncTags(existingArticle && existingArticle.tags, desiredHash),
      isDraft: false,
      externalId: article.externalId,
      helpcenterCollection: gleapColId, // required by Gleap even with URL param
    };

    // If the article exists in a different collection, move it during the update
    if (existingArticle && existingColId !== gleapColId) {
      payload.newCollectionId = gleapColId;
    }

    try {
      if (existingArticle) {
        console.log(
          '  ↻ Updating "' + titles.en + '" (' + article.canonicalPath + ")...",
        );
        await client.updateArticle(existingColId, existingArticle._id, payload);
        artUpdated++;
        syncedArticles[article.externalId] = {
          gleapId: existingArticle._id,
          collectionGleapId: gleapColId,
        };
      } else {
        console.log(
          '  + Creating "' + titles.en + '" (' + article.canonicalPath + ")...",
        );
        const created = await client.createArticle(gleapColId, payload);
        artCreated++;
        syncedArticles[article.externalId] = {
          gleapId: created._id,
          collectionGleapId: gleapColId,
        };
      }
    } catch (err) {
      console.error('  ✗ Error syncing "' + titles.en + '": ' + err.message);
      artErrors++;
    }
  }

  const colChanged = colCreated + colUpdated;
  const artChanged = artCreated + artUpdated;
  const failureMessages = [];

  let verificationError = null;
  try {
    await verifyHelpCenter(
      client,
      collections,
      articles,
      extIdToGleapId,
      syncedArticles,
      docsBaseUrl,
    );
  } catch (err) {
    verificationError = err;
  }

  console.log("─────────────────────────────────────");
  console.log("Sync complete!");
  console.log(
    "  Collections — changed: " +
      colChanged +
      " (created: " +
      colCreated +
      ", updated: " +
      colUpdated +
      ", skipped: " +
      colSkipped +
      ")",
  );
  console.log(
    "  Articles    — changed: " +
      artChanged +
      " (created: " +
      artCreated +
      ", updated: " +
      artUpdated +
      ", skipped: " +
      artSkipped +
      (artErrors ? ", errors: " + artErrors : "") +
      ")",
  );
  console.log("─────────────────────────────────────\n");

  if (artErrors > 0) {
    failureMessages.push(
      artErrors +
        " article sync error" +
        (artErrors === 1 ? "" : "s") +
        " occurred.",
    );
  }
  if (verificationError) {
    failureMessages.push(verificationError.message);
  }

  if (failureMessages.length > 0) {
    throw new Error(
      "Sync completed with failures: " + failureMessages.join(" "),
    );
  }
}

// ─── Help center verification ──────────────────────────────────────────────

/**
 * Derive help center domain from docs base URL.
 * Only derives when hostname starts with "docs." (e.g. docs.checkoutrules.com → help.checkoutrules.com).
 * Returns null if DOCS_BASE_URL doesn't follow that pattern.
 */
function deriveHelpCenterDomain(docsBaseUrl) {
  try {
    const u = new URL(docsBaseUrl);
    const host = u.hostname || u.host || "";
    if (host.startsWith("docs.")) return "help." + host.slice(5);
    return null;
  } catch {
    return null;
  }
}

async function verifyHelpCenter(
  client,
  collections,
  articles,
  extIdToGleapId,
  syncedArticles,
  docsBaseUrl,
) {
  console.log("\nVerifying help center...\n");

  var passed = 0;
  var failed = 0;

  function ok(msg) {
    console.log("  ✓ " + msg);
    passed++;
  }
  function fail(msg) {
    console.log("  ✗ " + msg);
    failed++;
  }

  // 1. Verify all collections exist and are accessible
  for (var desiredCollection of collections) {
    var collectionId = extIdToGleapId[desiredCollection.externalId];
    if (!collectionId) {
      fail(
        "Collection " +
          desiredCollection.externalId +
          " has no Gleap ID after sync",
      );
      continue;
    }
    try {
      var col = await client.getCollection(collectionId);
      ok(
        'Collection "' +
          ((col.title && col.title.en) || desiredCollection.externalId) +
          '" exists (docId=' +
          col.docId +
          ")",
      );
    } catch (err) {
      fail(
        "Collection " +
          desiredCollection.externalId +
          " (" +
          collectionId +
          ") not found: " +
          err.message,
      );
    }
  }

  // 2. Verify all articles exist with correct content
  // Check a sample of articles (first 5) to keep verification fast
  var sample = articles
    .slice(0, 5)
    .map(function (article) {
      return {
        externalId: article.externalId,
        gleapId:
          syncedArticles[article.externalId] &&
          syncedArticles[article.externalId].gleapId,
        collectionId:
          syncedArticles[article.externalId] &&
          syncedArticles[article.externalId].collectionGleapId,
      };
    })
    .filter(function (item) {
      return item.gleapId && item.collectionId;
    });
  for (var check of sample) {
    try {
      var arts = await client.getArticles(check.collectionId);
      var art = arts.find(function (a) {
        return a._id === check.gleapId || a.externalId === check.externalId;
      });
      if (!art) {
        fail("Article " + check.externalId + " not found in Gleap collection");
      } else if (!art.content || JSON.stringify(art.content).length < 10) {
        fail(
          'Article "' +
            ((art.title && art.title.en) || check.externalId) +
            '" has empty content',
        );
      } else {
        ok(
          'Article "' +
            ((art.title && art.title.en) || check.externalId) +
            '" has content (' +
            JSON.stringify(art.content).length +
            " chars)",
        );
      }
    } catch (err) {
      fail("Could not verify article " + check.externalId + ": " + err.message);
    }
  }

  // 3. Check help center public URL accessibility (only when domain derivable or set)
  var helpCenterDomain =
    process.env.GLEAP_HELP_CENTER_DOMAIN ||
    deriveHelpCenterDomain(docsBaseUrl);
  if (helpCenterDomain) {
    var helpUrl = "https://" + helpCenterDomain + "/en";
    try {
      var r = await fetch(helpUrl);
      if (r.ok) {
        ok(
          "Help center home page accessible: " +
            helpUrl +
            " (HTTP " +
            r.status +
            ")",
        );
      } else {
        fail("Help center home page returned HTTP " + r.status + ": " + helpUrl);
      }
    } catch (err) {
      fail("Could not reach help center at " + helpUrl + ": " + err.message);
    }

    // 4. Verify collections/tree endpoint returns our collections
    try {
      var treeUrl =
        "https://" +
        helpCenterDomain +
        "/api/shared/helpcenter/collections/tree?lang=en";
      var treeResp = await fetch(treeUrl, {
        headers: { "x-api-key": helpCenterDomain },
      });
      if (treeResp.ok) {
        var tree = await treeResp.json();
        var topLevelCollectionCount = Array.isArray(tree) ? tree.length : 0;
        var visibleCollectionCount = 0;
        var visibleArticleCount = 0;
        var treeCollectionIds = new Set();
        var treeArticleIds = new Set();

        function countVisibleTree(nodes) {
          for (var node of nodes || []) {
            visibleCollectionCount += 1;
            if (node._id) treeCollectionIds.add(node._id);
            var nodeArticles = Array.isArray(node.articles) ? node.articles : [];
            visibleArticleCount += nodeArticles.length;
            for (var a of nodeArticles) {
              if (a._id) treeArticleIds.add(a._id);
            }
            if (Array.isArray(node.subCollections)) {
              countVisibleTree(node.subCollections);
            }
          }
        }

        if (Array.isArray(tree)) {
          countVisibleTree(tree);
        }

        ok(
          "Help center public API: " +
            topLevelCollectionCount +
            " top-level collections, " +
            visibleCollectionCount +
            " total collections, " +
            visibleArticleCount +
            " total articles visible",
        );

        // Validate every synced collection appears in the public tree
        for (var expectedCol of collections) {
          var gleapColId = extIdToGleapId[expectedCol.externalId];
          if (!gleapColId) continue; // not synced (e.g. no matching files), skip
          if (!treeCollectionIds.has(gleapColId)) {
            fail(
              "Collection " +
                expectedCol.externalId +
                " (Gleap ID " +
                gleapColId +
                ") is missing from the help center public tree",
            );
          }
        }

        // Validate every synced article appears in the public tree
        for (var expectedArt of articles) {
          var syncedArt = syncedArticles[expectedArt.externalId];
          if (!syncedArt || !syncedArt.gleapId) continue; // not synced, skip
          if (!treeArticleIds.has(syncedArt.gleapId)) {
            fail(
              "Article " +
                expectedArt.externalId +
                " (Gleap ID " +
                syncedArt.gleapId +
                ") is missing from the help center public tree",
            );
          }
        }
      } else {
        fail("Help center collections/tree API returned HTTP " + treeResp.status);
      }
    } catch (err) {
      fail("Could not check help center public API: " + err.message);
    }
  } else {
    console.log(
      "  ⓘ Skipping help center URL verification (domain not derivable from DOCS_BASE_URL; set GLEAP_HELP_CENTER_DOMAIN to verify)",
    );
  }

  console.log("\n─────────────────────────────────────");
  if (failed === 0) {
    console.log(
      "Verification passed! (" + passed + "/" + (passed + failed) + " checks)",
    );
  } else {
    console.log("Verification: " + passed + " passed, " + failed + " failed");
  }
  console.log("─────────────────────────────────────\n");

  if (failed > 0) {
    throw new Error(
      "Help center verification failed with " +
        failed +
        " failed check" +
        (failed === 1 ? "" : "s") +
        ".",
    );
  }
}

main().catch(function (err) {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
