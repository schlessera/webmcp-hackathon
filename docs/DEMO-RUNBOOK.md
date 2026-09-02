# Spokes — Demo Runbook

The scripted three-window demonstration, re-walked against the redesigned
client and the seeded Berlin Mitte dataset. Every count below is one the
engine actually produces for this data (recomputed 2026-09-02); every control
named is one the UI draws.

## Setup

1. `make demo` — starts Postgres + server on `127.0.0.1:4173` and seeds
   `room_demo`: 31 Berlin Mitte places, an 800 m scope around Weidendammer
   Brücke, participants Alex (organizer), Sarah and Joe, no needs yet.
   Re-run a clean state anytime with `make demo-reset`.
2. `node scripts/open-participants.mjs` — opens Sarah and Joe in two separate
   browser contexts and prints the organizer invite URL.
3. Keep the organizer URL (it carries `?surface=chatgpt`) ready for ChatGPT's
   built-in browser, but **do not open it yet** — beat 3 is that arrival. The
   page registers all 17 WebMCP tools at load; ChatGPT then lists them under
   "Available site tools".
4. Arrange the three windows side by side: Sarah | Joe | organizer (ChatGPT).

## Numbers this run produces

| Moment | Count block reads |
|---|---|
| Before any need | `21 places · nothing ruled out yet` |
| After Sarah's need | `12 still work · of 21 · 9 unsure` |
| After Joe's private need | `0 still work · of 21 · 19 unsure` |
| After Alex's two needs | `0 still work · of 21 · 15 unsure` |
| After the area widens to 1.2 km | `4 still work · of 31 · 21 unsure` |
| After the room settles | `Settled · 11 min from you` |

## Beats

