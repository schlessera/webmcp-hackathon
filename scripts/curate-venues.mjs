#!/usr/bin/env node
/**
 * Curates the raw Overpass extract (scripts/raw-overpass.json) into
 * packages/contracts/data/berlin-mitte-venues.json.
 *
 * Facts about real venues come from OSM tags only. The demo overlay
 * (scripts/demo-overlay.json) adds/overrides attributes through the honest
 * "curated" provenance channel (source: curated:demo-2026-08) so the scripted
 * demo impasse is deterministic. The script asserts the impasse math and
 * fails loudly if it doesn't hold.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_FILE = join(__dirname, "raw-overpass.json");
const OVERLAY_FILE = join(__dirname, "demo-overlay.json");
const OUT_DIR = join(__dirname, "..", "packages", "contracts", "data");
const OUT_FILE = join(OUT_DIR, "berlin-mitte-venues.json");

// Demo geometry: venues cluster densely here (Friedrichstraße / Spreeufer,
// between Friedrichstraße station and Hackescher Markt).
const DEMO_CENTER = { lat: 52.5219, lng: 13.3899 };
const RADIUS_NARROW = 800; // meters — scripted impasse: zero eligible
const RADIUS_WIDE = 1400; // meters — recovery: >=3 eligible

const OSM_SOURCE_TAG = "curated:berlin-mitte-2026-08";
const DEMO_SOURCE_TAG = "curated:demo-2026-08";

function haversine(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// The curated selection: real OSM elements, keyed "type/id". A hand-picked
// mix of categories around the demo center (plus an 800–1400m ring so the
// radius-widening beat has somewhere to go).
const SELECTED = [
  "node/2884321484", // Grill Royal
  "node/333160361", // Hans im Glück
  "node/387772992", // Italofritzen
  "node/333160358", // Peter Pane
  "node/333136723", // Bombay
  "node/1811815459", // Grimm Café
  "node/530810715", // Tex-Mex Cantina
  "node/2121102691", // Sushi Miyabi
  "node/9641470250", // Chupenga
  "node/989022916", // Pure Origins
  "way/397579531", // Haferkater
  "node/989022912", // DaVinci
  "node/622085173", // Restaurant Nolle
  "node/10134091439", // Witty's Bio-Currywurst
  "way/164039096", // Bertolt-Brecht-Platz (park)
  "node/6498044658", // Mishba
  "node/333136725", // dean&david
  "way/335561910", // AsiaGourmet
  "node/622642558", // Giotto
  "way/340138573", // Monbijoupark
  "way/23852021", // James-Simon-Park
  "node/4948138026", // Salamat
  "node/6411599293", // Coréen
  "node/3868790051", // The Barn
  "node/6708250137", // Kebap with Attitude
  "node/5299293914", // Takumi Nine 2
  "node/615147093", // Röststätte
  "node/615149024", // Hackescher Hof
  "node/667815238", // Sisaket
  "node/1278254651", // Chén Ché
  "node/3239758866", // District Một
];

const BOOLEAN_ATTRS = [
  { key: "vegetarian-options", tag: "diet:vegetarian" },
  { key: "lactose-free-options", tag: "diet:lactose_free" },
  { key: "wheelchair-accessible", tag: "wheelchair" },
  { key: "outdoor-seating", tag: "outdoor_seating" },
  { key: "dog-friendly", tag: "dog" },
];

const DAY_MAP = { Mo: "mon", Tu: "tue", We: "wed", Th: "thu", Fr: "fri", Sa: "sat", Su: "sun" };
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DEFAULT_HOURS = DAY_ORDER.map((day) => ({ day, open: "09:00", close: "22:00" }));

function clampTime(t) {
  const [h, m] = t.split(":").map(Number);
  if (h >= 24) return "23:59";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function expandDays(spec) {
  // "Mo-Fr", "Sa,Su", "Mo", "Sa-Su,PH" -> ["mon", ...]; unknown tokens skipped
  const days = [];
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

function parseOpeningHours(oh) {
  // Best-effort parse of the common subset of the OSM opening_hours syntax.
  // Returns null when nothing usable could be extracted.
  if (!oh) return null;
  if (oh.trim() === "24/7") {
    return DAY_ORDER.map((day) => ({ day, open: "00:00", close: "23:59" }));
  }
  const byDay = new Map();
  for (const rule of oh.split(";")) {
    // Split leading day spec from time spec, e.g. "Mo-Fr 08:00-18:00,19:00-22:00"
    const m = rule
      .trim()
      .match(/^([A-Za-z,\- ]*?)\s*((?:\d{1,2}:\d{2}[-+](?:\d{1,2}:\d{2})?)(?:,\d{1,2}:\d{2}[-+](?:\d{1,2}:\d{2})?)*)$/);
    if (!m) continue; // "Mo off", "Su closed", unparseable -> skip
    const days = m[1].trim() ? expandDays(m[1]) : DAY_ORDER;
    const first = m[2].split(",")[0]; // keep the first time range per rule
    const tm = first.match(/^(\d{1,2}:\d{2})[-+](\d{1,2}:\d{2})?$/);
    if (!tm || days.length === 0) continue;
    const open = clampTime(tm[1]);
    const close = tm[2] ? clampTime(tm[2]) : "23:59"; // "18:00+" -> open end
    for (const day of days) {
      if (!byDay.has(day)) byDay.set(day, { day, open, close });
    }
  }
  if (byDay.size === 0) return null;
  return DAY_ORDER.filter((d) => byDay.has(d)).map((d) => byDay.get(d));
}

function priceHeuristic(category, tags) {
  const cuisine = tags.cuisine ?? "";
  if (category === "park") return 1;
  if (category === "fast_food") return 1;
  if (category === "cafe") return 2;
  if (/steak_house/.test(cuisine)) return 4;
  if (/french|european|fine_dining/.test(cuisine)) return 3;
  return 2; // restaurant default
}

function booleanAttr(key, tag, tags, observedAt) {
  const raw = tags[tag];
  const base = { key, source: `osm:${tag}`, observedAt };
  if (raw === "yes") return { ...base, status: "verified_true", confidence: 0.8 };
  if (raw === "no") return { ...base, status: "verified_false", confidence: 0.8 };
  if (raw !== undefined) return { ...base, status: "unverified", confidence: 0.6 }; // "limited" etc.
  return { ...base, status: "unknown", confidence: 0.6 };
}

const raw = JSON.parse(await readFile(RAW_FILE, "utf8"));
const overlay = JSON.parse(await readFile(OVERLAY_FILE, "utf8"));
const observedAt = raw.osm3s?.timestamp_osm_base ?? new Date().toISOString();

const byRef = new Map(raw.elements.map((e) => [`${e.type}/${e.id}`, e]));

const picked = SELECTED.map((ref) => {
  const e = byRef.get(ref);
  if (!e) throw new Error(`Selected element ${ref} not found in raw extract`);
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  return { ref, lat, lng, tags: e.tags, distance: haversine(DEMO_CENTER, { lat, lng }) };
}).sort((a, b) => a.distance - b.distance || (a.ref < b.ref ? -1 : 1));

const venues = picked.map((p, i) => {
  const t = p.tags;
  const category = t.leisure === "park" ? "park" : t.amenity;
  const attributes = BOOLEAN_ATTRS.map(({ key, tag }) => booleanAttr(key, tag, t, observedAt));

  if (t.cuisine) {
    attributes.push({
      key: "cuisine",
      value: t.cuisine,
      status: "verified_true",
      source: "osm:cuisine",
      observedAt,
      confidence: 0.8,
    });
  } else {
    attributes.push({ key: "cuisine", status: "unknown", source: "osm:cuisine", observedAt, confidence: 0.6 });
  }

  let priceLevel = priceHeuristic(category, t);
  attributes.push({
    key: "price-level",
    value: priceLevel,
    status: "unverified",
    source: OSM_SOURCE_TAG,
    observedAt,
    confidence: 0.6,
  });

  let hours = parseOpeningHours(t.opening_hours);
  if (!hours) {
    hours = DEFAULT_HOURS;
    attributes.push({ key: "hours", status: "unverified", source: OSM_SOURCE_TAG, observedAt, confidence: 0.6 });
  }

  const venue = {
    candidateId: `place_${i + 1}`,
    name: t.name,
    location: { lat: p.lat, lng: p.lng },
    category,
    priceLevel,
    hours,
    attributes,
    mapRevision: 1,
    osmRef: p.ref,
  };

  // Demo overlay merge (curated provenance channel).
  const patch = overlay.venues[venue.candidateId];
  if (patch) {
    if (patch.expectName !== venue.name) {
      throw new Error(
        `Overlay mismatch for ${venue.candidateId}: expected "${patch.expectName}", got "${venue.name}". ` +
          `Current mapping:\n` +
          picked.map((q, j) => `  place_${j + 1} = ${q.tags.name} (${Math.round(q.distance)}m)`).join("\n")
      );
    }
    for (const a of patch.attributes ?? []) {
      const row = { ...a, source: DEMO_SOURCE_TAG, observedAt };
      const idx = venue.attributes.findIndex((x) => x.key === a.key);
      if (idx >= 0) venue.attributes[idx] = row;
      else venue.attributes.push(row);
    }
    if (patch.priceLevel !== undefined) {
      venue.priceLevel = patch.priceLevel;
      const idx = venue.attributes.findIndex((x) => x.key === "price-level");
      venue.attributes[idx] = {
        key: "price-level",
        value: patch.priceLevel,
        status: "verified_true",
        source: DEMO_SOURCE_TAG,
        observedAt,
        confidence: 0.9,
      };
    }
  }

  return venue;
});

// ---------------------------------------------------------------------------
// Demo impasse assertions. Eligibility for the scripted scenario:
//   vegetarian-options verified_true AND lactose-free-options verified_true
//   AND cuisine does not include "italian" AND priceLevel <= 2 AND in radius.
// ---------------------------------------------------------------------------
const attr = (v, key) => v.attributes.find((a) => a.key === key);
const distOf = (v) => haversine(DEMO_CENTER, v.location);
const isItalian = (v) => (attr(v, "cuisine")?.value ?? "").split(";").includes("italian");

function eligible(v, radius) {
  return (
    distOf(v) <= radius &&
    attr(v, "vegetarian-options")?.status === "verified_true" &&
    attr(v, "lactose-free-options")?.status === "verified_true" &&
    !isItalian(v) &&
    v.priceLevel <= 2
  );
}

// Fails ONLY on lactose: every other criterion passes at the narrow radius.
function failsOnlyOnLactose(v) {
  return (
    distOf(v) <= RADIUS_NARROW &&
    attr(v, "vegetarian-options")?.status === "verified_true" &&
    attr(v, "lactose-free-options")?.status !== "verified_true" &&
    !isItalian(v) &&
    v.priceLevel <= 2
  );
}

const within800 = venues.filter((v) => distOf(v) <= RADIUS_NARROW);
const eligible800 = venues.filter((v) => eligible(v, RADIUS_NARROW));
const eligible1400 = venues.filter((v) => eligible(v, RADIUS_WIDE));
const lactoseOnly = venues.filter(failsOnlyOnLactose);
const vetoTarget = venues.find((v) => v.candidateId === overlay.vetoTargetId);

function assert(cond, msg) {
  if (!cond) {
    console.error(`ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
  }
}

assert(within800.length >= 8, `need >=8 venues within ${RADIUS_NARROW}m, got ${within800.length}`);
assert(eligible800.length === 0, `need 0 eligible at ${RADIUS_NARROW}m, got ${eligible800.length}: ${eligible800.map((v) => v.candidateId).join(", ")}`);
assert(eligible1400.length >= 3, `need >=3 eligible at ${RADIUS_WIDE}m, got ${eligible1400.length}`);
assert(lactoseOnly.length >= 2, `need >=2 venues failing only on lactose at ${RADIUS_NARROW}m, got ${lactoseOnly.length}`);
assert(vetoTarget && eligible(vetoTarget, RADIUS_WIDE), `veto target ${overlay.vetoTargetId} must be eligible at ${RADIUS_WIDE}m`);
assert(eligible1400.length - 1 >= 2, `after vetoing ${overlay.vetoTargetId}, need >=2 eligible remaining`);

if (process.exitCode) {
  console.error("Impasse math does not hold — refusing to write output.");
  process.exit(1);
}

const out = {
  manifest: {
    name: "berlin-mitte-venues",
    description: "Curated venue dossiers for the demo, Berlin Mitte (Friedrichstraße / Hackescher Markt area)",
    source: "OpenStreetMap via Overpass API (see scripts/extract-venues.mjs)",
    license: "ODbL 1.0 — https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "© OpenStreetMap contributors",
    extractTimestamp: observedAt,
    demoCenter: { ...DEMO_CENTER, note: "Weidendammer Brücke / Friedrichstraße, dense venue cluster between Friedrichstraße station and Hackescher Markt" },
    demoRadii: { narrow: RADIUS_NARROW, wide: RADIUS_WIDE },
    vetoTargetId: overlay.vetoTargetId,
    demoOverlaySource: DEMO_SOURCE_TAG,
  },
  venues,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, JSON.stringify(out, null, 2) + "\n");

const fmt = (v) => `${v.candidateId} ${v.name} (${Math.round(distOf(v))}m)`;
console.log(`Wrote ${venues.length} venues to ${OUT_FILE}`);
console.log(`Venues within ${RADIUS_NARROW}m: ${within800.length}`);
console.log(`Eligible at ${RADIUS_NARROW}m: ${eligible800.length}`);
console.log(`Eligible at ${RADIUS_WIDE}m: ${eligible1400.length} — ${eligible1400.map(fmt).join("; ")}`);
console.log(`Fail only on lactose at ${RADIUS_NARROW}m: ${lactoseOnly.length} — ${lactoseOnly.map(fmt).join("; ")}`);
console.log(`Veto target: ${fmt(vetoTarget)}`);
