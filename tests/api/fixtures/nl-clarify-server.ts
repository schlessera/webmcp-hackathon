import { setTransport } from "../../../apps/server/src/nl/openai.ts";
import { setFindLandmarks } from "../../../apps/server/src/nl/understand/resolvers.ts";

setTransport(async () => {
  throw new Error("model transport is disabled in nl-clarify tests");
});

setFindLandmarks((_areaId, query) => {
  const normalized = query.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ß/g, "ss");
  if (normalized.includes("friedrichstrasse")) {
    return [{
      id: "landmark_friedrichstrasse",
      name: "Bahnhof Friedrichstraße",
      kind: "station",
      kindLabel: "station",
      location: { lat: 52.5203, lng: 13.3871 },
      score: 1,
    }];
  }
  if (normalized.includes("alexanderplatz")) {
    return [{
      id: "landmark_alexanderplatz",
      name: "Alexanderplatz",
      kind: "square",
      kindLabel: "square",
      location: { lat: 52.5219, lng: 13.4132 },
      score: 1,
    }];
  }
  return [];
});

await import("../../../apps/server/src/server.ts");
