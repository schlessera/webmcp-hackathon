# Spokes — Demo Runbook

Current operating guide, checked against source on 2026-09-07. The core
scenario uses three participant windows and the curated Berlin demo room.
Rehearse against the build and data being shown before quoting counts or
recording a video; this document does not certify a fresh browser walkthrough.

## Prepare the local scenario

1. Run `make demo` to start the local stack and seed `room_demo`.
   The fixture contains 31 curated Berlin Mitte places, an 800 m scope around
   Weidendammer Brücke, and Alain (organizer), Sarah, and Joe. It starts without
   needs. The seeder is idempotent and preserves existing room activity; use
   `make demo-reset` on the local demo database for a clean scenario.
2. Run `node scripts/open-participants.mjs`. It opens Sarah and Joe
   in separate Chromium contexts and prints the organizer URL. Keep
   `APP_URL` and `DEMO_SECRET_KEY` consistent with the server if overriding
   them. These pre-created member links require development mode and
   `ALLOW_LEGACY_MEMBER_INVITES=1`, which local Compose sets. Production
   member invitations use the normal claim flow described below.
3. Keep the organizer URL for the arrival beat. Its `?surface=chatgpt` marker
   identifies the intended surface; actual WebMCP discovery still depends on
   the browser and agent host. The page registers **24 tools** when
   `document.modelContext` is available. A test shim is not a native-agent
   demonstration.
4. Arrange Sarah, Joe, and organizer views side by side. Preserve the
   organizer's original browser context when stepping away and returning so
   it retains its last-seen revision.
5. Check the initial radius, participants, and dataset before starting.
   Enrichment, confirmations, and added places can change the scenario.
   Use the live numbers and evidence states rather than memorized subtitles.

The curated venue file includes labelled demo facts. Its dietary, price, and
other assertions support the scenario; they are not fresh verification of
those businesses. The ordinary Berlin/San Francisco snapshots and the
curated fixture have different coverage.

## Read the counts honestly

The headline number is **confirmed plus likely**. Likely and unlikely results
are guesses with evidence, while unsure results lack enough information.
Only confirmed eligibility drives wire `matching` counts, feasibility, and
the gains shown for impasse adjustments. A likely place can therefore appear
in the headline count while an impasse remains unresolved.

The scenario should demonstrate a confirmed-match impasse in the initial
scope and a quantified scope offer that restores confirmed options. Check
the offered radius and gain in the current room. A settled travel estimate
depends on the participant's starting point and is not a routed journey time.

## Three-window sequence

| Beat | Action | What to demonstrate |
|---|---|---|
| 1 | Sarah and Joe open their fixture links. | Both see the same room and map, with their own identities. The organizer has not arrived yet. |
| 2 | Sarah adds the server-labelled **vegetarian options** suggestion in Shared. | The need and evidence counts appear in the brief. Hold the owned row, or focus it and hold Space, to preview without it; release restores the set without re-centring the map. |
| 3 | The organizer opens the room in the agent host, calls `sync_session`, then steps away. | Presence changes, the agent learns the protocol and revision, and the original browser context has a known point to catch up from. |
| 4 | Joe chooses **Private**, types `lactose-free options`, and adds the need. | Joe can read the condition. Peer views omit its text and show an effect on the shared decision. Inspect an affected place and the available ways forward. |
| 5 | The organizer returns in the same browser context. | The page catches up from its last-seen revision. Any digest and private request reflect what actually happened while it was away. |
| 6 | Ask the organizer's agent, “What changed while I was away? What are our options?” | It calls `sync_session` and `get_spatial_context`, receives its authorized view, and can explain the impasse without receiving Joe's private text. |
| 7 | Alain adds `€15` in Shared, then asks the external agent to exclude Italian cuisine for this session. | Direct input and `submit_requirement` use the command engine. Check the stored need and resulting evidence; repeat `sync_session` before a new mutation if the room moved. |
| 8 | On the organizer's private scope offer, review its current radius and gain, then use **Accept** and **Confirm**. | The grant stages before it applies. The expanded scope and restored candidates reach every view; peers do not receive the private request. |
| 9 | Propose an available candidate, using Chén Ché (`place_30`) when it is suitable for this fixture. | `propose_destination` creates the same proposal that a map action would, with response controls for each participant. |
| 10 | Sarah opens the proposed place and vetoes it. | The shared proposal reflects the visible stance and cannot be committed while the veto stands. A veto blocks agreement; it does not change evidence-based eligibility. |
| 11 | The organizer's agent catches up and proposes The Barn (`place_24`), or another candidate supported by the current room. | A stale mutation returns `sync_required`; the agent must read the delta before acting again. It is not a background realtime subscriber. |
| 12 | Every participant chooses **Works for me** on the final proposal. | Acceptance also marks that participant ready. Commitment requires all participants ready and accepted or abstained, with no veto, including anyone currently disconnected. |
| 13 | The organizer selects **Stage it**, then **Settle it**. | Staging and commitment are distinct. The final choice settles, and the page shows the agreed place. |
| 14 | Each person selects **Walk**, **Bike**, or **Drive**, then **Take me there**. | The external Google Maps link opens; Apple Maps and the `geo:` handoff are alternatives. Spokes supplies destination coordinates and arrival choices, not street routing. |

