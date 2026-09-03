import { afterEach, describe, expect, it } from "vitest";
import {
  findLandmarks,
  installLandmarksForTests,
  normalizeLandmarkName,
  resetLandmarks,
} from "../../apps/server/src/landmarks.ts";

const area = "berlin-mitte";
const fixtures = [
  { id: "lm_square", name: "Alexanderplatz", kind: "square", location: { lat: 52.5219, lng: 13.3899 } },
  { id: "lm_u", name: "U Alexanderplatz", kind: "station", location: { lat: 52.522, lng: 13.39 } },
  { id: "lm_s", name: "S-Bahnhof Alexanderplatz", kind: "station", location: { lat: 52.523, lng: 13.39 } },
  { id: "lm_friedrich", name: "Bahnhof Friedrichstraße", kind: "station", location: { lat: 52.52, lng: 13.388 } },
  { id: "lm_park", name: "Monbijoupark", kind: "park", location: { lat: 52.524, lng: 13.395 }, altNames: ["Monbijou Park"] },
];

afterEach(resetLandmarks);

describe("landmark name index", () => {
  it("folds transit prefixes, case, punctuation and diacritics", () => {
    expect(normalizeLandmarkName(" U-Bahnhof  Fríedrichstraße ")).toBe("friedrichstrasse");
    expect(normalizeLandmarkName("S Alexanderplatz")).toBe("alexanderplatz");
  });

  it("ranks exact-normalized Alexanderplatz forms before weaker matches", () => {
    installLandmarksForTests(area, fixtures);
    const matches = findLandmarks(area, "Alexanderplatz");
    expect(matches.slice(0, 3).map((match) => match.id)).toEqual([
      "lm_square", "lm_u", "lm_s",
    ]);
    expect(matches.slice(0, 3).every((match) => match.score === 1000)).toBe(true);
    expect(matches[0].kindLabel).toBe("square");
  });

  it("finds Bahnhof Friedrichstraße from its abbreviated stem and alt names", () => {
    installLandmarksForTests(area, fixtures);
    expect(findLandmarks(area, "Friedrichstr")[0]).toMatchObject({
      id: "lm_friedrich",
      name: "Bahnhof Friedrichstraße",
      kindLabel: "station",
    });
    expect(findLandmarks(area, "Monbijou Park")[0].id).toBe("lm_park");
  });
});
