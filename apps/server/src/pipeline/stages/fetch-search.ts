import type { SearchResult } from "../../refine/search.ts";
import {
  searchRefinementPlaces,
  type RefinementAreaContext,
  type RefinementSearchPolicy,
  type RefinementSearchRequest,
  type RefinementSearchResponse,
} from "../../refine/worker.ts";

/** One search request; concurrency belongs to the search pool. */
export async function fetchSearch(
  request: RefinementSearchRequest,
  area: RefinementAreaContext,
  provider: (query: string, options?: { domains?: string[] }) => Promise<SearchResult[]>,
  policy: RefinementSearchPolicy = {},
): Promise<RefinementSearchResponse> {
  const [result] = await searchRefinementPlaces([request], area, provider, policy);
  return result;
}