| # | Window | Action | What the windows show |
|---|--------|--------|------------------------|
| 1 | Sarah, Joe | Both open their links | Edge-to-edge map: 31 places, the 21 inside the dashed ring drawn as stickers, the rest as grey dots. Count block top-left reads `21 places`. Alex's avatar is idle and the brief carries an "Alex hasn't arrived" card: they will see the map exactly as it stands when they open the link |
| 2 | Sarah | Tap the **vegetarian options** pill above the composer (scope chip stays **Shared**) | A row joins "What matters" with a `9 unknown` badge; the map settles in place and never re-centres. Count drops to 12. Press and hold the row to preview the set without it — 21 come back, release restores. Every pill and every row's text is a server label |
| 3 | Organizer | Open the organizer URL in ChatGPT's browser, look around, then close it again — Alex steps out for a while | Alex's avatar fills in, ChatGPT lists the site tools, and the other two windows show Alex as arrived |
| 4 | Joe | Set the composer scope chip to **Private**, type `lactose-free options`, press **Add** | Joe sees the need as a row, bordered in the scope colour. Sarah sees only "A private condition" with `−2` and a `private` badge — no label, no toggle. Count falls to 0; the header subtitle turns "nothing works for all three". Joe alone gets **One way out**: "Let 'lactose-free options' be nice-to-have `+12`" with **Make it optional**, and the offer chip on that map |
| 5 | Organizer | Open the organizer URL again (a fresh tab, so the page knows what it missed) | The brief opens on **While you were away**: Joe's missed move is a `?` row with no author and no content; Sarah's already-seen need remains named in **What matters** below. A consent card is already waiting, badged **only you see this** |
| 6 | Organizer's ChatGPT | *"What changed while I was away? What are our options?"* — the agent calls `sync_session`, then `get_spatial_context` | The agent relays the brief: nothing satisfies everyone, and it names no private reason because it was never sent one |
| 7 | Alex | Type `€15` in the composer (Shared) → **Add**. Then ask ChatGPT *"we're not doing Italian tonight"* — the agent calls `submit_requirement` with an exclusion | Two more rows: "budget €15" `−1` and "avoid italian" `−3`. The subline tightens to `of 21 · 15 unsure`. Peers still learn nothing about Joe's condition |
| 8 | Alex | On the consent card — "Widen the area from 800 m to 1.2 km? · Brings back 4 places" — press **Accept**, then **Confirm** on the card that replaces it | Peers never see the card. While it stands, Alex's map draws the proposed radius as a second, fainter ring. After the confirm the ring grows in all three windows, outside places settle in, and the count reads `4 still work / of 31 · 21 unsure`. Every subtitle returns to "three in the room · 4 still work"; Alex's digest has already folded away with Alex's first new move in beat 7 |
| 9 | Organizer's ChatGPT | *"Put Chén Ché forward."* — the agent calls `propose_destination` on **Chén Ché** (`place_30`) | The pin fills in the act colour and reads "· proposed". Every brief gains a card: "Chén Ché is on the table" with **Works for me** / **Look at it**. Alex also gets "Settle on Chén Ché?" with **Stage it** |
| 10 | Sarah | Tap the Chén Ché sticker — the place panel opens (verdict strip, "Does it fit", "Also on record", "Where everyone stands") → **Rule it out** | While Sarah has the panel open, the other two windows draw her initials peeking out from behind the Chén Ché sticker. Her veto appears under "Where everyone stands" in every window, the sticker turns hollow in the act colour with the name struck through and a "ruled out" chip, and the proposal stops being stageable. The count does **not** move: a veto blocks the agreement, it does not rule the place out of the set |
| 11 | Organizer's ChatGPT | The agent's next mutation comes back `sync_required` with the delta — narrate this: it is not a realtime subscriber, so it catches up, reads the veto, and proposes **The Barn** (`place_24`) instead | A second proposal card, and the Chén Ché pin drops back to a plain sticker |
| 12 | All three | **Works for me** on The Barn, from the card or the place panel | Each acceptance appears under "Where everyone stands" as a filled mark, and accepting marks that person done adding (the toggle at the foot of the brief fills in by itself). Until the last accept, Alex's card reads "Settle on The Barn?" with a disabled button and says who it waits on; with it, the card turns to "Everyone is in on The Barn" |
| 13 | Alex | **Stage it**, then **Settle it** on the staged card | The Barn's sticker reads "· staged" in the act colour; peers see "Waiting for the organizer to settle it." After the commit the sticker reads "· settled", the header title becomes "The Barn", the subtitle "agreed by all three", the count block shrinks to `Settled / 11 min from you`, and the brief shows **How it got here** |
| 14 | All three | The composer is replaced by the arrival bar: pick **Walk** / **Bike** / **Drive**, then **Take me there** | Google Maps opens with The Barn as destination; the `geo:` link and Apple Maps sit beside it |

## Other areas, live places (optional)

`room_demo` runs on the curated Berlin dataset above, unchanged. Opening the
app **without** an invite link shows the area picker: Berlin Mitte or San
Francisco SoMa, each card carrying the numbers measured from that city's
OpenStreetMap extract (places within 1.4 km, facts on record out of the
facts a need could check, opening hours listed, extract date). Pick one, name
the people, and the page returns one invite link per person; the organizer
enters directly.

What to expect, and to say, in such a room:

- The places are real and unedited: every fact reads `from OpenStreetMap`,
  nothing is guessed. Prices are unknown everywhere, so a budget need marks
  every place unsure instead of ruling any out.
- A room starts with the 40 nearest places inside 800 m, 40 more out to
  1.4 km, 40 more out to 2 km, so widening the area has somewhere to go.
- San Francisco is where the honest gap shows: most pills never appear
  (a pill needs at least one place verified for it) and most rows carry a
  large `unknown` badge. That is the data, drawn as unsure, not a failure,
  and it is the opening for an agent to look things up.
- The provenance line at the foot of the brief names the source and the
  extract date; `{ }` shows the area id, the snapshot timestamp and the pool.
