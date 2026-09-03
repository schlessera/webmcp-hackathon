import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLURHASH_COMPONENTS,
  blurhashForImage,
  refreshPlaceImages,
} from "../../apps/server/src/enrich/images.ts";
import { backfillPlaceImageBlurhashes } from "../../apps/server/src/enrich/backfill-blurhash.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = readFileSync(join(fixtures, "blurhash.svg"));
const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const sharp = serverRequire("sharp");
const { decode } = serverRequire("blurhash") as {
  decode: (hash: string, width: number, height: number) => Uint8ClampedArray;
};
const base83 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

afterEach(() => vi.restoreAllMocks());

describe("place image blurhash", () => {
  it("encodes the fixture at the stable 4 by 3 component layout", async () => {
    const hash = await blurhashForImage(fixture);
    const sizeFlag = base83.indexOf(hash[0]);
    expect({
      x: (sizeFlag % 9) + 1,
      y: Math.floor(sizeFlag / 9) + 1,
    }).toEqual(BLURHASH_COMPONENTS);
    expect(hash).toBe("LGF=X50Dx@x]G^IaM|-nyCRnaLt5");
    expect(decode(hash, 32, 21)).toHaveLength(32 * 21 * 4);
  });

  it("stores a usable image with a null hash when encoding fails", async () => {
    const png = await sharp(fixture).resize(640, 480).png().toBuffer();
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
    const db = { connect: async () => client, query: client.query };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(refreshPlaceImages(
      db as never,
      "node/hash-failure",
      "Hash Failure",
      [{
        url: "https://93.184.216.34/photo.png",
        source: "wikidata:Q1",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Photo.png",
      }],
      async (url) => url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(png, { headers: { "content-type": "image/png" } }),
      {},
      async () => { throw new Error("encoder unavailable"); },
    )).resolves.toBe(1);

    const insert = statements.find(({ sql }) => sql.includes("INSERT INTO place_images"));
    expect(insert?.params?.[11]).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("place image blurhash failed"));
  });

  it("backfills null rows once and performs no writes on a second run", async () => {
    const webp = await sharp(fixture).webp().toBuffer();
    const stored = [
      { osm_ref: "node/1", idx: 0, bytes: webp, blurhash: null as string | null },
      { osm_ref: "node/2", idx: 0, bytes: webp, blurhash: null as string | null },
    ];
    let writes = 0;
    const db = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes("SELECT osm_ref, idx, bytes")) {
          const [afterRef, afterIdx, limit] = params as [string, number, number];
          const rows = stored
            .filter((row) => row.blurhash === null)
            .filter((row) => row.osm_ref > afterRef || (row.osm_ref === afterRef && row.idx > afterIdx))
            .slice(0, limit)
            .map(({ blurhash: _blurhash, ...row }) => row);
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("UPDATE place_images AS stored")) {
          writes += 1;
          const [refs, indexes, hashes] = params as [string[], number[], string[]];
          let rowCount = 0;
          refs.forEach((ref, index) => {
            const row = stored.find((candidate) =>
              candidate.osm_ref === ref && candidate.idx === indexes[index] && candidate.blurhash === null
            );
            if (row) {
              row.blurhash = hashes[index];
              rowCount += 1;
            }
          });
          return { rows: [], rowCount };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };

    await expect(backfillPlaceImageBlurhashes(db as never, {
      maxRows: 10,
      batchSize: 1,
    })).resolves.toMatchObject({ scanned: 2, generated: 2, updated: 2, failed: 0 });
    expect(writes).toBe(2);

    await expect(backfillPlaceImageBlurhashes(db as never, {
      maxRows: 10,
      batchSize: 1,
    })).resolves.toMatchObject({ scanned: 0, generated: 0, updated: 0, failed: 0 });
    expect(writes).toBe(2);
  });
});
