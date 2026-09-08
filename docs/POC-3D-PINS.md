# 3D map pins POC

Worktree: `/home/alain/dev/webmcp-3d-pins`

Branch: `poc/3d-map-pins`

Open a room, then choose **Layers → Buildings in 3D**. Place dots lift with
camera pitch, revealing a narrow dark green needle from the head to the original
POI. The stem is a 3px triangle tapering to a point for visibility over buildings.
Turning 3D off retracts the pins completely. Reduced motion changes the
camera and pins instantly.

Every room dot reserves the height its label needs from the start: about
31px at the centre of the current 48° view. Explore dots keep their shorter
stems. Label appearance keeps a room pin's head and ground tip fixed while the
triangle's top widens from 3px to 12px over the label's 420ms transition. The
width animates perpendicular to the stem, preserving its perspective; newly
created labels start narrow too. Reduced motion changes the width instantly.
In 3D, the label grows as an opaque plate, covering the part of the widening
stem beneath it. Fading a translucent plate made that stem look like two
overlapping pins. Mirrored cards retain their side while collapsing back to a
dot. Hidden cards stay hidden when switching between 2D and 3D.
Heads are projected at a positive Mercator Z using MapLibre's full-precision
camera matrix, so outer pins lean outward like upright objects above the map.
X/Y remain at the POI. Height is normalized for zoom to keep the pins readable;
it illustrates elevation rather than claiming a surveyed altitude. The last
12° toward 2D retract the altitude smoothly, including its outward displacement.
Change `PIN_HEIGHT` in `apps/web/src/map-pins.ts` to try another height.

Room circles, their rings, HTML dots, labels, and hit targets use the same
projected source coordinates. A canvas dot becoming an HTML label therefore
keeps its position even at high zoom. Needles meet the antialiased head border,
with the hollow centre masked out.

MapLibre circle layers do not support altitude. In 3D, transparent canvases draw
the needles and heads at the same elevated projection as the HTML markers.
The heads reuse the native layers' evaluated radii, colours and border widths;
lookup rings share the existing animation clock. A separate needle canvas masks
every head, keeping hollow and translucent circles clear. The native layers keep
source tiling, state evaluation and queries, and resume drawing immediately in
2D. A custom layer supplies the current camera matrix through MapLibre's public
render API. Camera frames update canvases and DOM styles without React renders
or GeoJSON updates. No new dependencies.

For normal development, run `pnpm --filter @webmcp-hackathon/web dev` against
the API on port 4173. The current local preview on port 5184 uses the ignored
`apps/web/vite.pins.tmp.mts` config to reach the already-running API on 4183.
Use the same room invite link with the preview's port.

Validation commands:

```sh
rtk proxy pnpm --filter @webmcp-hackathon/web typecheck
rtk pnpm --filter @webmcp-hackathon/web build
rtk pnpm exec playwright test tests/e2e/spokes-ui.spec.ts -g '3D pin|whole-area pool stays fixed|two dot-only|pin taps select once|mirrored name cards|dots show their pipeline' --reporter=line
```

For concurrent visual checks, `SPOKES_UI_PORT` and `SPOKES_UI_PREVIEW_DIR` select
an isolated preview port/build; Playwright's `--output` isolates screenshots.
