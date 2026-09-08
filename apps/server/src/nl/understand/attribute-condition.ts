import type { ATTRIBUTE_VOCABULARY } from "@webmcp-hackathon/contracts";

// Known boundaries from ATTRIBUTE_DEFINITIONS. These are conservative fallbacks
// for model drafts that retain the words but incorrectly choose role attribute.
// They preserve the condition as text; they never assert a new venue fact.
const QUALIFIERS: Partial<Record<(typeof ATTRIBUTE_VOCABULARY)[number], RegExp>> = {
  "gluten-free-options": /cross[\s-]?contamin|coeliac|celiac|allerg|kreuzkontamin|zöliak/iu,
  "halal-options": /certif|zertif|alcohol|alkohol|kitchen|küche/iu,
  "lactose-free-options": /dairy|milk|milch|allerg/iu,
  "wheelchair-accessible": /staff|help|independen|unassisted|hilfe|personal|selbstständig|width|dimensions|breite/iu,
  "step-free-entrance": /staff|help|independen|unassisted|hilfe|personal|selbstständig/iu,
  "accessible-toilet": /route|distance|equipment|hoist|changing|dimensions|entfernung|ausstattung|lifter/iu,
  "dog-friendly": /inside|indoors?|cover|terrace|patio|drinnen|innen|terrasse|überdacht/iu,
  "wifi": /free|cost|fast|speed|reliab|calls?|video|zoom|kostenlos|schnell|stabil|telefon/iu,
  "quiet": /music|private|room|calls?|video|musik|privat|raum|räume/iu,
  "outdoor-seating": /cover|heat|reserv|dogs?|überdacht|beheiz|hund/iu,
  "delivery": /free|cost|fee|within|address|kostenlos|gebühr|innerhalb|adresse/iu,
};

const TIME_QUALIFIER = /\b(?:tonight|today|tomorrow|morning|afternoon|evening|night|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|heute|morgen|abends?|nachts?|wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b|\b(?:at|after|before|um|ab|nach|vor)\s+\d/iu;

export function isQualifiedAttribute(key: string, surface: string): boolean {
  return TIME_QUALIFIER.test(surface) ||
    (QUALIFIERS[key as keyof typeof QUALIFIERS]?.test(surface) ?? false);
}
