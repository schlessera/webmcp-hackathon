import { config } from "../config.ts";
import { assertPublicTarget as assertOutboundPublicTarget, outboundFetchFor } from "../net/outbound.ts";
import {
  PAGE_CACHE_TTL_MS,
  ROBOTS_CACHE_TTL_MS,
  type PageCacheEntry,
  type StorePageInput,
} from "./cache.ts";

/**
 * A place's own website as a source (docs/ENRICHMENT-SOURCES.md, S2).
 *
 * The one intermediary-free source there is: what the venue publishes about
 * itself, explicitly for machines, as schema.org JSON-LD — cuisine, price
 * range, hours, a menu, a rating it chose to show, accessibility features —
 * and, for machines only by accident, the links in its navigation. Selected
 * visible page text is returned separately from WebFacts and kept in the
 * server-private page cache for evaluator reuse. It is never shown to a user.
 * Dossier data remains parsed facts, a few URLs and a one-line description; robots.txt is
 * honoured; a normal facts read makes at most two content requests (homepage,
 * then the menu page); the User-Agent names the project.
 *
 * Shaped by two surveys of the pool venues' sites (2026-09-02, 160 sites by
 * hand, then 1,400 across four slices — docs/research/enrichment-crawl-…):
 * ~80 % reachable, half carry JSON-LD, 4–18 % carry structured facts, but a
 * menu is linked from most navigations, `openingHoursSpecification` is far
 * more common than `openingHours`, facts are spread across several JSON-LD
 * nodes, and booking / delivery platforms are linked from the homepage far
 * more often than declared in markup.
 */

export interface WebFacts {
  url: string;
  host: string;
  fetchedAt: string;
  /** Bounded publisher identity hints retained for focused evidence adjudication. */
  pageTitle?: string;
  publisherNames?: string[];
  /** schema.org types seen, for the drawer. */
  types: string[];
  cuisine?: string[];
  /** 1–4 from "$"…"$$$$" / "€"…"€€€€"; absent when not that shape. */
  priceLevel?: number;
  /** Hours as published: `openingHours` strings, or specifications folded
   * into the same shape ("Mo,Tu 11:00-23:00"). */
  hours?: string[];
  rating?: { value: number; best: number; count?: number };
  wheelchair?: boolean;
  menuUrl?: string;
  /** What the menu link led to, when it was followed. "image" is a menu
   * that is a picture — on its own, or the only thing on an otherwise empty
   * page. */
  menuKind?: "html" | "pdf" | "image" | "other";
  /** For pdf / image: where the picture is, for the reader (index.ts). */
  menuFileUrl?: string;
  /** What a vision model read off that picture (menu-reader.ts). */
  menuReading?: import("./menu-reader.ts").MenuReading;
  /** Dossier attribute keys the menu page mentions by word ("vegan",
   * "glutenfrei" …). Evidence for an unverified claim, never a verified one. */
  menuMentions?: string[];
  reservationsUrl?: string;
  deliveryUrl?: string;
  description?: string;
  /** Candidate URLs found in this same homepage fetch. They are inputs to the
   * server-side image cache only and are never sent to a participant. */
  imageCandidates?: WebsiteImageCandidate[];
}

