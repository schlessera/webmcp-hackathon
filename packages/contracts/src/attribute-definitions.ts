import type { ATTRIBUTE_VOCABULARY } from "./manifest.ts";

/** Interpretation boundaries, not claims that any particular venue meets them. */
export const ATTRIBUTE_DEFINITIONS: Record<(typeof ATTRIBUTE_VOCABULARY)[number], { meaning: string; limits: string }> = {
  "vegetarian-options": { meaning: "Vegetarian food options are offered.", limits: "Does not mean an entirely vegetarian venue or vegan food." },
  "vegan-options": { meaning: "Vegan food options are offered.", limits: "Does not mean an entirely vegan venue or establish preparation practices." },
  "gluten-free-options": { meaning: "Gluten-free food options are offered.", limits: "Does not establish absence of cross-contamination or suitability for a specific allergy or coeliac requirement." },
  "halal-options": { meaning: "Halal food options are offered.", limits: "Does not establish certification, a wholly halal kitchen, or absence of alcohol." },
  "lactose-free-options": { meaning: "Lactose-free food options are offered.", limits: "Does not mean dairy-free, vegan, or suitable for a milk allergy." },
  "wheelchair-accessible": { meaning: "The venue records general wheelchair access.", limits: "An entrance without steps alone is insufficient. Does not establish an accessible toilet, dimensions, independent access, or every room's accessibility." },
  "outdoor-seating": { meaning: "Outdoor seating is available.", limits: "Does not establish cover, heating, reservation availability, opening times, or permission for dogs." },
  "dog-friendly": { meaning: "Pet dogs are welcome at the venue.", limits: "Does not establish indoor access, access to every area, or assistance-dog policy." },
  "wifi": { meaning: "Wi-Fi is available.", limits: "Does not establish price, speed, reliability, power sockets, or suitability for calls." },
  "quiet": { meaning: "The venue is generally described as quiet.", limits: "Does not establish quiet at a particular time, no music, a private room, or suitability for a specific activity." },
  "step-free-entrance": { meaning: "An entrance can be used without taking stairs or steps.", limits: "Does not establish full wheelchair accessibility, independent access without staff help, or an accessible toilet." },
  "accessible-toilet": { meaning: "An accessible toilet is recorded at the venue.", limits: "Does not establish particular dimensions, equipment, hours, or an accessible route. Nearby public toilets are separate evidence." },
  "assistance-dog-access": { meaning: "Assistance dogs are permitted.", limits: "Does not establish permission for pet dogs; do not infer it from pet policy." },
  "takeaway": { meaning: "Food or drink can be taken away.", limits: "Does not establish delivery, packaging, or availability of a particular item." },
  "delivery": { meaning: "Delivery is offered.", limits: "Does not establish a delivery area, fee, time, or availability of a particular item." },
  "price-level": { meaning: "A coarse provider price band.", limits: "A user budget is a money concept, not a boolean attribute. A band is not an exact quote." },
  "cuisine": { meaning: "Recorded cuisine categories.", limits: "Use kind concepts. A cuisine does not establish a specific dish, dietary option, or current menu." },
};
