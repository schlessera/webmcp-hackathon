import { parseDocument } from "htmlparser2";

const DROPPED_ELEMENTS = new Set([
  "footer",
  "nav",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
]);

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/**
 * Turn one encoded ampersand layer back into an entity introducer before the
 * parser performs its single decode. This is deliberately limited to an amp
 * directly followed by another complete entity: `&amp;#039;` becomes the
 * apostrophe users intended, while decoded angle brackets remain text nodes
 * and are never fed back through the HTML parser as live markup.
 */
function unwrapDoubleEncodedEntities(value: string): string {
  return value.replace(
    /(?:&amp;|&#0*38;|&#x0*26;)(?=(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);)/g,
    "&",
  );
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[<>]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2060-\u206f]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .normalize("NFC");
}

interface HtmlNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
}

function parsed(value: string): HtmlNode {
  const source = unwrapDoubleEncodedEntities(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return parseDocument(source, {
    decodeEntities: true,
    lowerCaseTags: true,
    recognizeSelfClosing: true,
  }) as HtmlNode;
}

function renderNode(node: HtmlNode): string {
  if (node.type === "text") return node.data ?? "";
  if (node.type === "comment" || node.type === "directive") return "";
  const name = node.name?.toLocaleLowerCase();
  if (name && DROPPED_ELEMENTS.has(name)) return "";
  const children = (node.children ?? []).map(renderNode).join("");
  if (name === "br") return "\n";
  return name && BLOCK_ELEMENTS.has(name) ? `\n${children}\n` : children;
}

/**
 * Convert an HTML fragment or plain string into inert, normalized Unicode
 * text. Element recognition and subtree removal are parser-backed; regexes do
 * not decide where tags begin or end.
 */
export function cleanText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  return normalizeWhitespace(renderNode(parsed(value)));
}

/** Collapse a clean fragment to one display line. */
export function cleanInlineText(value: unknown): string {
  return cleanText(value).replace(/\s+/g, " ").trim();
}

/** Display-safe evidence also removes prompt/container delimiter residue. */
export function cleanEvidenceText(value: unknown): string {
  return cleanInlineText(value).replace(/[`{}\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** Whole-span matching over the exact same cleaned representation on both sides. */
export function hasWholeTextSpan(text: unknown, evidence: unknown): boolean {
  const haystack = cleanEvidenceText(text).toLocaleLowerCase();
  const needle = cleanEvidenceText(evidence).toLocaleLowerCase();
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = haystack.slice(0, at);
    const after = haystack.slice(at + needle.length);
    const leftIsWord = WORD_CHARACTER.test([...before].at(-1) ?? "");
    const rightIsWord = WORD_CHARACTER.test([...after][0] ?? "");
    if (!leftIsWord && !rightIsWord) return true;
    from = at + 1;
  }
}

/** Truncate without cutting a word. Every truncation is marked by an ellipsis. */
export function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength === 1) return "…";
  const head = value.slice(0, maxLength - 1);
  const boundary = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  return boundary > 0 ? `${head.slice(0, boundary).trimEnd()}…` : "…";
}

/** Clean and cap prose intended for a dossier or other compact display. */
export function cleanSummary(value: unknown, maxLength: number): string {
  return truncateText(cleanInlineText(value), maxLength);
}

function foldedTitlePart(value: string): string {
  return cleanInlineText(value).normalize("NFKC").toLocaleLowerCase();
}

/**
 * Remove publisher chrome from a page title. A declared site name is matched
 * as one complete suffix, even when it contains its own separators. Repeated
 * trailing title parts are removed as the other common brand-title shape.
 */
export function cleanTitle(value: unknown, siteName?: unknown): string {
  let title = cleanInlineText(value);
  const site = cleanInlineText(siteName);
  if (!title) return "";

  if (site) {
    const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`\\s+(?:\\||[–—])\\s+${escaped}$`, "iu"), "").trim();
  }

  for (;;) {
    const suffix = /\s+(?:\||[–—])\s+([^|–—]+)$/u.exec(title);
    if (!suffix) break;
    const tail = foldedTitlePart(suffix[1]);
    const before = title.slice(0, suffix.index);
    const repeated = before.split(/\s+(?:\||[–—])\s+/u)
      .some((part) => foldedTitlePart(part) === tail);
    if (!tail || !repeated) break;
    title = before.trim();
  }
  return title;
}

function hidden(node: HtmlNode): boolean {
  const attrs = node.attribs ?? {};
  return "hidden" in attrs || attrs["aria-hidden"]?.toLocaleLowerCase() === "true";
}

/**
 * Preserve the existing intentionally narrow evaluator corpus while using the
 * same parsed tree and rendering rules as every other extracted string.
 */
export function cleanSelectedPageText(value: string, maxLength: number): string {
  const document = parsed(value);
  const pieces: string[] = [];
  const directPieces: string[] = [];
  const seen = new Set<string>();
  let siteName = "";
  const findSiteName = (node: HtmlNode): void => {
    if (node.name?.toLocaleLowerCase() === "meta") {
      const attrs = node.attribs ?? {};
      const kind = (attrs.property ?? attrs.name ?? "").toLocaleLowerCase();
      if (kind === "og:site_name" && !siteName) siteName = cleanInlineText(attrs.content);
    }
    for (const child of node.children ?? []) findSiteName(child);
  };
  findSiteName(document);
  const add = (raw: unknown, parseMarkup = false, direct = false) => {
    const text = typeof raw === "string"
      ? parseMarkup ? cleanText(raw) : normalizeWhitespace(raw)
      : "";
    if (!text || seen.has(text)) return;
    seen.add(text);
    (direct ? directPieces : pieces).push(text);
  };

  const visit = (node: HtmlNode, dropped = false) => {
    const name = node.name?.toLocaleLowerCase();
    const isDropped = dropped || Boolean(name && DROPPED_ELEMENTS.has(name));
    if (isDropped) return;

    if (name === "meta") {
      const attrs = node.attribs ?? {};
      const kind = (attrs.name ?? attrs.property ?? "").toLocaleLowerCase();
      if (kind === "description" || kind === "og:description") add(attrs.content, true);
    } else if (name === "title") {
      add(cleanTitle(renderNode(node), siteName));
    } else if (/^h[1-6]$/.test(name ?? "") || name === "p" || name === "li") {
      if (!hidden(node)) add(renderNode(node));
    } else if (
      name && ["div", "section", "article", "td", "dd", "blockquote", "figcaption"].includes(name) &&
      !hidden(node)
    ) {
      const direct = node.children?.find((child) => child.type === "text")?.data;
      const text = cleanInlineText(direct);
      if (text.length >= 12 && /\s/.test(text)) add(text, false, true);
    }

    for (const child of node.children ?? []) visit(child, isDropped);
  };
  visit(document);
  return truncateText([...pieces, ...directPieces].join("\n"), Math.max(0, maxLength));
}
