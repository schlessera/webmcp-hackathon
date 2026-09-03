import { labelForRequirement } from "../../facets.ts";

/**
 * The label the room will show for a payload the understanding layer is about
 * to propose. Composed by the server, from the same function the brief uses,
 * so a pending row and its settled row read identically.
 */
export function labelFor(
  payload: Record<string, unknown>,
  referentLabel?: string | null,
): string {
  return labelForRequirement({
    id: "preview",
    owner_id: "preview",
    visibility: "shared",
    hardness: "hard",
    payload: payload as never,
    withdrawn: false,
    // The row is synthetic, so a resolved referent name travels on it exactly
    // as eligibility would set it (facets.ts scopeReferentLabel).
    ...(referentLabel ? { referent_label: referentLabel } : {}),
  }, true, referentLabel ? { timezone: "UTC", now: new Date(0), referentLabel } : undefined);
}
