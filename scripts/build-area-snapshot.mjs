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
import {
  createReadStream,
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AREAS,
  BOOLEAN_ATTRS,
  KEPT_TAGS,
  PLACE_CLASSES,
  PLACE_CLASS_TABLE,
  POOL_PER_RING,
  dossierFromTags,
  isDecisive,
  placeClassFromTags,
} from "../packages/contracts/src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const DATA_DIR = join(REPO, "data", "osm");
const OUT_DIR = join(REPO, "packages", "contracts", "data", "areas");
const LANDMARK_CAP = 3000;

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
  const outputIndex = argv.indexOf("-o");
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  const outputPath = output ? join(DATA_DIR, output) : undefined;
  // An ignored worktree cache may link old intermediates to another checkout.
  // Never let --overwrite follow that link and mutate the other worktree.
  if (outputPath && existsSync(outputPath) && lstatSync(outputPath).isSymbolicLink()) {
    unlinkSync(outputPath);
  }
  if (hasLocalOsmium) {
    return execFileSync("osmium", argv, { cwd: DATA_DIR, encoding: "utf8" });
  }
  // Worktrees link the large extracts from the main checkout. A bind mount of
  // DATA_DIR alone leaves those absolute host symlinks dangling in Docker, so
  // mount their resolved targets read-only and rewrite only matching inputs.
  const linkedExtracts = new Map(
    readdirSync(DATA_DIR)
      .filter((name) => name.endsWith("-latest.osm.pbf"))
      .map((name) => [name, realpathSync(join(DATA_DIR, name))]),
  );
  const containerArgv = argv.map((arg) =>
    linkedExtracts.has(arg) ? `/extracts/${arg}` : arg,
  );
  // One container per call; apt is cached by Docker's layer cache only when
  // the image is built, so this installs on every call (~10 s). Acceptable
  // for a build step that runs a handful of times.
  const script = `apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq osmium-tool >/dev/null 2>&1 && osmium ${containerArgv
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ")}`;
  return execFileSync(
    "docker",
    [
      "run", "--rm", "-v", `${DATA_DIR}:/data`,
      ...[...linkedExtracts.entries()].flatMap(([name, path]) => [
        "-v", `${path}:/extracts/${name}:ro`,
      ]),
      "-w", "/data", "debian:bookworm-slim", "sh", "-c", script,
    ],
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

function landmarkKind(properties) {
  if (properties.railway === "station") return "station";
  if (properties.railway === "halt") return "halt";
  if (properties.railway === "subway_entrance") return "subway_entrance";
  if (properties.public_transport === "station") return "station";
  if (properties.public_transport === "stop_position") return "stop";
  if (["square", "neighbourhood", "suburb", "quarter"].includes(properties.place)) {
    return properties.place;
  }
  if (properties.tourism === "attraction") return "attraction";
  if (properties.leisure === "park") return "park";
  if (["university", "theatre", "marketplace"].includes(properties.amenity)) {
    return properties.amenity;
  }
  return null;
}

function normalizedName(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

// --- the pool rule, shared with the server (places.ts mirrors it) ---------

const GRID_M = 100;

function gridPoint(center, location) {
  return {
    x:
      (location.lng - center.lng) *
      111_320 *
      Math.cos((center.lat * Math.PI) / 180),
    y: (location.lat - center.lat) * 111_320,
  };
}

function spreadRing(ordered, center, limit) {
  if (ordered.length <= limit) return ordered;
  const points = new Map();
  for (const venue of ordered) {
    const point = gridPoint(center, venue.location);
    const cell = `${Math.floor(point.x / GRID_M)},${Math.floor(point.y / GRID_M)}`;
    if (!points.has(cell)) points.set(cell, { venue, ...point });
  }

  const candidates = [...points.values()];
  const selected = candidates.length > 0 ? [candidates.shift()] : [];
  while (selected.length < limit && candidates.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;
    for (let i = 0; i < candidates.length; i += 1) {
      const point = candidates[i];
      let nearest = Number.POSITIVE_INFINITY;
      for (const chosen of selected) {
        const distance = (point.x - chosen.x) ** 2 + (point.y - chosen.y) ** 2;
        if (distance < nearest) nearest = distance;
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = i;
      }
    }
    selected.push(candidates.splice(bestIndex, 1)[0]);
  }

  const refs = new Set(selected.map((point) => point.venue.ref));
  for (const venue of ordered) {
    if (selected.length >= limit) break;
    if (!refs.has(venue.ref)) {
      selected.push({ venue, ...gridPoint(center, venue.location) });
      refs.add(venue.ref);
    }
  }
  return selected.map((point) => point.venue);
}

function poolOf(venues, area) {
  const roomVenues = venues.filter((venue) => area.placeClasses.includes(venue.placeClass));
  const { narrow, wide, max } = area.radii;
  const ring = (from, to) =>
    spreadRing(
      roomVenues.filter((v) => v.distance > from && v.distance <= to),
      area.center,
      POOL_PER_RING,
    );
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
    classCounts: Object.fromEntries(
      PLACE_CLASSES.map((placeClass) => [
        placeClass,
        venues.filter((venue) => venue.placeClass === placeClass).length,
      ]),
    ),
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
  const landmarkFiltered = `${area.id}-landmarks.osm.pbf`;
  const landmarkExported = `${area.id}-landmarks.geojsonseq`;
  const t0 = Date.now();
  osmium(["extract", "-b", `${w},${s},${e},${n}`, "-s", "smart", "-o", clipped, "--overwrite", regionFile]);
  osmium([
    "tags-filter", clipped,
    ...Object.entries(PLACE_CLASS_TABLE).map(
      ([tag, classes]) => `nwr/${tag}=${classes.join(",")}`,
    ),
    "-o", filtered, "--overwrite",
  ]);
  osmium(["export", filtered, "-f", "geojsonseq", "-a", "id,type", "-o", exported, "--overwrite"]);
  osmium([
    "tags-filter", clipped,
    "nwr/railway=station,halt,subway_entrance",
    "nwr/public_transport=station,stop_position",
    "nwr/place=square,neighbourhood,suburb,quarter",
    "nwr/tourism=attraction",
    "nwr/leisure=park",
    "nwr/amenity=university,theatre,marketplace",
    "-o", landmarkFiltered, "--overwrite",
  ]);
  osmium(["export", landmarkFiltered, "-f", "geojsonseq", "-a", "id,type", "-o", landmarkExported, "--overwrite"]);
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
    const placeClass = placeClassFromTags(p);
    if (!p.name || !placeClass) continue;
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
      placeClass,
      distance: Math.round(distance),
      tags,
    });
  }
  // Deterministic source order: distance, then ref. The pool rule preserves
  // this order for ties while spreading its selections across each ring.
  venues.sort((a, b) => a.distance - b.distance || (a.ref < b.ref ? -1 : 1));

  // Landmarks are a second, domain-neutral name index over the same clipped
  // extract. Keep source order while removing nearby duplicate renderings of
  // the same named feature (for example a station node and its area).
  const landmarks = [];
  const landmarkGroups = new Map();
  const landmarkRl = createInterface({ input: createReadStream(join(DATA_DIR, landmarkExported)) });
  for await (const raw of landmarkRl) {
    const line = raw.replace(/^\x1e/, "").trim();
    if (!line) continue;
    const f = JSON.parse(line);
    const p = f.properties ?? {};
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const kind = landmarkKind(p);
    const location = pointOf(f.geometry);
    if (!name || !kind || !location) continue;
    const nameKey = normalizedName(name);
    const groupKey = `${kind}\u0000${nameKey}`;
    const group = landmarkGroups.get(groupKey) ?? [];
    if (group.some((row) => haversine(row.location, location) <= 150)) continue;
    const altNames = [...new Set(
      [p.alt_name, p.official_name, p.short_name, p.loc_name]
        .flatMap((value) => typeof value === "string" ? value.split(";") : [])
        .map((value) => value.trim())
        .filter((value) => value && normalizedName(value) !== nameKey),
    )];
    const landmark = {
      id: `${p["@type"]}/${p["@id"]}`,
      name,
      kind,
      location: { lat: +location.lat.toFixed(7), lng: +location.lng.toFixed(7) },
      ...(altNames.length ? { altNames } : {}),
      nameKey,
      distance: Math.round(haversine(area.center, location)),
    };
    landmarks.push(landmark);
    group.push(landmark);
    landmarkGroups.set(groupKey, group);
  }
  let cappedLandmarks = landmarks;
  let landmarkCapNote = "";
  if (landmarks.length > LANDMARK_CAP) {
    cappedLandmarks = [...landmarks]
      .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
      .slice(0, LANDMARK_CAP);
    landmarkCapNote = `; capped from ${landmarks.length}, keeping nearest the area centre`;
  }

  const pool = poolOf(venues, area);
  // Focus and pool are measured over the classes a room pools (the picker
  // says what a room starts with); the city figure counts every class kept.
  const focus = venues.filter(
    (v) => v.distance <= area.radii.wide && area.placeClasses.includes(v.placeClass),
  );
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
      placeClasses: area.placeClasses,
      landmarks: cappedLandmarks.length,
      coverage,
    },
    venues: venues.map(({ ref, name, location, placeClass, tags }) => ({
      ref, name, location, placeClass, tags,
    })),
    landmarks: cappedLandmarks.map(({ id, name, kind, location, altNames }) => ({
      id, name, kind, location, ...(altNames ? { altNames } : {}),
    })),
  };
  const outPath = join(OUT_DIR, `${area.id}.json`);
  await writeFile(outPath, JSON.stringify(out, null, 1) + "\n");
  const size = (await readFile(outPath)).length;
  console.log(
    `wrote ${venues.length} venues and ${cappedLandmarks.length} landmarks${landmarkCapNote} (${(size / 1024).toFixed(0)} KiB) → ${outPath}\n` +
      `  city (${coverage.city.venues}): decisive ${coverage.city.decisivePct}%, opening_hours ${coverage.city.tags.opening_hours}%\n` +
      `  focus (${coverage.focus.venues}): decisive ${coverage.focus.decisivePct}%, opening_hours ${coverage.focus.tags.opening_hours}%, ` +
      `wheelchair ${coverage.focus.tags.wheelchair}%, diet:vegetarian ${coverage.focus.tags["diet:vegetarian"]}%\n` +
      `  pool (${pool.length}): decisive ${coverage.pool.decisivePct}%, opening_hours ${coverage.pool.tags.opening_hours}%`,
  );
}