- An unknown fact is where an agent earns its place: in ChatGPT, *"Find out
  whether B Restaurant has lactose-free options and record what you find"* —
  the agent reads the dossier with `inspect_candidates`, looks it up, and
  calls `attest_attribute` with a note. The place panel then reads "checked
  by Alex" beside the fact, the feed says who checked what, and the
  classifier rules on it. Contradicting a verified OpenStreetMap fact marks
  it disputed rather than overwriting it.

None of the counts in the table above apply to these rooms; they are not
rehearsed. Record the video on `room_demo`.

## With an agent in the page (optional)

With `OPENAI_API_KEY` in the environment (`docs/NL-AGENT.md`), beats 4 and 7
can be spoken instead of typed: Joe sets the scope chip to **Agent only** and
types "I can't have lactose" — the agent holds it, the room sees only that a
private condition exists, and the map settles as the agent screens.
Alex types "we're not doing Italian tonight" in Shared and the exclusion
arrives without ChatGPT. "What are our options?" comes back as a "Your agent"
card in the brief. Every routed sentence logs its model and timing in `{ }`.

## Talking points while beats run

- Nothing in the chrome names a domain. Every pill, need row and attribute row
  is a server-supplied label rendered in server order, so the same screens
  serve a park, an exhibition or a screening.
- Beat 2: unverified is a state we draw, not a failure. `9 unknown` means the
  data is missing; those places stay on the map as hollow stickers.
- Beats 2–8: press and hold any need row to see the set without it, live on
  the map. There is a keyboard equivalent (focus the row, hold Space) and the
  new count is announced. The map never re-centres — places settle in place.
- Beat 4: server-side redaction. Joe's need content exists only in Joe's
  window and in the council's evaluation; peers receive a count and nothing
  else. Check the network tab or the `{ }` drawer if a judge asks.
- Beat 4: the way out is offered privately to the person who can take it, and
  it is quantified. Nobody is ever named as blocking.
- Beat 7: "no Italian" has no composer control on purpose. The app ships zero
  domain chips, so an exclusion arrives as a command, and the agent is one of
  the two surfaces that can send one. Free text matching no facet becomes a
  pending need that rules nothing out, and the brief says so honestly.
- Beat 8: consent is two-step and on the page. An agent can recommend
  granting; only the human gesture applies it. The offer is a quantified
  counterfactual, not a vibe.
- Beats 6 and 11: ChatGPT is not a realtime subscriber. It catches up through
  the revision delta on its next tool call, and stale mutations come back as
  `sync_required` instead of acting on old state.
- Beat 13: `confirm_agreement` stages only. Staging sends the page a
  single-use confirmation code over its live channel that the commit must
  carry back. The code never appears in any tool result, so an agent cannot
  settle the room even by calling the raw command.
- Throughout: map gestures and agent tools dispatch the identical commands —
  one command model, two entry surfaces. Anything protocol-shaped lives behind
  the `{ }` drawer and nowhere else.

## Key IDs

- Proposed first, then ruled out: `place_30` Chén Ché, 14 min from the centre.
- Final destination: `place_24` The Barn, 11 min.
- The other two survivors: `place_25` Kebap with Attitude, `place_31`
  District Một.
- All four sit outside the original 800 m ring, which is why widening the area
  is what breaks the impasse.
- Attribution (OpenFreeMap/OpenMapTiles/OSM + OSRM/FOSSGIS) stays in the map
  corner at 7px; ODbL details in `packages/contracts/data/ATTRIBUTION.md`.

## If a beat misfires

- **No "While you were away" at beat 5.** The digest needs a tab whose last
  sync is behind the room. Reloading the same tab keeps its place; open the
  URL fresh instead. If Alex never synced above revision 0, there is nothing
  to be behind — that is why beat 3 comes after Sarah's need.
- **The pill for a need is missing.** Pills only offer yes/no facets that at
  least one place in the current set is verified for, and never one already
  stated. Type the facet's exact label instead.
- **`Stage it` is disabled.** The card says what it waits on: who is still
  adding (by name), how many have not said, whether a veto stands. Accepting
  marks a person done adding, so three accepts are enough.
