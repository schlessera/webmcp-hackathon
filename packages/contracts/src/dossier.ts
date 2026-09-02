/**
 * OpenStreetMap tags → dossier attributes. One mapping, shared by the
 * curation script (the shipped demo dataset) and the server's live path, so
 * a tag reads the same whichever way it reached a room.
 *
 * Status vocabulary (SPATIAL-PROTOCOL.md §8): `yes` → verified_true, `no` →
 * verified_false, any other value → unverified, absent → unknown. Only the
 * two verified statuses let the eligibility engine rule; everything else is
 * uncertain, and uncertain is a state the UI draws (CLAUDE.md §4).
 *
 * Nothing here invents a value. No default opening hours, no guessed price
 * band: a place with no `opening_hours` tag has no hours on record, and its
 * `hours` attribute says so.
 */

export interface DossierAttribute {
  key: string;
  status: "verified_true" | "verified_false" | "unverified" | "unknown";
  value?: string | number;
  source: string;
  observedAt: string;
  confidence: number;
}

export interface DossierHours {
  day: string;
  open: string;
  close: string;
}

/** The boolean facts the engine reads, in render order. */
export const BOOLEAN_ATTRS: ReadonlyArray<{ key: string; tag: string }> = [
  { key: "vegetarian-options", tag: "diet:vegetarian" },
  { key: "vegan-options", tag: "diet:vegan" },
  { key: "gluten-free-options", tag: "diet:gluten_free" },
  { key: "halal-options", tag: "diet:halal" },
  { key: "lactose-free-options", tag: "diet:lactose_free" },
  { key: "wheelchair-accessible", tag: "wheelchair" },
  { key: "outdoor-seating", tag: "outdoor_seating" },
  { key: "dog-friendly", tag: "dog" },
  { key: "takeaway", tag: "takeaway" },
  { key: "delivery", tag: "delivery" },
];

/** A link the place panel can offer. `label` is server-authored and the
 * client renders it verbatim — link kinds are data, not chrome. */
export interface DossierLink {
  kind: "website" | "menu" | "hours" | "instagram" | "wikipedia" | "reservations";
  label: string;
  url: string;
  source: string;
}

const LINK_TAGS: ReadonlyArray<{ kind: DossierLink["kind"]; label: string; tags: string[] }> = [
  { kind: "menu", label: "menu", tags: ["website:menu", "menu:url", "contact:menu"] },
  { kind: "website", label: "website", tags: ["website", "contact:website"] },
  { kind: "hours", label: "opening hours", tags: ["opening_hours:url"] },
  { kind: "instagram", label: "instagram", tags: ["contact:instagram", "instagram"] },
  { kind: "reservations", label: "reservations", tags: ["reservation:url", "contact:reservation"] },
];

function asUrl(raw: string): string | null {
  const v = raw.trim().split(";")[0].trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(v)) return `https://${v}`;
  if (/^@?[A-Za-z0-9_.]{2,30}$/.test(v)) return null; // a bare handle; resolved per kind below
  return null;
}

/** The links OSM itself carries for a place. */
export function linksFromTags(tags: Record<string, string | undefined>): DossierLink[] {
  const out: DossierLink[] = [];
  for (const { kind, label, tags: keys } of LINK_TAGS) {
    for (const key of keys) {
      const raw = tags[key];
      if (!raw) continue;
      let url = asUrl(raw);
      if (!url && kind === "instagram") {
        const handle = raw.trim().replace(/^@/, "");
        if (/^[A-Za-z0-9_.]{2,30}$/.test(handle)) url = `https://www.instagram.com/${handle}/`;
      }
      if (!url) continue;
      out.push({ kind, label, url, source: `osm:${key}` });
      break;
    }
  }
  return out;
}

/** Tags the snapshot keeps per venue: everything the mapping reads, plus the
 * few a person or their agent can act on (website, phone) — never the whole
 * tag set, so the snapshot stays small and its contents reviewable. */
export const KEPT_TAGS: readonly string[] = [
  "amenity",
  "name",
  "cuisine",
  "opening_hours",
  "opening_hours:url",
  "diet:vegetarian",
  "diet:vegan",
  "diet:lactose_free",
  "diet:gluten_free",
  "diet:halal",
  "wheelchair",
  "toilets:wheelchair",
  "outdoor_seating",
  "dog",
  "takeaway",
  "delivery",
  "reservation",
  "internet_access",
  "website",
  "contact:website",
  "website:menu",
  "menu:url",
  "contact:instagram",
  "phone",
  "contact:phone",
  "description",
  "wikidata",
  "brand",
  "brand:wikidata",
  "addr:street",
  "addr:housenumber",
  "check_date",
];

export function booleanAttr(
  key: string,
  tag: string,
  tags: Record<string, string | undefined>,
  observedAt: string,
): DossierAttribute {
  const raw = tags[tag];
  const base = { key, source: `osm:${tag}`, observedAt };
  if (raw === "yes") return { ...base, status: "verified_true", confidence: 0.8 };
  if (raw === "no") return { ...base, status: "verified_false", confidence: 0.8 };
  if (raw !== undefined) return { ...base, status: "unverified", confidence: 0.6 }; // "limited", "only" …
  return { ...base, status: "unknown", confidence: 0.6 };
}

