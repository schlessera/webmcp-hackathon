import { PROTOCOL_VERSIONS } from "./versions.ts";

/** Capability manifest — INTERACTION-AND-BINDING.md §2.2, verbatim shapes. */

export const ALLOWED_VISIBILITIES = [
  "shared",
  "application-private",
  "agent-private",
] as const;
export type Visibility = (typeof ALLOWED_VISIBILITIES)[number];

export const DISCLOSURE_LEVELS = [
  "verdicts-only",
  "category-hint",
  "predicate",
  "shared",
] as const;

export const HINT_TAXONOMY = [
  "dietary",
  "accessibility",
  "budget",
  "distance",
  "time",
  "personal-history",
  "atmosphere",
  "other",
] as const;

export const ATTRIBUTE_VOCABULARY = [
  "vegetarian-options",
  "vegan-options",
  "gluten-free-options",
  "halal-options",
  "lactose-free-options",
  "wheelchair-accessible",
  "outdoor-seating",
  "dog-friendly",
  "takeaway",
  "delivery",
  "price-level",
  "cuisine",
] as const;

/**
 * Key -> human label. The client renders facet and need labels VERBATIM and
 * never humanizes a key itself (CLAUDE.md invariant 1: no domain word may be
 * authored in the chrome). Labels are lowercase and domain-natural; the key
 * stays the machine-readable identity that round-trips into a requirement
 * payload. Published in the capability manifest so agents phrase needs the
 * same way the UI does.
 */
export const ATTRIBUTE_LABELS: Record<(typeof ATTRIBUTE_VOCABULARY)[number], string> = {
  "vegetarian-options": "vegetarian options",
  "vegan-options": "vegan options",
  "gluten-free-options": "gluten-free options",
  "halal-options": "halal options",
  "lactose-free-options": "lactose-free options",
  "wheelchair-accessible": "step-free access",
  "outdoor-seating": "outdoor seating",
  "dog-friendly": "dogs welcome",
  takeaway: "takeaway",
  delivery: "delivery",
  "price-level": "price",
  cuisine: "cuisine",
};

export const CAPABILITIES = [
  "destination-search",
  "map-selection",
  "meeting-points",
  "navigation-handoff",
  "private-screening",
  "impasse-resolution",
] as const;

export const AGREEMENT_RULE = "all-accept-organizer-commit" as const;

/**
 * Provider-normalized price level → estimated per-person EUR band (upper
 * bound). Part of the eligibility semantics: budget requirements compare
 * their perPersonMax against this band, so it is published in the manifest
 * for agents to reason with.
 */
export const PRICE_LEVEL_EUR = { 1: 10, 2: 15, 3: 25, 4: 40 } as const;

/**
 * Protected-category attribute keys (NEGOTIATION-PROTOCOL.md §3.3): a
 * requirement on one of these is forced to hard + locked server-side,
 * whatever the client sent — the council prefers scope changes over asking
 * anyone to compromise a protected need.
 */
export const PROTECTED_ATTRIBUTE_KEYS = ["wheelchair-accessible"] as const;

export const CONDUCT =
  "You act for exactly one participant. Submit only what your user authorizes. " +
  "Private info can stay private: use visibility levels and screening verdicts " +
  "instead of disclosing. Mutations need baseRevision from your last sync.";

export interface CapabilityManifest {
  protocols: { negotiation: string; domain: string };
  capabilities: readonly string[];
  privacy: {
    allowedVisibilities: readonly string[];
    disclosureLevels: readonly string[];
    hintTaxonomy: readonly string[];
  };
  agreement: { rule: string };
  attributeVocabulary: readonly string[];
  attributeLabels: Record<string, string>;
  priceLevelEur: Record<string, number>;
  conduct: string;
}

export const CAPABILITY_MANIFEST: CapabilityManifest = {
  protocols: { ...PROTOCOL_VERSIONS },
  capabilities: CAPABILITIES,
  privacy: {
    allowedVisibilities: ALLOWED_VISIBILITIES,
    disclosureLevels: DISCLOSURE_LEVELS,
    hintTaxonomy: HINT_TAXONOMY,
  },
  agreement: { rule: AGREEMENT_RULE },
  attributeVocabulary: ATTRIBUTE_VOCABULARY,
  attributeLabels: ATTRIBUTE_LABELS,
  priceLevelEur: PRICE_LEVEL_EUR,
  conduct: CONDUCT,
};
