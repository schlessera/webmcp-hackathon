# Spokes — Demo Runbook

The scripted three-window demonstration, verified against the seeded Berlin
Mitte dataset and the automated trajectory in `tests/e2e/spokes-flow.spec.ts`.
Numbers below are the real ones the engine produces (they differ slightly from
the older planning docs: recovery widens to **1200 m**, not 1400 m).

## Setup

1. `make demo` — starts Postgres + server on `127.0.0.1:4173` and seeds
   `room_demo` (31 Berlin Mitte venues, 800 m scope around Weidendammer
   Brücke, participants Alex/organizer, Sarah, Joe, no requirements yet).
   Re-run a clean state anytime with `make demo-reset`.
2. `node scripts/open-participants.mjs` — opens Sarah and Joe in two separate
   browser contexts and prints the organizer invite URL.
3. Open the organizer URL (it carries `?surface=chatgpt`) inside ChatGPT's
   built-in browser. The page registers all 15 WebMCP tools at load; ChatGPT
   lists them under "Available site tools".
4. Arrange the three windows side by side: Sarah | Joe | organizer (ChatGPT).

## Beats

| # | Window | Action | What every window shows |
|---|--------|--------|------------------------|
| 1 | — | Rooms already joined | Map with 31 pins, 21 eligible (teal) inside the 800 m ring, "21 of 31 eligible" |
| 2 | Sarah | Needs → add **vegetarian**, shared, hard | Feed: "Sarah requires vegetarian options."; pins re-color |
| 3 | Joe | Needs → add **lactose-free**, **private** (application-private), hard | Sarah/Alex feeds: *"Joe added a private requirement."* (italic, no content); eligible count drops; **impasse fires** — banner: "No option satisfies every confirmed need. The council is privately checking possible adjustments." |
| 4 | Alex | Needs → add **exclude Italian** (shared) and **budget ≤ 15 €** (shared) | Feed lines; counts tighten further under the standing impasse |
| 5 | Alex | Decisions tab → private card (only Alex sees it): "Widen the search area from 800 m to 1200 m?" → **Accept** → in-page **Confirm** card → confirm | Peers never see the card; after confirm, the scope ring **animates outward** in all three windows; feed: "Search adjusted." — **3 candidates** now eligible; impasse banner clears |
| 6 | Organizer's ChatGPT | Ask: *"What changed while I was away? What are our options?"* — agent calls `sync_session` / `get_spatial_context` | Agent relays the brief: 3 eligible candidates, no private reasons exposed |
| 7 | Organizer's ChatGPT | Ask: *"Propose the tea house."* — agent calls `propose_destination` on **Chén Ché** (`place_30`) | Proposal ring appears on the pin in all windows |
| 8 | Sarah | Click the Chén Ché pin → **Veto…** → reason "Visited too recently" | Stance recorded; proposal marked vetoed everywhere; **2** candidates remain |
| 9 | Organizer's ChatGPT | Agent's next tool call catches up (`sync_required` → delta shows the veto) — narrate this beat: the agent reasons over the delta and proposes **The Barn** (`place_24`) instead | New proposal ring |
| 10 | Sarah + Joe | Pin card → **Works for me**; both toggle **I'm done adding** | Stance counts update on the proposal card |
| 11 | Alex | Ready toggle; Decisions → **Stage agreement** (or ask ChatGPT — the tool stages only) → in-page **Commit** card → commit | Phase flips to **arrival**; committed pin turns gold |
| 12 | All three | Arrival banner: pick mode (walk/bike/car), optional pickup note; press **Navigate** | Google Maps directions open with The Barn as destination |

## Talking points while beats run

- Beat 3: server-side redaction — Joe's requirement content exists only in
  Joe's window and the council's evaluation; check the network tab if a judge
  asks (the e2e suite asserts it at the wire).
- Beat 5: consent is two-step and in-page — an agent can recommend granting,
  only the human confirms. Adjustments are quantified counterfactuals, not
  vibes ("+3 candidates").
- Beat 6/9: ChatGPT is not a realtime subscriber — it catches up through the
  revision delta on its next tool call, and stale mutations are rejected with
  `sync_required` instead of acting on old state.
- Beat 11: `confirm_agreement` (tool) stages; committing is a human, in-page
  act. A high rank is never agreement.
- Throughout: map gestures and agent tools dispatch the identical commands —
  one command model, two entry surfaces.

## Key IDs

- Veto target: `place_30` Chén Ché (Vietnamese tea house, Rosenthaler Str.).
- Final destination: `place_24` The Barn (café, Auguststraße).
- Third recovered candidate: `place_25` Kebap with Attitude.
- Attribution footer (OpenFreeMap/OpenMapTiles/OSM + OSRM/FOSSGIS) is in the
  map corner; ODbL details in `packages/contracts/data/ATTRIBUTION.md`.