const DAY_MAP: Record<string, string> = {
  Mo: "mon", Tu: "tue", We: "wed", Th: "thu", Fr: "fri", Sa: "sat", Su: "sun",
};
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function clampTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  if (h >= 24) return "23:59";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function expandDays(spec: string): string[] {
  // "Mo-Fr", "Sa,Su", "Mo", "Sa-Su,PH" → ["mon", …]; unknown tokens skipped.
  const days: string[] = [];
  for (const part of spec.split(",")) {
    const range = part.trim().match(/^([A-Z][a-z])-([A-Z][a-z])$/);
    if (range && DAY_MAP[range[1]] && DAY_MAP[range[2]]) {
      let i = DAY_ORDER.indexOf(DAY_MAP[range[1]]);
      const end = DAY_ORDER.indexOf(DAY_MAP[range[2]]);
      for (; ; i = (i + 1) % 7) {
        days.push(DAY_ORDER[i]);
        if (i === end) break;
      }
    } else if (DAY_MAP[part.trim()]) {
      days.push(DAY_MAP[part.trim()]);
    }
  }
  return days;
}

/**
 * Best-effort parse of the common subset of the OSM `opening_hours` syntax:
 * "24/7", "Mo-Fr 08:00-18:00; Sa 10:00-14:00", "12:00-23:00", open-ended
 * "18:00+". Returns null when nothing usable could be extracted — the caller
 * decides what null means (the live path: no hours on record).
 */
export function parseOpeningHours(oh: string | undefined): DossierHours[] | null {
  if (!oh) return null;
  if (oh.trim() === "24/7") {
    return DAY_ORDER.map((day) => ({ day, open: "00:00", close: "23:59" }));
  }
  const byDay = new Map<string, DossierHours>();
  for (const rule of oh.split(";")) {
    // Leading day spec, then time spec: "Mo-Fr 08:00-18:00,19:00-22:00".
    const m = rule
      .trim()
      .match(/^([A-Za-z,\- ]*?)\s*((?:\d{1,2}:\d{2}[-+](?:\d{1,2}:\d{2})?)(?:,\d{1,2}:\d{2}[-+](?:\d{1,2}:\d{2})?)*)$/);
    if (!m) continue; // "Mo off", "Su closed", unparseable → skip
    const days = m[1].trim() ? expandDays(m[1]) : DAY_ORDER;
    const first = m[2].split(",")[0]; // first time range per rule
    const tm = first.match(/^(\d{1,2}:\d{2})[-+](\d{1,2}:\d{2})?$/);
    if (!tm || days.length === 0) continue;
    const open = clampTime(tm[1]);
    const close = tm[2] ? clampTime(tm[2]) : "23:59"; // "18:00+" → open end
    for (const day of days) {
      if (!byDay.has(day)) byDay.set(day, { day, open, close });
    }
  }
  if (byDay.size === 0) return null;
  return DAY_ORDER.filter((d) => byDay.has(d)).map((d) => byDay.get(d)!);
}

export interface Dossier {
  category: string;
  attributes: DossierAttribute[];
  hours: DossierHours[];
  /** Always null on the live path: OSM carries no price band, and an unknown
   * price is uncertain under a budget need, never an invented band. */
  priceLevel: null;
  /** What OSM knows beyond facts: links, a description, ids to look up. */
  extras: DossierExtras;
}

export interface DossierExtras {
  links: DossierLink[];
  description?: { text: string; source: string };
  /** For the enrichment layer (apps/server/src/enrich): where to look. */
  website?: string;
  wikidata?: string;
}

/**
 * The live mapping. Real tags in, real statuses out, and `unknown` wherever
 * OSM is silent. `observedAt` is the extract timestamp, so every attribute
 * carries when the data was true, not when it was read.
 */
export function dossierFromTags(
  tags: Record<string, string | undefined>,
  observedAt: string,
): Dossier {
  const attributes: DossierAttribute[] = BOOLEAN_ATTRS.map(({ key, tag }) =>
    booleanAttr(key, tag, tags, observedAt),
  );
  if (tags.cuisine) {
    attributes.push({
      key: "cuisine",
      value: tags.cuisine,
      status: "verified_true",
      source: "osm:cuisine",
      observedAt,
      confidence: 0.8,
    });
  } else {
    attributes.push({
      key: "cuisine",
      status: "unknown",
      source: "osm:cuisine",
      observedAt,
      confidence: 0.6,
    });
  }
  // Price: no OSM tag is read for it, and nothing is guessed. The attribute
  // is present so the ledger can say "not known" instead of omitting it.
  attributes.push({
    key: "price-level",
    status: "unknown",
    source: "osm:price",
    observedAt,
    confidence: 0.6,
  });
  const hours = parseOpeningHours(tags.opening_hours);
  attributes.push({
    key: "hours",
    ...(tags.opening_hours ? { value: tags.opening_hours } : {}),
    status: hours ? "verified_true" : tags.opening_hours ? "unverified" : "unknown",
    source: "osm:opening_hours",
    observedAt,
    confidence: hours ? 0.8 : 0.6,
  });
  const links = linksFromTags(tags);
  const website = links.find((l) => l.kind === "website")?.url;
  return {
    category: tags.amenity ?? "place",
    attributes,
    hours: hours ?? [],
    priceLevel: null,
    extras: {
      links,
      ...(tags.description
        ? { description: { text: tags.description.slice(0, 400), source: "osm:description" } }
        : {}),
      ...(website ? { website } : {}),
      ...(tags.wikidata ? { wikidata: tags.wikidata } : {}),
    },
  };
}

/**
 * Whether the engine can rule on an attribute: only the two verified
 * statuses are decisive. Shared with the snapshot builder so the coverage
 * numbers in the picker use the engine's own definition.
 */
export function isDecisive(status: string): boolean {
  return status === "verified_true" || status === "verified_false";
}
