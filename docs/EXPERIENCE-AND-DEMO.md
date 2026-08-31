# Experience and Demo

## Primary group flow

### 1. Create a planning room

The initiator selects or enters:

- A geographic area.
- A rough goal, such as food, activity, or destination.
- A relevant time or time window.

The application creates a guest-enabled room with a share link, QR code, and
expiry. A prepared geographic area can be prepopulated and cached for reliable
POC performance.

### 2. Join independently

Participants open the link from any existing communication channel. They join
with lightweight guest identities rather than requiring GCP OAuth or another
developer-style preparation step.

Each participant receives:

- A live shared map.
- A shared activity feed.
- Their own private requirement and negotiation area.
- WebMCP tools scoped to their identity when opened in ChatGPT's browser.

Inside ChatGPT, the conversation and the live application should remain usable
side by side. The human can continue chatting while observing map changes and
can directly manipulate the same map between agent turns.

### 3. Contribute asynchronously

A participant can add:

- A hard requirement.
- A soft or temporary preference.
- A comment or suggestion.
- A public or private veto.
- A bounded delegation rule.

Direct map interactions and conversational agent interactions affect the same
session. Examples include clicking a pin, vetoing from a reason menu, entering
a free-text reason, shortlisting, requesting comparison, or focusing the map.

The feed presents authorized updates such as:

```text
Sarah prefers a vegetarian option.
Joe added a private requirement.
Alex vetoed Cedar Table: visited too recently.
The council added three newly compatible candidates.
```

### 4. Recompute continuously

After every meaningful change, the council recomputes:

- Eligible and ineligible candidates.
- Verified hard-constraint failures.
- Aggregate satisfaction.
- Tradeoffs and compromises.
- Missing or low-confidence evidence.
- Whether the decision is feasible, fragile, infeasible, or uncertain.

Map pins, rankings, explanations, and participant views update live.

### 5. Reach explicit agreement

Participants set ready or acceptance states. The initiator or the agreed rule
commits the final destination only after the required confirmations exist.

### 6. Coordinate arrival

The room changes into arrival mode:

- Individual transportation modes and starting points.
- Optional meeting or pickup points.
- Route and detour suggestions.
- Opt-in location/ETA updates.
- One-click navigation handoffs to installed map applications.

Google Maps, Apple Maps, or another provider is the execution surface; the room
remains the coordination surface.

## Impasse resolution

The system continuously classifies the session:

- **Feasible:** useful candidates exist.
- **Fragile:** only one or two candidates remain.
- **Infeasible:** no known candidate satisfies all locked requirements.
- **Uncertain:** available evidence is insufficient to determine feasibility.

When an impasse occurs:

1. The council confirms whether the problem is a real conflict or missing data.
2. The world backend attempts neutral expansions such as geography, time,
   transportation, or additional evidence.
3. The constraint engine identifies a small conflicting set.
4. It calculates grounded counterfactuals, for example:
   - Widen the area by 600 metres to add three candidates.
   - Increase the budget from EUR 15 to EUR 18 to add two candidates.
   - Move the target time 30 minutes later to add one candidate.
5. Affected participants or agents receive private adjustment requests.
6. Changes within delegated bounds may be accepted; everything else requires
   explicit user approval.
7. The council recomputes and publishes a redacted resolution.

Medical, allergy, safety, and accessibility requirements should default to
locked. The system should first propose scope changes rather than pressure a
participant to compromise a protected need.

The public room should not announce that a named person is "blocking" the
group. It can say:

> No option currently satisfies every confirmed requirement. The council is
> privately checking possible adjustments.

The affected participant can receive a more specific private prompt.

## ChatGPT interaction behavior

ChatGPT is not expected to receive unsolicited background pushes. Whenever it
next invokes a WebMCP tool, the application synchronizes first and returns:

- Events since the last observed revision.
- The current participant-specific brief.
- Changes to candidates or agreement state.
- Any private action now required from that participant.

The operation then executes against current state or returns `sync_required`.
This preserves an apparently continuous experience without pretending ChatGPT
is the application's realtime subscription mechanism.

## Three-view hackathon demonstration

The recording and live demo can show three participant windows side by side.
They are three authenticated projections of the same room, not three versions
of the application. At least one should run inside ChatGPT's built-in browser;
the other views can be separate browser contexts.

### Proposed sequence

1. An organizer creates the room and reveals its link and QR code.
2. Sarah, Joe, and the organizer join with separate guest identities.
3. Sarah enters a shared vegetarian requirement.
4. Joe privately enters a lactose-intolerance requirement.
5. Only Joe's view shows its content; all maps reflect its aggregate effect.
6. The organizer's ChatGPT connects and receives the protocol manifest and
   current revision.
7. A participant clicks a map candidate and vetoes it.
8. All three maps and feeds update immediately.
9. Another participant contributes while ChatGPT is idle.
10. ChatGPT's next tool call catches up before it advises or acts.
11. The combined requirements deliberately produce an impasse.
12. One participant privately receives quantified, safe adjustment choices.
13. They approve widening the search area.
14. Every map immediately repopulates without exposing the private reason.
15. The group explicitly accepts a destination.
16. Each person receives a personalized arrival plan and one-click navigation.

This single sequence demonstrates:

- Multi-user realtime collaboration.
- Personal agents participating through WebMCP.
- Semantic map state rather than screenshot inference.
- Privacy-preserving projections.
- Async agent catch-up.
- Impasse detection and negotiation.
- Direct manipulation and agent actions sharing one command model.
- Concrete completion through navigation.

## Role-play findings folded into the experience

### Individual outing

The initial scenario was a person seeking a small snack while accompanied by a
dog, with a requested park detour before eating. The chosen kiosk turned out to
be full, so the system suggested a nearby alternative. The visit to Garden Cafe
Window was recorded as history only rather than promoted into a durable taste.

This revealed two weaknesses:

- The experience felt too similar to ordinary map navigation.
- The application was not proactive enough about one-click navigation.

Those findings pushed the concept toward multi-participant negotiation and a
stronger arrival-mode handoff.

### Group meal

A second scenario involved three people:

- Sarah needed vegetarian food.
- Joe needed a lactose-intolerance-compatible option.
- The organizer preferred something non-Italian after eating Italian the day
  before and wanted an affordable choice.
- Sarah vetoed Cedar Table because she had visited recently.
- Joe planned to arrive by Uber.
- Sarah requested pickup from the nearest subway station.

The system re-ranked candidates after the veto and coordinated a subway pickup
before navigation. This demonstrated valuable logistics, but also exposed that
the synchronous single-chat flow did not adequately represent several people.

The improved design therefore gives every participant their own identity,
authorized view, contribution channel, optional personal ChatGPT, and arrival
plan inside one async room.

## Judge-facing explanation

The simplest explanation is:

> Three people and their personal agents negotiate where to go. One requirement
> stays private. The shared map updates live, detects an impasse, privately
> negotiates a bounded adjustment, and reaches agreement without exposing the
> sensitive reason.

The deeper technical contribution is the reusable negotiation layer underneath
the map.

## Expected first-use questions

The product should answer these without documentation-heavy onboarding:

- **What can this thing do?** Show a concise room goal and suggested starting
  actions.
- **Can I click on the map?** Make pins and direct actions visibly interactive.
- **How do I tell it what to optimize for?** Accept natural language and expose
  shared/private plus hard/soft controls.
- **How do three people combine preferences?** Show participant state and live
  council recomputation.
- **How do I plan for later rather than now?** Treat time as a first-class search
  scope.
- **Does it work with my smartwatch?** Be honest that the POC offers mobile
  navigation handoff while watch-specific support is future work.