export interface WebsiteImageCandidate {
  url: string;
  source: `web:${string}`;
  pageUrl: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const ENRICH_USER_AGENT =
  config.identifyingUserAgent;
const TIMEOUT_MS = 8000;
const MAX_HTML = 1_500_000;
const MAX_REDIRECTS = 5;
export const MAX_PAGE_TEXT = 6_000;
export const MAX_PAGE_TITLE = 160;
export const MAX_PUBLISHER_NAMES = 6;
export const MAX_PUBLISHER_NAME = 120;
export const MAX_IMAGE_CANDIDATE_HTML_BYTES = 512 * 1024;

const FOOD_TYPES = /Restaurant|Cafe|CoffeeShop|Bar|Pub|Bakery|Brewery|Winery|FoodEstablishment|IceCreamShop|FastFood|Distillery/;
const BUSINESS_TYPES = /LocalBusiness|Organization|Store|EntertainmentBusiness|LodgingBusiness|Hotel/;
const PAGE_TYPES = /^(WebPage|WebSite)$/;

function publicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  if (address.includes(".")) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return publicIpv4(mapped ?? address);
  }
  const value = address.toLowerCase();
  if (!value.includes(":")) return false;
  if (value === "::" || value === "::1") return false;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return publicIpv4(
      `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
    );
  }
  if (value.startsWith("::")) return false;
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (/^2001:db8(?::|$)/.test(value)) return false; // documentation
  return true;
}

export async function fetchPublic(
  target: URL,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> {
  let current = target;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    // The shared outbound resolver supplies the ten-minute DNS cache. Public
    // numeric targets remain accepted here for deterministic injected tests;
    // production outbound transport separately rejects literal IP targets.
    await assertOutboundPublicTarget(current, true);
    const response = await fetchImpl(current.toString(), { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_REDIRECTS) throw new Error("too many redirects");
    current = new URL(location, current);
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("redirected to a non-fetchable URL");
    }
  }
  throw new Error("too many redirects");
}

/** Minimal robots.txt: the `*` group's Disallow lines against the path. */
export function robotsAllows(robots: string, path: string): boolean {
  let inStar = false;
  let sawStar = false;
  const disallowed: string[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key.toLowerCase() === "user-agent") {
      inStar = value.trim() === "*";
      if (inStar) sawStar = true;
    } else if (inStar && key.toLowerCase() === "disallow") {
      if (value.trim()) disallowed.push(value.trim());
    }
  }
  if (!sawStar) return true;
  return !disallowed.some((d) => path.startsWith(d.replace(/\*$/, "")));
}

export function priceRangeToLevel(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^([$€£]{1,4})$/.exec(raw.trim());
  return m ? m[1].length : undefined;
}

/** At most `max` characters, cut at a sentence or word boundary, never mid-word. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = head.lastIndexOf(". ");
  if (sentence > max * 0.5) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(" ");
  return `${head.slice(0, word > 0 ? word : max)}…`;
}

// --- JSON-LD -----------------------------------------------------------------

interface Node {
  [k: string]: unknown;
}

/** Every object reachable from the document, depth-bounded: @graph members,
 * nested values, arrays — a venue's facts are often spread over several. */
function collectNodes(json: unknown, out: Node[] = [], depth = 0): Node[] {
  if (depth > 6 || out.length > 400) return out;
  if (Array.isArray(json)) {
    for (const item of json) collectNodes(item, out, depth + 1);
  } else if (json && typeof json === "object") {
    const n = json as Node;
    if (n["@type"] !== undefined || n["@graph"] !== undefined) out.push(n);
    for (const [k, v] of Object.entries(n)) {
      if (k === "@context") continue;
      if (v && typeof v === "object") collectNodes(v, out, depth + 1);
    }
  }
  return out;
}

const typesOf = (n: Node): string[] =>
  ([] as unknown[]).concat(n["@type"] ?? []).map((t) => String(t).replace(/^.*[/#]/, ""));
const asList = (v: unknown): unknown[] => ([] as unknown[]).concat(v ?? []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A URL out of a string, an object with url/@id (dereferenced through the
 * document's @id index), or a list of those. */
function urlOf(v: unknown, byId: Map<string, Node>, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof v === "string") {
    const ref = byId.get(v);
    return ref ? (urlOf(ref, byId, depth + 1) ?? v) : v;
  }
  if (Array.isArray(v)) return v.map((x) => urlOf(x, byId, depth)).find(Boolean);
  if (v && typeof v === "object") {
    const o = v as Node;
    const direct = str(o.url);
    if (direct) return direct;
    const id = str(o["@id"]);
    if (!id) return undefined;
    const ref = byId.get(id);
    return ref && ref !== o ? (urlOf(ref, byId, depth + 1) ?? id) : id;
  }
  return undefined;
}

const DAY: Record<string, string> = {
  monday: "Mo", tuesday: "Tu", wednesday: "We", thursday: "Th", friday: "Fr", saturday: "Sa", sunday: "Su",
  mo: "Mo", tu: "Tu", we: "We", th: "Th", fr: "Fr", sa: "Sa", su: "Su",
};

/** `openingHoursSpecification` folded into the `openingHours` string shape. */
export function hoursFromSpecification(spec: unknown): string[] {
  const out: string[] = [];
  for (const item of asList(spec)) {
    if (!item || typeof item !== "object") continue;
    const s = item as Node;
    const days = asList(s.dayOfWeek)
      .map((d) => DAY[String(d).replace(/^.*[/#]/, "").toLowerCase()])
      .filter((d): d is string => Boolean(d));
    const opens = str(s.opens)?.slice(0, 5);
    const closes = str(s.closes)?.slice(0, 5);
    if (!opens || !closes) continue;
    out.push(`${days.length ? days.join(",") : "Mo-Su"} ${opens}-${closes}`);
  }
  return out;
}

// --- anchors -----------------------------------------------------------------

export interface Anchor {
  href: string;
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&#0?38;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&uuml;/g, "ü").replace(/&Uuml;/g, "Ü").replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function attributeOf(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function visibleFragment(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Metadata that can establish whether a page speaks for a place or chain. */
export function extractPageIdentity(html: string): {
  title?: string;
  publisherNames: string[];
} {
  const title = visibleFragment(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "",
  ).slice(0, MAX_PAGE_TITLE);
  const names: string[] = [];
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const value = visibleFragment(raw).slice(0, MAX_PUBLISHER_NAME);
    if (value && !names.some((name) => name.toLocaleLowerCase() === value.toLocaleLowerCase())) {
      names.push(value);
    }
  };
  for (const meta of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = meta[1];
    const key = (attributeOf(attrs, "property") ?? attributeOf(attrs, "name") ?? "")
      .toLocaleLowerCase();
    if (key === "og:site_name") add(attributeOf(attrs, "content"));
  }
  for (const script of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      for (const node of collectNodes(JSON.parse(script[1].trim()))) {
        if (typesOf(node).some((type) =>
          FOOD_TYPES.test(type) || BUSINESS_TYPES.test(type) || PAGE_TYPES.test(type)
        )) add(node.name);
      }
    } catch {
      /* broken JSON-LD contributes no publisher identity */
    }
  }
  return {
    ...(title ? { title } : {}),
    publisherNames: names.slice(0, MAX_PUBLISHER_NAMES),
  };
}

/**
 * The bounded prose made available only to the server-side evaluator. This is
 * deliberately narrower than a generic HTML-to-text conversion: title, meta
 * description, headings, paragraphs, list items, and the direct text of layout
 * containers that hold a whole clause, with page chrome and executable/style
 * content removed first.
 */
export function extractVisibleText(html: string, max = MAX_PAGE_TEXT): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const pieces: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const text = visibleFragment(raw);
    if (!text || seen.has(text)) return;
    seen.add(text);
    pieces.push(text);
  };

  add(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(stripped)?.[1]);
  for (const meta of stripped.matchAll(/<meta\b([^>]*)>/gi)) {
    const kind = (attributeOf(meta[1], "name") ?? attributeOf(meta[1], "property") ?? "")
      .toLocaleLowerCase();
    if (kind === "description" || kind === "og:description") {
      add(attributeOf(meta[1], "content"));
    }
  }
  for (const element of stripped.matchAll(/<(h[1-6]|p|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    if (hiddenAttributes(element[2])) continue;
    add(element[3]);
  }
  // Plenty of venue sites write their one descriptive sentence straight into a
  // layout container rather than a paragraph, and the pass above cannot see it.
  // Take only a container's DIRECT text — the run before its first child tag —
  // so a wrapper around real paragraphs contributes nothing and cannot
  // duplicate them. Require a whole clause, which also keeps timestamps,
  // opening times and one-word chrome out.
  for (const element of stripped.matchAll(
    /<(div|section|article|td|dd|blockquote|figcaption)\b([^>]*)>([^<]+)/gi,
  )) {
    if (hiddenAttributes(element[2])) continue;
    const direct = visibleFragment(element[3]);
    if (direct.length < 12 || !/\s/.test(direct)) continue;
    add(element[3]);
  }
  return clip(pieces.join("\n"), Math.max(0, max));
}

function hiddenAttributes(attributes: string): boolean {
  return (
    /\bhidden(?:\s|=|$)/i.test(attributes) || /aria-hidden\s*=\s*["']?true/i.test(attributes)
  );
}

/** Every `<a href>` with its visible text, entities decoded, tags stripped. */
export function extractAnchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!raw) continue;
    const href_ = decodeEntities(raw.trim());
    // Template residue and escaped JSON never resolve to a page.
    if (/["'\\{}]|%22|\/\/\//.test(href_)) continue;
    let text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!text) {
      // An image or icon link: its label lives in aria-label, title or alt.
      const label = /(?:aria-label|title)\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? /alt\s*=\s*"([^"]*)"/i.exec(m[2])?.[1];
      if (label) text = decodeEntities(label).trim();
    }
    out.push({ href: href_, text });
    if (out.length >= 600) break;
  }
  return out;
}

function resolve(base: string, href: string): string | undefined {
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function imageUrl(base: string, raw: unknown): string | undefined {
  if (typeof raw === "string") return resolve(base, decodeEntities(raw.trim()));
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const found = imageUrl(base, value);
      if (found) return found;
    }
    return undefined;
  }
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    return imageUrl(base, value.url ?? value.contentUrl ?? value["@id"]);
  }
  return undefined;
}

const NON_PHOTO_IMAGE_WORD =
  /(?<![\p{L}\p{N}])(?:flag|icon|logo|sprite|lang(?:uage)?|avatar|badge|banner|placeholder|pixel|tracking)(?![\p{L}\p{N}])/iu;
const NON_PHOTO_IMAGE_TYPE = /^(?:image\/)?(?:svg\+xml|svg|x-icon|vnd\.microsoft\.icon|ico|gif)(?:\s*;|$)/i;
const NON_PHOTO_IMAGE_EXTENSION = /\.(?:svg|ico|gif)$/i;

/** A structured site declaration can still point at chrome. Match only the
 * URL path (never its host) and use Unicode letter/number boundaries so a
 * real `flagship-hotel.jpg` or a host such as bannerman.de survives. */
export function websiteImageCandidateAllowed(input: {
  url: string;
  alt?: string;
  className?: string;
  declaredType?: string;
}): boolean {
  let path: string;
  try {
    const url = new URL(input.url);
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
  } catch {
    return false;
  }
  if (NON_PHOTO_IMAGE_EXTENSION.test(path)) return false;
  if (input.declaredType && NON_PHOTO_IMAGE_TYPE.test(input.declaredType.trim())) return false;
  return ![path, input.alt ?? "", input.className ?? ""].some((value) =>
    NON_PHOTO_IMAGE_WORD.test(value)
  );
}

/**
 * Candidate images from one already-fetched homepage, in product precedence:
 * Open Graph, Twitter, schema.org (JSON-LD then microdata), and image_src.
 * These are the site's explicit representative-image declarations; arbitrary
 * `<img>` elements are deliberately not candidates.
 */
export function extractImageCandidates(html: string, pageUrl: string): WebsiteImageCandidate[] {
  const candidates: string[] = [];
  const add = (
    raw: unknown,
    metadata: { alt?: string; className?: string; declaredType?: string } = {},
  ) => {
    const url = imageUrl(pageUrl, raw);
    if (
      url &&
      websiteImageCandidateAllowed({ url, ...metadata }) &&
      !candidates.includes(url)
    ) candidates.push(url);
  };

  const ogType = [...html.matchAll(/<meta\b([^>]*)>/gi)]
    .find((meta) =>
      (attributeOf(meta[1], "property") ?? attributeOf(meta[1], "name") ?? "").toLowerCase() ===
        "og:image:type"
    );
  const ogDeclaredType = ogType ? attributeOf(ogType[1], "content") : undefined;
  const companionMeta = (wanted: string): string | undefined => {
    for (const meta of html.matchAll(/<meta\b([^>]*)>/gi)) {
      const key = (attributeOf(meta[1], "property") ?? attributeOf(meta[1], "name") ?? "")
        .toLowerCase();
      if (key === wanted) return attributeOf(meta[1], "content");
    }
    return undefined;
  };
  const ogAlt = companionMeta("og:image:alt");
  const twitterAlt = companionMeta("twitter:image:alt");

  for (const meta of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = meta[1];
    const key = (attributeOf(attrs, "property") ?? attributeOf(attrs, "name") ?? "").toLowerCase();
    if (key === "og:image" || key === "og:image:url") {
      add(attributeOf(attrs, "content"), {
        alt: attributeOf(attrs, "alt") ?? ogAlt,
        className: attributeOf(attrs, "class"),
        declaredType: ogDeclaredType,
      });
    }
  }
  for (const meta of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = meta[1];
    const key = (attributeOf(attrs, "name") ?? attributeOf(attrs, "property") ?? "").toLowerCase();
    if (key === "twitter:image" || key === "twitter:image:src") {
      add(attributeOf(attrs, "content"), {
        alt: attributeOf(attrs, "alt") ?? twitterAlt,
        className: attributeOf(attrs, "class"),
      });
    }
  }

  for (const script of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      for (const node of collectNodes(JSON.parse(script[1].trim()))) {
        const image = node.image;
        const typed = image && typeof image === "object" && !Array.isArray(image)
          ? image as Record<string, unknown>
          : undefined;
        add(image, {
          alt: typeof typed?.caption === "string" ? typed.caption : undefined,
          declaredType: typeof typed?.encodingFormat === "string"
            ? typed.encodingFormat
            : undefined,
        });
      }
    } catch {
      /* broken JSON-LD contributes no candidate */
    }
  }
  for (const element of html.matchAll(/<(?:meta|link|img)\b([^>]*\bitemprop\s*=\s*(?:["'][^"']*\bimage\b[^"']*["']|image\b)[^>]*)>/gi)) {
    add(
      attributeOf(element[1], "content") ??
      attributeOf(element[1], "href") ??
      attributeOf(element[1], "src"),
      {
        alt: attributeOf(element[1], "alt"),
        className: attributeOf(element[1], "class"),
        declaredType: attributeOf(element[1], "type"),
      },
    );
  }
  for (const link of html.matchAll(/<link\b([^>]*)>/gi)) {
    const rel = (attributeOf(link[1], "rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("image_src")) {
      add(attributeOf(link[1], "href"), {
        className: attributeOf(link[1], "class"),
        declaredType: attributeOf(link[1], "type"),
      });
    }
  }

  const source: `web:${string}` = `web:${new URL(pageUrl).host}`;
  return candidates.slice(0, 12).map((url) => ({ url, source, pageUrl }));
}

/** `\b` is ASCII-only in JavaScript: "Menü" never ends on a word boundary.
 * These use letter/number look-arounds instead. */
const word = (alternatives: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
const MENU_STRONG = word(
  "menus?|menü|menue|menükarte|menuekarte|speisekarten?|wochenspeisekarte|speisenkarten?|tageskarten?|speiseplan|speisen|karten?|eiskarten?|carte|getr(?:ä|ae)nke(?:karte)?|taplist|weinkarte",
);
const MENU_WEAK = word("food|drinks?|essen|mittag(?:stisch|skarte)?|lunch|dinner|brunch|cocktails?|frühstück|fruehstueck|breakfast");
/** Navigation that matches the weak words by accident, never a menu. */
const NOT_MENU = word("impressum|datenschutz|privacy|agb|terms|jobs?|karriere|career|presse|press|news|blog|kontakt|contact|about|über\\s*uns|map|anfahrt|standort|location|gutschein|voucher|shop|login|cart|gallery|galerie");
/** Same-page controls that carry the word "menu" without being one. */
const UI_FRAGMENT = /#(?:mobile|nav|main|site|header|footer|off-?canvas|hamburger)[-_]?(?:menu|nav)/i;

const RESERVATION_HOSTS = /(?:^|\.)(?:opentable\.\w+|resy\.com|quandoo\.\w+|thefork\.\w+|sevenrooms\.com|exploretock\.com|tock\.\w+|bookatable\.\w+|resmio\.com|reservation\.\w+)$/i;
const DELIVERY_HOSTS = /(?:^|\.)(?:lieferando\.\w+|wolt\.com|ubereats\.com|doordash\.com|deliveroo\.\w+|grubhub\.com|seamless\.com|postmates\.com|trycaviar\.com)$/i;

/** The most menu-like navigation link, if any. Text and href both count,
 * an explicit word beats a generic one, the site's own host beats a
 * third party, and a PDF only counts when the text says what it is. */
export function pickMenuLink(anchors: Anchor[], pageUrl: string): string | undefined {
  const pageHost = new URL(pageUrl).host.replace(/^www\./, "");
  let best: { url: string; score: number } | undefined;
  for (const a of anchors) {
    const url = resolve(pageUrl, a.href);
    if (!url || /^(mailto|tel|javascript):/i.test(a.href)) continue;
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    if (RESERVATION_HOSTS.test(host) || DELIVERY_HOSTS.test(host)) continue;
    let path: string;
    try {
      path = decodeURIComponent(u.pathname + u.hash).replace(/[-_/]+/g, " ");
    } catch {
      path = (u.pathname + u.hash).replace(/[-_/]+/g, " ");
    }
    if (UI_FRAGMENT.test(u.hash)) continue;
    const strongText = MENU_STRONG.test(a.text);
    const strongPath = MENU_STRONG.test(path);
    // A legal or shop word vetoes, unless the visible text says "menu" outright.
    if (NOT_MENU.test(a.text) || (NOT_MENU.test(path) && !strongText)) continue;
    let score = 0;
    if (strongText) score += 3;
    else if (strongPath) score += 2;
    if (score === 0) {
      if (MENU_WEAK.test(a.text)) score += 2;
      else if (MENU_WEAK.test(path)) score += 1;
    }
    if (score === 0) continue;
    if (host === pageHost) score += 1;
    // A PDF counts when either its text or its decoded path names a menu.
    if (/\.pdf(?:$|[?#])/i.test(u.pathname) && !strongText && !strongPath && !MENU_WEAK.test(a.text)) continue;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url;
}

function pickPlatform(anchors: Anchor[], pageUrl: string, hosts: RegExp): string | undefined {
  for (const a of anchors) {
    const url = resolve(pageUrl, a.href);
    if (!url) continue;
    if (hosts.test(new URL(url).host.replace(/^www\./, ""))) return url;
  }
  return undefined;
}

// --- menu page: what it mentions ------------------------------------------------

const MENTIONS: ReadonlyArray<{ key: string; re: RegExp }> = [
  { key: "vegan-options", re: word("vegan(?:e|es|er|em|en)?") },
  { key: "vegetarian-options", re: word("vegetari(?:an|sch(?:e|es|er|em|en)?)") },
  { key: "gluten-free-options", re: word("gluten[- ]?free|glutenfrei(?:e|es|er)?") },
  { key: "lactose-free-options", re: word("lactose[- ]?free|laktosefrei(?:e|es|er)?|dairy[- ]?free") },
  { key: "halal-options", re: word("halal") },
];

/** Dossier keys a menu page mentions by word. Evidence, not a verdict. */
export function scanMenuMentions(html: string): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return MENTIONS.filter((m) => m.re.test(text)).map((m) => m.key);
}

// --- the page -----------------------------------------------------------------

/** Pure: facts out of a fetched homepage. Exported for tests. */
export function parseWebsite(html: string, url: string, fetchedAt: string): WebFacts {
  const host = new URL(url).host;
  const facts: WebFacts = { url, host, fetchedAt, types: [] };
  const identity = extractPageIdentity(html);
  if (identity.title) facts.pageTitle = identity.title;
  if (identity.publisherNames.length) facts.publisherNames = identity.publisherNames;
  const nodes: Node[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectNodes(JSON.parse(m[1].trim()), nodes);
    } catch {
      /* a broken block is the site's problem, not a fact */
    }
  }
  const byId = new Map<string, Node>();
  for (const n of nodes) {
    const id = str(n["@id"]);
    if (id && !byId.has(id)) byId.set(id, n);
  }
  facts.types = [...new Set(nodes.flatMap(typesOf))].slice(0, 12);

  // The venue's facts may be spread over several nodes: food-typed ones
  // first, generic businesses after, each field from the first node that has it.
  const rank = (n: Node) => (typesOf(n).some((t) => FOOD_TYPES.test(t)) ? 0 : 1);
  const venues = nodes
    .filter((n) => typesOf(n).some((t) => FOOD_TYPES.test(t) || BUSINESS_TYPES.test(t)))
    .sort((a, b) => rank(a) - rank(b));
  const first = <T>(pick: (n: Node) => T | undefined): T | undefined => {
    for (const n of venues) {
      const v = pick(n);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const cuisine = first((n) => {
    const c = asList(n.servesCuisine).map(String).map((s) => s.trim().toLowerCase()).filter(Boolean);
    return c.length ? c : undefined;
  });
  if (cuisine) facts.cuisine = cuisine.slice(0, 6);
  const level = first((n) => priceRangeToLevel(n.priceRange));
  if (level) facts.priceLevel = level;
  const hours = first((n) => {
    const plain = asList(n.openingHours).map(String).filter(Boolean);
    const spec = hoursFromSpecification(n.openingHoursSpecification);
    const all = [...plain, ...spec];
    return all.length ? all : undefined;
  });
  if (hours) facts.hours = hours.slice(0, 14);
  const rating = first((n) => {
    const ar = n.aggregateRating as Node | undefined;
    if (!ar || typeof ar !== "object") return undefined;
    const value = Number(ar.ratingValue);
    const best = Number(ar.bestRating ?? 5);
    const count = Number(ar.ratingCount ?? ar.reviewCount);
    if (!Number.isFinite(value) || !Number.isFinite(best) || best <= 0 || value < 0 || value > best) return undefined;
    return { value, best, ...(Number.isFinite(count) && count > 0 ? { count } : {}) };
  });
  if (rating) facts.rating = rating;
  const wheelchair = first((n) => {
    for (const f of asList(n.amenityFeature) as Node[]) {
      if (f && typeof f === "object" && /wheelchair|barrierefrei|accessib/i.test(String(f.name ?? ""))) {
        const v = f.value;
        if (v === true || v === "True" || v === "true") return true;
        if (v === false || v === "False" || v === "false") return false;
      }
    }
    return undefined;
  });
  if (wheelchair !== undefined) facts.wheelchair = wheelchair;
  // A concrete URL beats a same-page fragment; a Menu object without a URL
  // is a fact about presence, not a link.
  const menu = first((n) => {
    const candidates = [urlOf(n.menu, byId), urlOf(n.hasMenu, byId)].filter((u): u is string => Boolean(u));
    return candidates.find((u) => !u.startsWith("#")) ?? candidates[0];
  });
  if (menu) facts.menuUrl = resolve(url, menu);
  const reservations = first((n) => {
    const r = urlOf(n.acceptsReservations, byId);
    return r && /^https?:/.test(r) ? r : undefined;
  });
  if (reservations) facts.reservationsUrl = reservations;
  const description =
    first((n) => str(n.description)) ??
    nodes.find((n) => typesOf(n).some((t) => PAGE_TYPES.test(t)) && str(n.description))?.description;
  if (typeof description === "string") {
    facts.description = clip(description.replace(/\s+/g, " ").trim(), 220);
  }

  // Navigation: what the page links to, for the things markup rarely declares.
  const anchors = extractAnchors(html);
  if (!facts.menuUrl) facts.menuUrl = pickMenuLink(anchors, url);
  if (!facts.reservationsUrl) facts.reservationsUrl = pickPlatform(anchors, url, RESERVATION_HOSTS);
  const delivery = pickPlatform(anchors, url, DELIVERY_HOSTS);
  if (delivery) facts.deliveryUrl = delivery;
  const imageCandidates = extractImageCandidates(html, url);
  if (imageCandidates.length) facts.imageCandidates = imageCandidates;
  return facts;
}

// --- fetching -----------------------------------------------------------------

const headers = { "user-agent": ENRICH_USER_AGENT, accept: "text/html,application/xhtml+xml,application/pdf;q=0.5" };

/** Read only the beginning of a homepage. Reaching the limit is success: the
 * metadata we need belongs in the head, so cancel the remainder instead of
 * buffering or rejecting the whole document. */
export async function readBoundedHtmlBody(
  response: Response,
  maxBytes = MAX_IMAGE_CANDIDATE_HTML_BYTES,
): Promise<string> {
  if (!response.body || maxBytes <= 0) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        size += remaining;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
}

export async function fetchAllowed(
  target: URL,
  fetchImpl: FetchLike,
  timeoutMs = TIMEOUT_MS,
  cache?: WebsitePageCache,
): Promise<boolean> {
  const robotsUrl = new URL("/robots.txt", target.origin);
  const cached = await cache?.load(robotsUrl);
  if (cached?.fresh) return robotsAllows(cached.robots ?? "", target.pathname || "/");
  const robotsHeaders = new Headers(headers);
  if (cached?.etag) robotsHeaders.set("if-none-match", cached.etag);
  if (cached?.lastModified) robotsHeaders.set("if-modified-since", cached.lastModified);
  const robots = await fetchPublic(robotsUrl, {
    headers: robotsHeaders,
    signal: AbortSignal.timeout(timeoutMs),
  }, fetchImpl).catch(() => null);
  if (!robots) return true;
  if (robots.status === 304 && cached) {
    await robots.body?.cancel();
    await cache?.refresh(robotsUrl, ROBOTS_CACHE_TTL_MS);
    return robotsAllows(cached.robots ?? "", target.pathname || "/");
  }
  if (!robots.ok) {
    await robots.body?.cancel();
    await storeCacheResponse(cache, robots, {
      url: robotsUrl.toString(),
      status: robots.status,
      ttlMs: ROBOTS_CACHE_TTL_MS,
      robots: null,
    });
    return true;
  }
  const text = await readBoundedHtmlBody(robots, 100_000);
  await storeCacheResponse(cache, robots, {
    url: robotsUrl.toString(),
    status: robots.status,
    ttlMs: ROBOTS_CACHE_TTL_MS,
    etag: robots.headers.get("etag"),
    lastModified: robots.headers.get("last-modified"),
    robots: text,
  });
  return robotsAllows(text, target.pathname || "/");
}

const isHtmlResponse = (response: Response): boolean =>
  /(?:text\/html|application\/(?:xhtml\+xml|xml)|text\/xml)/i.test(
    response.headers.get("content-type") ?? "",
  );

/** A lightweight second chance for image refreshes whose durable website
 * facts predate image extraction. It shares the normal website network
 * boundary, but reads only a bounded homepage prefix and parses no facts. */
export async function fetchWebsiteImageCandidates(
  url: string,
  fetchImpl: FetchLike = outboundFetchFor("venue-site", {
    maxBytes: MAX_HTML,
    timeoutMs: TIMEOUT_MS,
  }),
  cache?: WebsitePageCache,
): Promise<WebsiteImageCandidate[]> {
  let target: URL;
  try {
    target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("scheme");
  } catch {
    return [];
  }
  try {
    if (!(await fetchAllowed(target, fetchImpl, TIMEOUT_MS, cache))) return [];
    const cached = await cache?.load(target);
    if (cached?.fresh) return cached.imageCandidates ?? [];

    // HEAD is advisory. Sites commonly reject it, so only a successful HEAD
    // can rule the GET out. A large declared document is still useful because
    // the GET below stops after its first 512 KiB.
    const head = await fetchPublic(target, {
      method: "HEAD",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, fetchImpl).catch(() => null);
    if (head?.ok) {
      const type = head.headers.get("content-type");
      if (type && !isHtmlResponse(head)) return [];
      const declaredHeader = head.headers.get("content-length");
      const declared = declaredHeader === null ? undefined : Number(declaredHeader);
      if (Number.isFinite(declared) && declared === 0) return [];
    }

    const conditionalHeaders = new Headers(headers);
    if (cached?.etag) conditionalHeaders.set("if-none-match", cached.etag);
    if (cached?.lastModified) conditionalHeaders.set("if-modified-since", cached.lastModified);
    const response = await fetchPublic(target, {
      headers: conditionalHeaders,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, fetchImpl);
    if (response.status === 304 && cached) {
      await response.body?.cancel();
      await cache?.refresh(target, PAGE_CACHE_TTL_MS);
      return cached.imageCandidates ?? [];
    }
    if (!response.ok || !isHtmlResponse(response)) {
      await response.body?.cancel();
      return [];
    }
    const html = await readBoundedHtmlBody(response);
    const pageUrl = response.url || target.toString();
    const candidates = extractImageCandidates(html, pageUrl);
    await storeCacheResponse(cache, response, {
      url: target.toString(),
      status: response.status,
      ttlMs: PAGE_CACHE_TTL_MS,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      text: extractVisibleText(html),
      imageCandidates: candidates,
    });
    return candidates;
  } catch {
    return [];
  }
}

/**
 * One fetch of one venue's homepage, then one of its menu page. Null when
 * robots forbids it, the host does not answer, or the page is not HTML — a
 * "null" is a fact too (the drawer shows it), never an error to the room.
 */
export interface MenuFile {
  kind: "pdf" | "image";
  url: string;
  contentType: string;
  bytes: Uint8Array;
}
export interface WebsiteTransientText {
  homepage?: string;
  menu?: string;
}
export interface WebsiteFetchResult {
  facts: WebFacts | null;
  error?: string;
  menuFile?: MenuFile;
  /** Server-private evaluator evidence, backed by page_cache for seven days;
   * never included in WebFacts, a dossier, an API response, or a log. */
  pageText?: WebsiteTransientText;
}

export interface WebsitePageCache {
  load(url: string | URL): Promise<PageCacheEntry | null>;
  store(input: StorePageInput): Promise<void>;
  refresh(url: string | URL, ttlMs?: number): Promise<void>;
  remove?(url: string | URL): Promise<void>;
}

function responseAllowsSharedCache(response: Response): boolean {
  const value = (response.headers.get("cache-control") ?? "").toLowerCase();
  return !/(?:^|,)\s*(?:no-store|no-cache|private)(?:\s|,|$)/.test(value);
}

async function storeCacheResponse(
  cache: WebsitePageCache | undefined,
  response: Response,
  input: StorePageInput,
): Promise<void> {
  if (!cache) return;
  if (!responseAllowsSharedCache(response)) {
    await cache.remove?.(input.url);
    return;
  }
  await cache.store(input);
}
const MAX_MENU_FILE = 4_000_000;

export async function fetchWebsiteFacts(
  url: string,
  fetchImpl: FetchLike = outboundFetchFor("venue-site", {
    maxBytes: MAX_HTML,
    timeoutMs: TIMEOUT_MS,
  }),
  cache?: WebsitePageCache,
  previousFacts?: WebFacts | null,
): Promise<WebsiteFetchResult> {
  let target: URL;
  try {
    target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("scheme");
  } catch {
    return { facts: null, error: "not a fetchable URL" };
  }
  try {
    if (!(await fetchAllowed(target, fetchImpl, TIMEOUT_MS, cache))) return { facts: null, error: "robots.txt disallows" };
    const cached = await cache?.load(target);
    if (cached?.fresh) {
      const facts = previousFacts
        ? { ...previousFacts, ...(cached.imageCandidates?.length ? { imageCandidates: cached.imageCandidates } : {}) }
        : null;
      const followed = facts?.menuUrl ? await followMenu(facts, fetchImpl, cache) : undefined;
      const pageText = {
        ...(cached.text ? { homepage: cached.text } : {}),
        ...(followed?.text ? { menu: followed.text } : {}),
      };
      return {
        facts,
        ...(followed?.menuFile ? { menuFile: followed.menuFile } : {}),
        ...(Object.keys(pageText).length ? { pageText } : {}),
      };
    }
    const conditionalHeaders = new Headers(headers);
    if (cached?.etag) conditionalHeaders.set("if-none-match", cached.etag);
    if (cached?.lastModified) conditionalHeaders.set("if-modified-since", cached.lastModified);
    const res = await fetchPublic(target, {
      headers: conditionalHeaders,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, fetchImpl);
    if (res.status === 304 && cached) {
      await res.body?.cancel();
      await cache?.refresh(target, PAGE_CACHE_TTL_MS);
      const facts = previousFacts
        ? { ...previousFacts, ...(cached.imageCandidates?.length ? { imageCandidates: cached.imageCandidates } : {}) }
        : null;
      const followed = facts?.menuUrl ? await followMenu(facts, fetchImpl, cache) : undefined;
      const pageText = {
        ...(cached.text ? { homepage: cached.text } : {}),
        ...(followed?.text ? { menu: followed.text } : {}),
      };
      return {
        facts,
        ...(followed?.menuFile ? { menuFile: followed.menuFile } : {}),
        ...(Object.keys(pageText).length ? { pageText } : {}),
      };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { facts: null, error: `HTTP ${res.status}` };
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/html|xml/.test(type)) {
      await res.body?.cancel();
      return { facts: null, error: `not HTML (${type.split(";")[0]})` };
    }
    const html = await readBoundedHtmlBody(res, MAX_HTML);
    const homepageText = extractVisibleText(html);
    const facts = parseWebsite(html, res.url || target.toString(), new Date().toISOString());
    await storeCacheResponse(cache, res, {
      url: target.toString(),
      status: res.status,
      ttlMs: PAGE_CACHE_TTL_MS,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      text: homepageText,
      imageCandidates: facts.imageCandidates ?? [],
    });
    const followed = facts.menuUrl ? await followMenu(facts, fetchImpl, cache) : undefined;
    const pageText = {
      ...(homepageText ? { homepage: homepageText } : {}),
      ...(followed?.text ? { menu: followed.text } : {}),
    };
    return {
      facts,
      ...(followed?.menuFile ? { menuFile: followed.menuFile } : {}),
      ...(Object.keys(pageText).length > 0 ? { pageText } : {}),
    };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return { facts: null, error: `${e?.name ?? "Error"}: ${e?.cause?.message ?? e?.message ?? String(err)}`.slice(0, 120) };
  }
}

/** The second request: what the menu link leads to, and what it mentions.
 * Returns the file when the menu turns out to be a picture, so the caller
 * can have it read. */
async function followMenu(
  facts: WebFacts,
  fetchImpl: FetchLike,
  cache?: WebsitePageCache,
): Promise<{ menuFile?: MenuFile; text?: string } | undefined> {
  try {
    const menu = new URL(facts.menuUrl!);
    // Same origin was already cleared by robots; a third-party host gets its own check.
    if (menu.host !== new URL(facts.url).host && !(await fetchAllowed(menu, fetchImpl, TIMEOUT_MS, cache))) return undefined;
    const cached = await cache?.load(menu);
    if (cached?.fresh) return cached.text ? { text: cached.text } : undefined;
    const conditionalHeaders = new Headers(headers);
    if (cached?.etag) conditionalHeaders.set("if-none-match", cached.etag);
    if (cached?.lastModified) conditionalHeaders.set("if-modified-since", cached.lastModified);
    const res = await fetchPublic(menu, { headers: conditionalHeaders, signal: AbortSignal.timeout(TIMEOUT_MS) }, fetchImpl);
    if (res.status === 304 && cached) {
      await res.body?.cancel();
      await cache?.refresh(menu, PAGE_CACHE_TTL_MS);
      return cached.text ? { text: cached.text } : undefined;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return undefined;
    }
    // A redirect that lands on the homepage or another site is not the menu.
    if (res.url) {
      const landed = new URL(res.url);
      const home = new URL(facts.url);
      const offSite = landed.host.replace(/^www\./, "") !== menu.host.replace(/^www\./, "");
      const backHome = landed.host === home.host && landed.pathname.replace(/\/$/, "") === home.pathname.replace(/\/$/, "") && !landed.hash;
      if (offSite || backHome) {
        facts.menuUrl = undefined;
        await res.body?.cancel();
        return undefined;
      }
    }
    const type = res.headers.get("content-type") ?? "";
    const fileUrl = res.url || menu.toString();
    if (/pdf/.test(type)) {
      facts.menuKind = "pdf";
      facts.menuFileUrl = fileUrl;
      const menuFile = await fileOf("pdf", fileUrl, type, res);
      return menuFile ? { menuFile } : undefined;
    }
    if (/^image\//.test(type)) {
      facts.menuKind = "image";
      facts.menuFileUrl = fileUrl;
      const menuFile = await fileOf("image", fileUrl, type, res);
      return menuFile ? { menuFile } : undefined;
    }
    if (!/html|xml|text/.test(type)) {
      facts.menuKind = "other";
      await res.body?.cancel();
      return undefined;
    }
    const html = await readBoundedHtmlBody(res, MAX_HTML);
    const text = extractVisibleText(html);
    await storeCacheResponse(cache, res, {
      url: menu.toString(),
      status: res.status,
      ttlMs: PAGE_CACHE_TTL_MS,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      text,
      imageCandidates: extractImageCandidates(html, fileUrl),
    });
    const mentions = scanMenuMentions(html);
    if (mentions.length) facts.menuMentions = mentions;
    // A menu page with almost no text and a big picture: the picture is the menu.
    const picture = menuImageOf(html, fileUrl);
    if (picture) {
      facts.menuKind = "image";
      facts.menuFileUrl = picture;
      const img = await fetchPublic(new URL(picture), { headers: { ...headers, accept: "image/*" }, signal: AbortSignal.timeout(TIMEOUT_MS) }, fetchImpl).catch(() => null);
      const imgType = img?.headers.get("content-type") ?? "";
      if (img?.ok && /^image\//.test(imgType)) {
        const menuFile = await fileOf("image", picture, imgType, img);
        return { ...(text ? { text } : {}), ...(menuFile ? { menuFile } : {}) };
      }
      return text ? { text } : undefined;
    }
    facts.menuKind = "html";
    return text ? { text } : undefined;
  } catch {
    /* the homepage facts stand; the menu page is a bonus */
    return undefined;
  }
}

async function fileOf(kind: MenuFile["kind"], url: string, contentType: string, res: Response): Promise<MenuFile | undefined> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MENU_FILE) return undefined;
  return { kind, url, contentType: contentType.split(";")[0].trim(), bytes };
}

/** On a menu page that is mostly a picture, the picture's URL; else undefined. */
export function menuImageOf(html: string, pageUrl: string): string | undefined {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > 600) return undefined;
  const imgs = [...html.matchAll(/<img\b([^>]*)>/gi)].map((m) => m[1]);
  const pick = (re: RegExp) =>
    imgs.find((attrs) => re.test(attrs) && !/logo|icon|avatar|sprite|pixel|tracking/i.test(attrs));
  const chosen =
    pick(/(?:src|alt|class|id)\s*=\s*["'][^"']*(?:menu|speisekarte|karte|carte)[^"']*["']/i) ??
    (imgs.length === 1 ? imgs[0] : undefined);
  if (!chosen) return undefined;
  const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(chosen);
  const raw = src?.[1] ?? src?.[2];
  if (!raw || /^data:/i.test(raw)) return undefined;
  return resolve(pageUrl, raw);
}
