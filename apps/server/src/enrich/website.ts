/**
 * A place's own website as a source (docs/ENRICHMENT-SOURCES.md, S2).
 *
 * The one intermediary-free source there is: what the venue publishes about
 * itself, explicitly for machines, as schema.org JSON-LD — cuisine, price
 * range, hours, a menu, a rating it chose to show, accessibility features.
 * Text stays the venue's copyright, so nothing is stored beyond the parsed
 * facts, a menu URL and a one-line description; robots.txt is honoured;
 * one request per host; the User-Agent names the project.
 *
 * Measured 2026-09-02 on 160 pool venues with a website tag: ~80 % reachable,
 * ~half carry any JSON-LD, ~16 % a food-typed node, 4–9 % a servesCuisine,
 * 8 % a priceRange, 4 % a rating — and 56 % link a menu somewhere on the
 * page. So the menu link is the reliable win; the facts are a bonus.
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
  /** Raw openingHours strings, as published. */
  hours?: string[];
  rating?: { value: number; best: number; count?: number };
  wheelchair?: boolean;
  menuUrl?: string;
  reservationsUrl?: string;
  description?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const UA =
  "spokes-enrich/0.1 (+https://github.com/schlessera/webmcp-hackathon; reads schema.org data a venue publishes about itself)";
const TIMEOUT_MS = 8000;
const MAX_HTML = 1_500_000;

const FOOD_TYPES = /Restaurant|Cafe|CoffeeShop|Bar|Pub|Bakery|Brewery|Winery|FoodEstablishment|IceCreamShop|FastFood/;
const BUSINESS_TYPES = /LocalBusiness|Organization|Store/;

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
  const s = raw.trim();
  const m = /^([$€£]{1,4})$/.exec(s);
  if (m) return m[1].length;
  return undefined;
}

interface Node {
  [k: string]: unknown;
}

function nodesOf(json: unknown): Node[] {
  if (Array.isArray(json)) return json.flatMap(nodesOf);
  if (json && typeof json === "object") {
    const n = json as Node;
    const graph = n["@graph"];
    return Array.isArray(graph) ? [n, ...graph.flatMap(nodesOf)] : [n];
  }
  return [];
}

const typesOf = (n: Node): string[] => ([] as unknown[]).concat(n["@type"] ?? []).map(String);

function firstUrl(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(firstUrl).find(Boolean);
  if (v && typeof v === "object") {
    const o = v as Node;
    return firstUrl(o.url) ?? firstUrl(o["@id"]);
  }
  return undefined;
}

function resolve(base: string, href: string): string | undefined {
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
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

/** Pure: facts out of a fetched page. Exported for tests. */
export function parseWebsite(html: string, url: string, fetchedAt: string): WebFacts {
  const host = new URL(url).host;
  const facts: WebFacts = { url, host, fetchedAt, types: [] };
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const nodes: Node[] = [];
  for (const m of blocks) {
    try {
      nodes.push(...nodesOf(JSON.parse(m[1].trim())));
    } catch {
      /* a broken block is the site's problem, not a fact */
    }
  }
  // The venue node: a food type first, a generic business as fallback.
  const typed = nodes.filter((n) => typesOf(n).some((t) => FOOD_TYPES.test(t)));
  const business = nodes.filter((n) => typesOf(n).some((t) => BUSINESS_TYPES.test(t)));
  const venue = typed[0] ?? business[0];
  facts.types = [...new Set(nodes.flatMap(typesOf))].slice(0, 12);
  if (venue) {
    const cuisine = ([] as unknown[]).concat(venue.servesCuisine ?? []).map(String).map((c) => c.trim().toLowerCase()).filter(Boolean);
    if (cuisine.length) facts.cuisine = cuisine.slice(0, 6);
    const level = priceRangeToLevel(venue.priceRange);
    if (level) facts.priceLevel = level;
    const hours = ([] as unknown[]).concat(venue.openingHours ?? []).map(String).filter(Boolean);
    if (hours.length) facts.hours = hours.slice(0, 14);
    const ar = venue.aggregateRating as Node | undefined;
    if (ar && typeof ar === "object") {
      const value = Number(ar.ratingValue);
      const best = Number(ar.bestRating ?? 5);
      const count = Number(ar.ratingCount ?? ar.reviewCount);
      if (Number.isFinite(value) && Number.isFinite(best) && best > 0 && value >= 0 && value <= best) {
        facts.rating = { value, best, ...(Number.isFinite(count) && count > 0 ? { count } : {}) };
      }
    }
    for (const f of ([] as unknown[]).concat(venue.amenityFeature ?? []) as Node[]) {
      if (f && typeof f === "object" && /wheelchair|barrierefrei|accessib/i.test(String(f.name ?? ""))) {
        const v = f.value;
        if (v === true || v === "True" || v === "true") facts.wheelchair = true;
        else if (v === false || v === "False" || v === "false") facts.wheelchair = false;
      }
    }
    const menu = firstUrl(venue.hasMenu) ?? firstUrl(venue.menu);
    if (menu) facts.menuUrl = resolve(url, menu);
    const reservations = firstUrl(venue.acceptsReservations);
    if (reservations && /^https?:/.test(reservations)) facts.reservationsUrl = reservations;
    if (typeof venue.description === "string" && venue.description.trim()) {
      facts.description = clip(venue.description.trim().replace(/\s+/g, " "), 220);
    }
  }
  if (!facts.menuUrl) {
    // Most venues link a menu somewhere on the page without marking it up.
    const link = /<a[^>]+href=["']([^"']*(?:menu|speisekarte|men[üu]|carte|karte\b)[^"']*)["']/i.exec(html);
    if (link) facts.menuUrl = resolve(url, link[1]);
  }
  return facts;
}

/**
 * One fetch of one venue's homepage. Null when robots forbids it, the host
 * does not answer, or the page is not HTML — a "null" is a fact too (the
 * drawer shows it), never an error to the room.
 */
export async function fetchWebsiteFacts(
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ facts: WebFacts | null; error?: string }> {
  let target: URL;
  try {
    target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("scheme");
  } catch {
    return { facts: null, error: "not a fetchable URL" };
  }
  const headers = { "user-agent": UA, accept: "text/html,application/xhtml+xml" };
  try {
    const robots = await fetchImpl(`${target.origin}/robots.txt`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    if (robots && robots.ok) {
      const text = (await robots.text()).slice(0, 100_000);
      if (!robotsAllows(text, target.pathname || "/")) return { facts: null, error: "robots.txt disallows" };
    }
    const res = await fetchImpl(target.toString(), {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { facts: null, error: `HTTP ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (!/html|xml/.test(type)) return { facts: null, error: `not HTML (${type.split(";")[0]})` };
    const html = (await res.text()).slice(0, MAX_HTML);
    return { facts: parseWebsite(html, res.url || target.toString(), new Date().toISOString()) };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return { facts: null, error: `${e?.name ?? "Error"}: ${e?.cause?.message ?? e?.message ?? String(err)}`.slice(0, 120) };
  }
}
