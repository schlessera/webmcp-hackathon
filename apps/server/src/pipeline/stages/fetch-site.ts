import type pg from "pg";
import { readRefinementSource, type LookupPass, type LookupTarget } from "../../enrich/index.ts";
import type { PipelineIntent } from "../queue.ts";

/** One criterion-independent place-source read. */
export function fetchSite(
  db: pg.Pool,
  target: LookupTarget,
  countryCode?: string,
  intent: PipelineIntent = "background",
): Promise<LookupPass> {
  return readRefinementSource(db, target, countryCode, intent);
}
