import { installLandmarksForTests } from "../../../apps/server/src/landmarks.ts";

installLandmarksForTests("berlin-mitte", [
  {
    id: "landmark_alexanderplatz",
    name: "Alexanderplatz",
    kind: "square",
    location: { lat: 52.5, lng: 13.4 },
  },
  {
    id: "landmark_u_alexanderplatz",
    name: "U Alexanderplatz",
    kind: "station",
    location: { lat: 52.5002, lng: 13.4 },
  },
]);

await import("../../../apps/server/src/server.ts");
