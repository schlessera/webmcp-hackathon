import { cleanInlineText } from "./text.ts";

/** A small set of outing facts, with the assessed object kept explicit. */
export interface AccessibilityFact {
  key: string;
  value: boolean | null;
  subject: "place" | "entrance" | "toilet";
  subjectId?: string;
  qualifiers: string[];
  /** Only a source's observation date, never its import/download date. */
  observedAt?: string;
}

export const ACCESSIBILITY_FACT_KEYS = [
  "dog-friendly", "assistance-dog-access", "wifi", "quiet",
  "wheelchair-accessible", "step-free-entrance", "accessible-toilet",
] as const;

/** Reviewed sources for the two prepared regions. Configuration remains an
 * explicit allowlist; this registry documents capabilities, not token grants. */
export const ACCESSIBILITY_SOURCES = [
  { id: "ZyDaF8ZrJeGL3m4Cq", name: "DogMap", keys: ["dog-friendly", "assistance-dog-access"] },
  { id: "Yra2ze6vW9ttX7Tiz", name: "Pfotenpiloten", keys: ["dog-friendly", "assistance-dog-access"] },
  { id: "Rf3E4jqTcyTQvGNcP", name: "Travelable", keys: [...ACCESSIBILITY_FACT_KEYS] },
  { id: "zFpoqetHjgGbmyHnR", name: "Ginto", keys: [...ACCESSIBILITY_FACT_KEYS] },
  { id: "ghEw4XyFpQNLMC45w", name: "Places and Facilities Survey", keys: [...ACCESSIBILITY_FACT_KEYS] },
  { id: "ZgrxE24pTiDfv7J5P", name: "Public toilets in Berlin", keys: ["nearby-toilets"] },
] as const;

// Publisher names are not lineage: independent Wheelmap surveys are useful.
export const DUPLICATE_OSM_SOURCES = new Set(["LiBTS67TjmBcXdEmX", "3H7vWGaLzWqRKqtMS"]);
// The reviewed SF parking feed dates to 2011; Berlin parking attribution is
// inconsistent. Neither should silently become fresh on its next download.
export const HELD_ACCESSIBILITY_SOURCES = new Set([
  "dvxYrDLdMv3tdiHck", "XWATLf3NA778iPJTp", "bWaRzazK7tEq2hcGA", "nhwd59iv6nMPcHkuW",
]);

const objects = (value: unknown): Record<string, any>[] =>
  (Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [])
    .slice(0, 12).filter((v) => v && typeof v === "object").map((v) => v.properties ?? v);

export function accessibilityFacts(properties: Record<string, any>): AccessibilityFact[] {
  const a = properties.accessibility;
  if (!a || typeof a !== "object") return [];
  const out: AccessibilityFact[] = [];
  const reported = properties.observedAt ?? a.observedAt;
  const observedAt = typeof reported === "string" && Number.isFinite(Date.parse(reported)) &&
    Date.parse(reported) <= Date.now() ? new Date(reported).toISOString() : undefined;
  const add = (key: string, value: unknown, qualifiers: string[] = [],
    subject: AccessibilityFact["subject"] = "place", subjectId?: string) => {
    if (typeof value !== "boolean" && value !== null) return;
    out.push({ key, value, subject, ...(subjectId ? { subjectId } : {}), qualifiers,
      ...(observedAt ? { observedAt } : {}) });
  };
  // Preserve both observations if a mixed-schema record contradicts itself.
  add("dog-friendly", a.animalPolicy?.allowsDogs);
  add("dog-friendly", a.allowsDogs);
  add("assistance-dog-access", a.animalPolicy?.allowsAssistanceDogs, ["assistance dogs"]);
  add("assistance-dog-access", a.allowsAssistanceDogs, ["assistance dogs"]);
  add("assistance-dog-access", a.allowsGuideDogs, ["guide dogs only"]);
  add("quiet", a.isQuiet, ["subjective report; time-specific quietness unconfirmed"]);
  if (a.hasFreeWifi === true || a.wifi?.isOpenToEveryone === true) {
    add("wifi", true, [
      ...(a.hasFreeWifi === true ? ["free"] : []),
      ...(a.wifi?.isOpenToEveryone === true ? ["public"] : []),
      ...(a.wifi?.isOpenToEveryone === false ? ["restricted access"] : []),
    ]);
  } else if (a.hasFreeWifi === false || a.wifi?.isOpenToEveryone === false) {
    add("wifi", null, [
      ...(a.hasFreeWifi === false ? ["free Wi-Fi not reported; availability unknown"] : []),
      ...(a.wifi?.isOpenToEveryone === false ? ["not public; availability unknown"] : []),
    ]);
  }
  if (a.partiallyAccessibleWith?.wheelchair === true) {
    add("wheelchair-accessible", null, ["partial access; full access unconfirmed"]);
  } else add("wheelchair-accessible", a.accessibleWith?.wheelchair);

  objects(a.entrances).forEach((entrance, i) => {
    const qualifiers = [
      ...(entrance.isLevel === true ? ["level entrance"] : []),
      ...(entrance.hasFixedRamp === true ? ["fixed ramp"] : []),
      ...(entrance.hasRemovableRamp === true || entrance.hasMobileRamp === true ? ["removable ramp; assistance may be needed"] : []),
      ...(entrance.door?.needsDoorbell === true ? ["doorbell required"] : []),
    ];
    const stepFree = entrance.isLevel === true || entrance.hasFixedRamp === true;
    if (stepFree || qualifiers.length || entrance.isLevel === false) {
      // A stepped entrance says nothing about other entrances.
      add("step-free-entrance", stepFree ? true : null,
        [...qualifiers, ...(!stepFree ? ["independent step-free entry unconfirmed"] : [])], "entrance", `entrance:${i}`);
    }
  });
  objects(a.restrooms).forEach((toilet, i) => {
    add("accessible-toilet", toilet.isAccessibleWithWheelchair,
      ["attached restroom; other restrooms unassessed"], "toilet", `toilet:${i}`);
    if (typeof toilet.washBasin?.isLocatedInsideRestroom === "boolean") {
      add("toilet-washbasin-inside", toilet.washBasin.isLocatedInsideRestroom, [], "toilet", `toilet:${i}`);
    }
  });
  return [...new Map(out.map((fact) => [JSON.stringify(fact), fact])).values()];
}

export function factNote(fact: AccessibilityFact): string {
  return cleanInlineText(`${fact.subject}${fact.subjectId ? ` ${fact.subjectId}` : ""}: ${fact.key} = ${fact.value ?? "unknown"}. ${fact.qualifiers.join("; ")}. Observation date: ${fact.observedAt ?? "unknown"}.`);
}