If a counterfactual no longer restores a useful set, inspect which active needs
and evidence are driving it. Reset and rehearse the local fixture before
recording rather than narrating a gain the current application does not show.

## Show the current start and invitation flow

Open `/` without an invite and choose **Start a room**. Enter your name and a
goal such as “dinner, then a film nearby.” The app reads up to three sequential
steps. Review their place classes, drop a step or a misread need, and answer
any clarification before choosing Berlin Mitte or San Francisco SoMa. If
language interpretation is unavailable, choose a place class in the fallback
plan and continue.

The organizer enters the new room alone. Open the room's invite control to
generate a link and QR code for one person, then generate a new one for the
next person. Each recipient claims their own link and chooses a name. An
unclaimed link expires after one hour; claiming it binds it to that browser.
A claimed link is that browser's route back to the same participant, not a
reusable group invitation. Bearer tokens expire after 24 hours; organizer
recovery links after seven days. There is no leave/removal control.

The area choice selects prepared OpenStreetMap data. The server determines the
candidate pool from area, scope, and step class, with a 2,500-candidate cap.
Panning can reveal other places that may be added to the room. Counts from the
curated fixture do not apply to a newly created room.

For a multi-stop demonstration, settle the first step. The next search starts
around that place and applies the next step's pending needs. Arrival follows
the final step. Readiness carries forward, but the next proposal requires new
stances from the participants. Plans cannot be edited/reordered or settled
steps reopened after the room is created.

## Evidence, privacy, and built-in agent beats

- Open a place's details to show which active needs it meets, what is unknown,
  and the evidence behind each fact. `inspect_candidates` is an abbreviated
  agent view. A participant can use `attest_attribute` or `confirm_fact` to
  contribute evidence for this room; do not describe that as verification for
  every other room or as a guarantee of current venue conditions.
- Private content reaches the application server and storage. Other
  participants receive redacted views, but visible effects, metadata, and
  small-group knowledge may allow inference. Demonstrate omitted text rather
  than promising anonymity.
- With configured model credentials, try the built-in agent. Its tool-driven
  room changes produce an owner-only review card. Read the exact proposed
  values and choose **Approve change** or **Dismiss**. Approval is single-use,
  expires after five minutes, and still passes through normal command checks.
  External WebMCP calls do not use this built-in review wrapper.
- To demonstrate **Agent only**, explain which agent holds the condition.
  An external agent can retain the reason outside Spokes and return verdicts.
  The built-in agent receives it on the server, holds it in process memory,
  and sends it to tool-less interpretation and screening models. It stays out of the room's
  requirement/event record; it does not stay off the server or AI provider.
  A restart loses that held text.
- On-page confirmation carries a 120-second, single-use nonce from the
  participant's realtime channel. The applying command has no WebMCP tool
  route. This separates staging from applying, but a bearer-token holder can
  obtain the nonce; do not claim it proves a human gesture.
- Unknown facts remain visible, optional needs do not rank candidates, and
  group agreement does not certify that a place meets every hard need.
  [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) contains the full current bounds.

## Recording and checks

`scripts/record-demo.mjs` drives a paced three-context recording against its
own local server and a throwaway room, producing `org.webm`, `sarah.webm`,
`joe.webm`, and `beats.log`. It uses the browser test shim for agent actions,
so its output is UI/command evidence rather than native ChatGPT verification.

Use a migrated, isolated database, development mode, and
`ALLOW_LEGACY_MEMBER_INVITES=1` for this fixture-based script. Keep external
model credentials empty and set `ENRICH_NETWORK=0` and `POOL_FILL=0` when
recording the deterministic direct-control flow.
Do not run API tests or another recording against the same database at the
same time. Review every captured beat and its current labels before narrating
it; the recording script is not proof that a fresh run completed.

For native-agent validation, use the configured native browser lane and then
exercise the live application in the intended host. Record the build,
discovered tools, actual calls, returned deltas, and on-page results.
[PROJECT-STATUS.md](PROJECT-STATUS.md#run-and-validate) lists the validation
commands; [DEPLOY.md](DEPLOY.md) covers deployment.

## If a beat misfires

- **No catch-up digest:** use the organizer's original browser context and
  confirm it synced before stepping away. A new context has no useful
  last-seen baseline. The agent can always request the current authorized
  state with `sync_session`.
- **A suggested need is missing:** suggestions depend on the current facets
  and active needs. Use the exact server label in the composer or inspect the
  current vocabulary rather than assuming a fixed pill list.
- **A fixture member link is rejected:** check development mode, the legacy
  fixture flag, the matching demo secret, and invite age. Use the normal
  one-person invitation flow on production.
- **An approval expired or became stale:** inspect current state and ask for
  a fresh suggestion. Repeatedly approving the old card cannot refresh its
  stored revision or five-minute lifetime.
- **Stage it is disabled:** inspect readiness, missing responses, conditional
  accepts, and vetoes. Every participant still counts while disconnected.
- **Counts differ:** check active needs, origin, scope, enrichment, and added
  places. A local demo reset removes that room's activity; it is not a reset
  of every shared cache or global enrichment record.
