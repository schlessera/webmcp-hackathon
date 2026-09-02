/**
 * A place's own website as a source (docs/ENRICHMENT-SOURCES.md, S2).
 *
 * The one intermediary-free source there is: what the venue publishes about
 * itself, explicitly for machines, as schema.org JSON-LD — cuisine, price
 * range, hours, a menu, a rating it chose to show, accessibility features —
 * and, for machines only by accident, the links in its navigation. Text
 * stays the venue's copyright, so nothing is stored beyond the parsed facts,
 * a few URLs and a one-line description; robots.txt is honoured; at most
 * two requests per venue (homepage, then the menu page); the User-Agent
 * names the project.
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
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const UA =
  "spokes-enrich/0.2 (+https://github.com/schlessera/webmcp-hackathon; reads what a venue publishes about itself)";
const TIMEOUT_MS = 8000;
const MAX_HTML = 1_500_000;

const FOOD_TYPES = /Restaurant|Cafe|CoffeeShop|Bar|Pub|Bakery|Brewery|Winery|FoodEstablishment|IceCreamShop|FastFood|Distillery/;
const BUSINESS_TYPES = /LocalBusiness|Organization|Store|EntertainmentBusiness|LodgingBusiness|Hotel/;
const PAGE_TYPES = /^(WebPage|WebSite)$/;

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
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'");
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
  return facts;
}

// --- fetching -----------------------------------------------------------------

const headers = { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/pdf;q=0.5" };

async function fetchAllowed(target: URL, fetchImpl: FetchLike): Promise<boolean> {
  const robots = await fetchImpl(`${target.origin}/robots.txt`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!robots || !robots.ok) return true;
  const text = (await robots.text()).slice(0, 100_000);
  return robotsAllows(text, target.pathname || "/");
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
const MAX_MENU_FILE = 4_000_000;

export async function fetchWebsiteFacts(
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ facts: WebFacts | null; error?: string; menuFile?: MenuFile }> {
  let target: URL;
  try {
    target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("scheme");
  } catch {
    return { facts: null, error: "not a fetchable URL" };
  }
  try {
    if (!(await fetchAllowed(target, fetchImpl))) return { facts: null, error: "robots.txt disallows" };
    const res = await fetchImpl(target.toString(), {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { facts: null, error: `HTTP ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (!/html|xml/.test(type)) return { facts: null, error: `not HTML (${type.split(";")[0]})` };
    const html = (await res.text()).slice(0, MAX_HTML);
    const facts = parseWebsite(html, res.url || target.toString(), new Date().toISOString());
    const menuFile = facts.menuUrl ? await followMenu(facts, fetchImpl) : undefined;
    return { facts, ...(menuFile ? { menuFile } : {}) };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return { facts: null, error: `${e?.name ?? "Error"}: ${e?.cause?.message ?? e?.message ?? String(err)}`.slice(0, 120) };
  }
}

/** The second request: what the menu link leads to, and what it mentions.
 * Returns the file when the menu turns out to be a picture, so the caller
 * can have it read. */
async function followMenu(facts: WebFacts, fetchImpl: FetchLike): Promise<MenuFile | undefined> {
  try {
    const menu = new URL(facts.menuUrl!);
    // Same origin was already cleared by robots; a third-party host gets its own check.
    if (menu.host !== new URL(facts.url).host && !(await fetchAllowed(menu, fetchImpl))) return undefined;
    const res = await fetchImpl(menu.toString(), { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return undefined;
    // A redirect that lands on the homepage or another site is not the menu.
    if (res.url) {
      const landed = new URL(res.url);
      const home = new URL(facts.url);
      const offSite = landed.host.replace(/^www\./, "") !== menu.host.replace(/^www\./, "");
      const backHome = landed.host === home.host && landed.pathname.replace(/\/$/, "") === home.pathname.replace(/\/$/, "") && !landed.hash;
      if (offSite || backHome) {
        facts.menuUrl = undefined;
        return undefined;
      }
    }
    const type = res.headers.get("content-type") ?? "";
    const fileUrl = res.url || menu.toString();
    if (/pdf/.test(type)) {
      facts.menuKind = "pdf";
      facts.menuFileUrl = fileUrl;
      return await fileOf("pdf", fileUrl, type, res);
    }
    if (/^image\//.test(type)) {
      facts.menuKind = "image";
      facts.menuFileUrl = fileUrl;
      return await fileOf("image", fileUrl, type, res);
    }
    if (!/html|xml|text/.test(type)) {
      facts.menuKind = "other";
      return undefined;
    }
    const html = (await res.text()).slice(0, MAX_HTML);
    const mentions = scanMenuMentions(html);
    if (mentions.length) facts.menuMentions = mentions;
    // A menu page with almost no text and a big picture: the picture is the menu.
    const picture = menuImageOf(html, fileUrl);
    if (picture) {
      facts.menuKind = "image";
      facts.menuFileUrl = picture;
      const img = await fetchImpl(picture, { headers: { ...headers, accept: "image/*" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
      const imgType = img?.headers.get("content-type") ?? "";
      if (img?.ok && /^image\//.test(imgType)) return await fileOf("image", picture, imgType, img);
      return undefined;
    }
    facts.menuKind = "html";
    return undefined;
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
