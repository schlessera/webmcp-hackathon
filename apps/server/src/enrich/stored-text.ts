import { createHash } from "node:crypto";
import type { EvaluatedInference } from "./evaluate.ts";
import type { StoredInference } from "./infer.ts";
import type { WebFacts } from "./website.ts";
import type { WikiFacts } from "./wikidata.ts";
import {
  cleanEvidenceText,
  cleanInlineText,
  cleanSummary,
  cleanTitle,
  truncateText,
} from "./text.ts";

export function cleanWebFacts<T extends WebFacts | null>(facts: T): T {
  if (!facts) return facts;
  const cleaned: WebFacts = {
    ...facts,
    types: (facts.types ?? []).map(cleanInlineText).filter(Boolean),
    ...(facts.pageTitle ? { pageTitle: truncateText(cleanTitle(facts.pageTitle), 160) } : {}),
    ...(facts.publisherNames?.length
      ? { publisherNames: facts.publisherNames.map((name) => cleanSummary(name, 120)).filter(Boolean).slice(0, 6) }
      : {}),
    ...(facts.cuisine?.length
      ? { cuisine: facts.cuisine.map(cleanInlineText).filter(Boolean).slice(0, 6) }
      : {}),
    ...(facts.hours?.length
      ? { hours: facts.hours.map(cleanInlineText).filter(Boolean).slice(0, 14) }
      : {}),
    ...(facts.description ? { description: cleanSummary(facts.description, 220) } : {}),
    ...(facts.menuReading
      ? {
          menuReading: {
            ...facts.menuReading,
            language: facts.menuReading.language
              ? cleanSummary(facts.menuReading.language, 12)
              : null,
            cuisine: facts.menuReading.cuisine.map(cleanInlineText).filter(Boolean).slice(0, 3),
            claims: facts.menuReading.claims.map((claim) => ({
              ...claim,
              evidence: cleanSummary(claim.evidence, 80),
            })).filter((claim) => Boolean(claim.evidence)),
          },
        }
      : {}),
  };
  return cleaned as T;
}

export function cleanWikiFacts<T extends WikiFacts | null>(facts: T): T {
  if (!facts) return facts;
  const cleaned: WikiFacts = {
    ...facts,
    ...(facts.description ? { description: cleanSummary(facts.description, 300) } : {}),
    awards: (facts.awards ?? []).map((award) => ({
      ...award,
      ...(award.label ? { label: cleanInlineText(award.label) } : {}),
    })),
    ...(facts.image
      ? {
          image: {
            ...facts.image,
            license: truncateText(cleanInlineText(facts.image.license), 80),
            ...(facts.image.credit
              ? { credit: truncateText(cleanInlineText(facts.image.credit), 180) }
              : {}),
          },
        }
      : {}),
  };
  return cleaned as T;
}

type Claim = Exclude<StoredInference, { omitted: true }>;

function cleanedClaim<T extends Claim | EvaluatedInference>(claim: T): T {
  const evidence = cleanEvidenceText(claim.evidence);
  const cleaned = {
    ...claim,
    evidence,
    ...(claim.context ? { context: cleanSummary(claim.context, 1_200) } : {}),
    ...(claim.pageTitle ? { pageTitle: truncateText(cleanTitle(claim.pageTitle), 160) } : {}),
    ...(claim.publisherNames?.length
      ? { publisherNames: claim.publisherNames.map((name) => cleanSummary(name, 120)).filter(Boolean).slice(0, 6) }
      : {}),
    ...(claim.adjudication
      ? {
          adjudication: {
            ...claim.adjudication,
            evidenceHash: createHash("sha256").update(evidence).digest("hex"),
            quote: cleanSummary(claim.adjudication.quote, 400),
          },
        }
      : {}),
  };
  if ("note" in claim && typeof claim.note === "string") {
    (cleaned as Claim & { note?: string }).note = cleanSummary(claim.note, 400);
  }
  return cleaned as T;
}

export function cleanStoredInferences(
  inferred: Record<string, StoredInference> | null | undefined,
): Record<string, StoredInference> {
  return Object.fromEntries(Object.entries(inferred ?? {}).map(([key, claim]) => [
    key,
    "omitted" in claim ? claim : cleanedClaim(claim),
  ]));
}

export function cleanEvaluatedInference<T extends EvaluatedInference>(claim: T): T {
  return cleanedClaim(claim);
}

export function cleanSearchResults<T extends { url: string; title: string; snippet: string }>(
  results: T[] | null | undefined,
): T[] {
  return (results ?? []).map((result) => ({
    ...result,
    title: truncateText(cleanTitle(result.title), 300) || result.url,
    snippet: cleanSummary(result.snippet, 2_000),
  })).filter((result) => Boolean(result.snippet));
}
