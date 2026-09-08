import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { areaById, type AreaDefinition } from "@webmcp-hackathon/contracts";
import type pg from "pg";
import { overtureRecord } from "../enrich/discovery.ts";
import { listingDistanceMeters } from "../enrich/listings.ts";

export async function importOverture(
  db: pg.Pool,
  file: string,
  area: AreaDefinition,
  release: string,
  expectedHash: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release))
    throw new Error("An explicit Overture release (YYYY-MM-DD.N) is required");
  if (!/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error("A SHA-256 digest is required");
  const info = await stat(file);
  if (info.size > 128 * 1024 * 1024)
    throw new Error("Extract exceeds 128 MiB; use a regional extract");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== expectedHash)
    throw new Error("Extract SHA-256 mismatch");
  const client = await db.connect();
  let rows = 0,
    skipped = 0;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,819))",
      [area.id],
    );
    await client.query(
      "CREATE TEMP TABLE overture_import (LIKE overture_places INCLUDING DEFAULTS) ON COMMIT DROP",
    );
    const lines = createInterface({
      input: createReadStream(file),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > 1_000_000 || rows + skipped >= 100_000)
        throw new Error("Extract record limit exceeded");
      const record = overtureRecord(
        JSON.parse(line.replace(/^\x1e/, "")),
        release,
      );
      if (
        !record ||
        listingDistanceMeters(area.center, record.location) >
          area.radii.max + 100
      ) {
        skipped++;
        continue;
      }
      await client.query(
        `INSERT INTO overture_import(region,id,release,name,lat,lng,facts) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          area.id,
          record.id,
          release,
          record.name,
          record.location.lat,
          record.location.lng,
          JSON.stringify(record),
        ],
      );
      rows++;
    }
    if (!rows)
      throw new Error(
        "Extract contains no usable places in this region; previous import retained",
      );
    await client.query("DELETE FROM overture_places WHERE region=$1", [
      area.id,
    ]);
    await client.query(
      "INSERT INTO overture_places SELECT * FROM overture_import",
    );
    await client.query("COMMIT");
    return {
      region: area.id,
      release,
      sha256: expectedHash,
      imported: rows,
      skipped,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function main() {
  const { values } = parseArgs({
    options: {
      area: { type: "string" },
      release: { type: "string" },
      file: { type: "string" },
      sha256: { type: "string" },
      download: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Overture: --area ID --release YYYY-MM-DD.N --file extract.geojsonseq (--download | --sha256 HASH)\n--download uses the official overturemaps CLI, with a bounded region and pinned release.",
    );
    return;
  }
  const area = areaById(values.area ?? "");
  if (!area || !values.release || !values.file)
    throw new Error("--area, --release and --file are required");
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(values.release))
    throw new Error("Invalid release");
  let digest = values.sha256;
  if (values.download) {
    const dy = (area.radii.max + 100) / 111_320,
      dx = dy / Math.cos((area.center.lat * Math.PI) / 180);
    const bbox = [
      area.center.lng - dx,
      area.center.lat - dy,
      area.center.lng + dx,
      area.center.lat + dy,
    ].join(",");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "overturemaps",
        [
          "download",
          `--bbox=${bbox}`,
          "--type",
          "place",
          "--release",
          values.release!,
          "-f",
          "geojsonseq",
          "--output",
          values.file!,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      child.on("error", () =>
        reject(
          new Error(
            "Install the official overturemaps Python CLI to use --download",
          ),
        ),
      );
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Overture download failed")),
      );
    });
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(values.file)) hash.update(chunk);
    digest = hash.digest("hex");
    await writeFile(
      `${values.file}.manifest.json`,
      JSON.stringify(
        { area: area.id, release: values.release, sha256: digest, bbox },
        null,
        2,
      ) + "\n",
    );
  }
  const { pool } = await import("../db.ts");
  try {
    console.log(
      JSON.stringify(
        await importOverture(
          pool,
          values.file,
          area,
          values.release,
          digest ?? "",
        ),
      ),
    );
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
