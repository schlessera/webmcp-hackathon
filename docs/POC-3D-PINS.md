# 3D map pins POC

Worktree: `/home/alain/dev/webmcp-3d-pins`  
Branch: `poc/3d-map-pins`

Open a room, then choose **Layers → Buildings in 3D**. Place dots lift with
camera pitch, revealing a narrow dark green needle from the head to the original
POI. The stem is a 3px triangle tapering to a point for visibility over buildings.
Turning 3D off retracts the pins completely. Reduced motion changes the
camera and pins instantly.

Every room dot reserves the height its label needs from the start: about
31px at the current 48° view, adjusted for map perspective. Explore dots keep
their shorter stems. Label appearance never changes a room pin's anchor or
triangle. The lift illustrates elevation rather than physical altitude.
Change `PIN_HEIGHT` in `apps/web/src/map-pins.ts` to try another height.

Room circles, their rings, HTML dots, labels, and hit targets use the same
projected source coordinates. A canvas dot becoming an HTML label therefore
keeps its position even at high zoom. Needles meet the antialiased head border,
with the hollow centre masked out.

The POC keeps the existing MapLibre dot and ring layers. A transparent canvas
draws the visible needles at their actual projected endpoints and masks every
head, keeping hollow and translucent circles clear. The maximum 60 HTML markers
use SVG needles. Camera events update paint properties and DOM styles without
React animation renders or GeoJSON updates. No new dependencies.

For normal development, run `pnpm --filter @webmcp-hackathon/web dev` against
the API on port 4173. The current local preview on port 5184 uses the ignored
`apps/web/vite.pins.tmp.mts` config to reach the already-running API on 4183.
Use the same room invite link with the preview's port.

Validation commands:

```sh
rtk proxy pnpm --filter @webmcp-hackathon/web typecheck
rtk pnpm --filter @webmcp-hackathon/web build
rtk pnpm exec playwright test tests/e2e/spokes-ui.spec.ts -g '3D pins|whole-area pool stays fixed|two dot-only|pin taps select once|mirrored name cards|dots show their pipeline' --reporter=line
```
