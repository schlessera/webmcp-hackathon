#!/usr/bin/env node
/**
 * Builds one area snapshot per registry entry from a Geofabrik extract:
 *
 *   Geofabrik <region>-latest.osm.pbf   (downloaded once into data/osm/, gitignored)
 *     └─ osmium extract   → data/osm/<area>.osm.pbf         (clipped to the area bbox)
 *         └─ osmium tags-filter + export → named venues as GeoJSON
 *             └─ packages/contracts/data/areas/<area>.json   (committed, ODbL)
 *
 * The snapshot is the server's venue source (apps/server/src/places.ts). It
 * carries the extract timestamp so every attribute says when it was true,
 * and the coverage numbers the area picker shows — measured here, from the
 * data, with the engine's own definition of "decisive" (dossier.ts).
 *
 * Runs `osmium` from PATH, or through Docker when it is not installed. No
 * public query API is contacted at any point (docs/DATA-QUALITY.md).
 *
 *   node scripts/build-area-snapshot.mjs            # every area
 *   node scripts/build-area-snapshot.mjs sf-soma    # one area
 *   node scripts/build-area-snapshot.mjs --refresh  # re-download extracts first
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AREAS,
  BOOLEAN_ATTRS,
  KEPT_TAGS,
  POOL_PER_RING,
  dossierFromTags,
  isDecisive,
} from "../packages/contracts/src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const DATA_DIR = join(REPO, "data", "osm");
const OUT_DIR = join(REPO, "packages", "contracts", "data", "areas");

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const wanted = args.filter((a) => !a.startsWith("--"));
const areas = wanted.length ? AREAS.filter((a) => wanted.includes(a.id)) : AREAS;
if (areas.length === 0) {
  console.error(`unknown area(s): ${wanted.join(", ")}; known: ${AREAS.map((a) => a.id).join(", ")}`);
  process.exit(1);
}
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// --- osmium: local binary, else a throwaway Debian container -------------

const hasLocalOsmium = spawnSync("osmium", ["--version"], { stdio: "ignore" }).status === 0;

function osmium(argv) {
  if (hasLocalOsmium) {
    return execFileSync("osmium", argv, { cwd: DATA_DIR, encoding: "utf8" });
  }
  // One container per call; apt is cached by Docker's layer cache only when
  // the image is built, so this installs on every call (~10 s). Acceptable
  // for a build step that runs a handful of times.
  const script = `apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq osmium-tool >/dev/null 2>&1 && osmium ${argv
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ")}`;
  return execFileSync(
    "docker",
    ["run", "--rm", "-v", `${DATA_DIR}:/data`, "-w", "/data", "debian:bookworm-slim", "sh", "-c", script],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

function download(url, file) {
  console.log(`downloading ${url}`);
  execFileSync("curl", ["-sSL", "--fail", "-o", file, url], { stdio: "inherit" });
}

// --- geometry -------------------------------------------------------------

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** A representative point: the point itself, or the vertex mean of the
 * outer ring — good enough for a building footprint. */
function pointOf(geometry) {
  const avg = (coords) => {
    let lng = 0, lat = 0;
    for (const [x, y] of coords) { lng += x; lat += y; }
    return { lat: lat / coords.length, lng: lng / coords.length };
  };
  switch (geometry.type) {
    case "Point": return { lat: geometry.coordinates[1], lng: geometry.coordinates[0] };
    case "LineString": return avg(geometry.coordinates);
    case "Polygon": return avg(geometry.coordinates[0]);
    case "MultiPolygon": return avg(geometry.coordinates[0][0]);
    default: return null;
  }
}

// --- the pool rule, shared with the server (places.ts mirrors it) ---------

function poolOf(venues, area) {
  const { narrow, wide, max } = area.radii;
  const ring = (from, to) =>
    venues.filter((v) => v.distance > from && v.distance <= to).slice(0, POOL_PER_RING);
  return [...ring(-1, narrow), ...ring(narrow, wide), ...ring(wide, max)];
}

function coverageOf(venues, observedAt) {
  const n = venues.length;
  const pct = (k) => (n === 0 ? 0 : Math.round((k / n) * 1000) / 10);
  const tagPresent = (tag) => venues.filter((v) => v.tags[tag] !== undefined).length;
  let decisive = 0;
  for (const v of venues) {
    const d = dossierFromTags(v.tags, observedAt);
    for (const { key } of BOOLEAN_ATTRS) {
      const a = d.attributes.find((x) => x.key === key);
      if (a && isDecisive(a.status)) decisive += 1;
    }
  }
  const slots = n * BOOLEAN_ATTRS.length;
  const tags = [
    "opening_hours", "wheelchair", "outdoor_seating", "diet:vegetarian",
    "diet:vegan", "diet:lactose_free", "dog", "cuisine", "internet_access", "website",
  ];
  return {
    venues: n,
    /** Boolean attribute slots (venues × facts) and how many the engine can
     * rule on. Absolute counts first: the UI never shows a percentage. */
    slots,
    decisive,
    decisivePct: slots === 0 ? 0 : Math.round((decisive / slots) * 1000) / 10,
    /** Places carrying each tag, as counts and as a share. */
    tagCounts: Object.fromEntries(tags.map((tag) => [tag, tagPresent(tag)])),
    tags: Object.fromEntries(tags.map((tag) => [tag, pct(tagPresent(tag))])),
  };
}

