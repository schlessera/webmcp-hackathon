import { installLandmarksForTests } from "../../../apps/server/src/landmarks.ts";
import { setTransport } from "../../../apps/server/src/nl/openai.ts";

setTransport(async () => {
  throw new Error("model transport is disabled in nl-clarify tests");
});

// Fixture rows go into the real landmark index, so the clarify path resolves a
// name exactly the way production does. The test room carries no area, so the
// index key is the empty string the room resolves to.
installLandmarksForTests("", [
  {
    id: "landmark_alexanderplatz",
    name: "Alexanderplatz",
    kind: "square",
    location: { lat: 52.5219, lng: 13.4132 },
  },
  {
    id: "landmark_friedrichstrasse",
    name: "Bahnhof Friedrichstraße",
    kind: "station",
    location: { lat: 52.5203, lng: 13.3871 },
  },
]);

await import("../../../apps/server/src/server.ts");
