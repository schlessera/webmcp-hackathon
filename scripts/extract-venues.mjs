#!/usr/bin/env node
/**
 * One-time OpenStreetMap Overpass extract of named venues in Berlin Mitte.
 * Writes the raw Overpass response to scripts/raw-overpass.json.
 *
 * Polite usage: a single request with a descriptive User-Agent.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, "raw-overpass.json");

const BBOX = "52.515,13.37,52.53,13.41"; // south,west,north,east — Berlin Mitte

const query = `
[out:json][timeout:60];
(
  node["amenity"~"^(cafe|restaurant|fast_food)$"]["name"](${BBOX});
  way["amenity"~"^(cafe|restaurant|fast_food)$"]["name"](${BBOX});
  node["leisure"="park"]["name"](${BBOX});
  way["leisure"="park"]["name"](${BBOX});
);
out tags center;
`;

// One request per endpoint, with a pause between attempts if the server is busy.
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function attempt(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "webmcp-hackathon-venue-extract/1.0 (one-time demo dataset extract)",
    },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) {
    throw new Error(`${url}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

let data;
for (let i = 0; i < ENDPOINTS.length; i++) {
  try {
    data = await attempt(ENDPOINTS[i]);
    break;
  } catch (err) {
    console.error(`Attempt failed: ${err.message}`);
    if (i === ENDPOINTS.length - 1) process.exit(1);
    console.error("Waiting 30s before trying the next endpoint...");
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
await writeFile(OUT_FILE, JSON.stringify(data, null, 2));
console.log(
  `Saved ${data.elements?.length ?? 0} elements to ${OUT_FILE} (osm3s timestamp: ${data.osm3s?.timestamp_osm_base ?? "n/a"})`
);