// --- per area -------------------------------------------------------------

for (const area of areas) {
  console.log(`\n== ${area.id} (${area.label})`);
  const regionFile = `${area.extract.region.split("/").pop()}-latest.osm.pbf`;
  const regionPath = join(DATA_DIR, regionFile);
  if (refresh || !existsSync(regionPath)) download(area.extract.url, regionPath);
  console.log(`extract: ${regionFile} (${(statSync(regionPath).size / 1048576).toFixed(1)} MiB)`);

  const [s, w, n, e] = area.bbox;
  const clipped = `${area.id}.osm.pbf`;
  const filtered = `${area.id}-venues.osm.pbf`;
  const exported = `${area.id}-venues.geojsonseq`;
  const t0 = Date.now();
  osmium(["extract", "-b", `${w},${s},${e},${n}`, "-s", "smart", "-o", clipped, "--overwrite", regionFile]);
  osmium(["tags-filter", clipped, `nwr/amenity=${area.amenities.join(",")}`, "-o", filtered, "--overwrite"]);
  osmium(["export", filtered, "-f", "geojsonseq", "-a", "id,type", "-o", exported, "--overwrite"]);
  const extractTimestamp = osmium([
    "fileinfo", "-e", "-g", "header.option.osmosis_replication_timestamp", regionFile,
  ]).trim();
  console.log(`osmium: ${((Date.now() - t0) / 1000).toFixed(1)} s; extract timestamp ${extractTimestamp}`);

  // Parse the GeoJSON sequence: one feature per line, RS-prefixed.
  const seen = new Set();
  const venues = [];
  const rl = createInterface({ input: createReadStream(join(DATA_DIR, exported)) });
  for await (const raw of rl) {
    const line = raw.replace(/^\x1e/, "").trim();
    if (!line) continue;
    const f = JSON.parse(line);
    const p = f.properties ?? {};
    if (!p.name || !area.amenities.includes(p.amenity)) continue;
    const ref = `${p["@type"]}/${p["@id"]}`;
    if (seen.has(ref)) continue;
    const location = pointOf(f.geometry);
    if (!location) continue;
    // Everything in the city bbox is kept: the default centre is where the
    // experience focuses, and the rest is buffer around it.
    const distance = haversine(area.center, location);
    seen.add(ref);
    const tags = {};
    for (const k of KEPT_TAGS) if (p[k] !== undefined) tags[k] = String(p[k]);
    venues.push({
      ref,
      name: String(p.name),
      location: { lat: +location.lat.toFixed(7), lng: +location.lng.toFixed(7) },
      distance: Math.round(distance),
      tags,
    });
  }
  // Deterministic order: distance, then ref. The pool is a prefix of this.
  venues.sort((a, b) => a.distance - b.distance || (a.ref < b.ref ? -1 : 1));

  const pool = poolOf(venues, area);
  const focus = venues.filter((v) => v.distance <= area.radii.wide);
  const coverage = {
    measuredAt: extractTimestamp,
    /** The whole city bbox. */
    city: coverageOf(venues, extractTimestamp),
    /** The disc a room starts in: within the wide radius of the default centre. */
    focus: coverageOf(focus, extractTimestamp),
    /** What a room actually starts with (POOL_PER_RING per ring). */
    pool: coverageOf(pool, extractTimestamp),
    poolRule: { perRing: POOL_PER_RING, radii: area.radii },
  };

  const out = {
    manifest: {
      areaId: area.id,
      label: area.label,
      source: "OpenStreetMap",
      license: "ODbL 1.0 — https://opendatacommons.org/licenses/odbl/1-0/",
      attribution: "© OpenStreetMap contributors",
      extract: { ...area.extract, timestamp: extractTimestamp, bbox: area.bbox },
      builtAt: new Date().toISOString(),
      builtWith: "scripts/build-area-snapshot.mjs",
      center: area.center,
      radii: area.radii,
      amenities: area.amenities,
      coverage,
    },
    venues: venues.map(({ ref, name, location, tags }) => ({ ref, name, location, tags })),
  };
  const outPath = join(OUT_DIR, `${area.id}.json`);
  await writeFile(outPath, JSON.stringify(out, null, 1) + "\n");
  const size = (await readFile(outPath)).length;
  console.log(
    `wrote ${venues.length} venues (${(size / 1024).toFixed(0)} KiB) → ${outPath}\n` +
      `  city (${coverage.city.venues}): decisive ${coverage.city.decisivePct}%, opening_hours ${coverage.city.tags.opening_hours}%\n` +
      `  focus (${coverage.focus.venues}): decisive ${coverage.focus.decisivePct}%, opening_hours ${coverage.focus.tags.opening_hours}%, ` +
      `wheelchair ${coverage.focus.tags.wheelchair}%, diet:vegetarian ${coverage.focus.tags["diet:vegetarian"]}%\n` +
      `  pool (${pool.length}): decisive ${coverage.pool.decisivePct}%, opening_hours ${coverage.pool.tags.opening_hours}%`,
  );
}
