# Spokes — copy lexicon

The app is **domain-agnostic**. The same screens must work for a dog walk, an
exhibition, a film in a given language, a quiet coworking room, or dinner.
Copy is where domain assumptions leak back in, so it is specified here.

This guide preserves the copy rules and describes the current flow. Active
labels live in [copy.ts](src/ui/copy.ts) and the components; a label still
present in that dictionary is not evidence that a screen uses it. Known
wording gaps below are documentation of the current UI, not completed fixes.

---

## The one rule

**Never name the domain in chrome.** Chrome is anything the app ships:
labels, buttons, headings, empty states, errors. The domain may appear only
in (a) user-authored text, (b) server-supplied facet labels, (c) place names.

| Don't | Do |
|---|---|
| "3 restaurants match" | "3 still work" |
| "Filter by cuisine" | "What matters" |
| "Find a place to eat" | "What are you looking for?" |
| "No restaurants nearby" | "Nothing here fits yet" |
| "Dietary requirements" | *(a facet label from the server)* |
| "Book a table" | "Take me there" |

## Nouns

- **place** — any candidate, always. Not venue, spot, location, result, option.
- **places** in counts: "6 places", never "6 results".
- **need** — a stated requirement. Not filter, not preference, not constraint.
  ("Preference" implies it's negotiable; "constraint" implies it isn't. Both
  prejudge what only the group can decide.)
- **room** — the shared session. Not board, canvas, session, workspace.
- **the group** — never "the party", never "attendees".

## Verbs

- A need **rules out** places. It does not "filter" or "exclude" them.
- A person **says what matters**. They don't "add a filter" or "set a preference".
- An agent **suggests** a change while it awaits approval, **acted** when a
  change was applied, and **staged** when a decision awaits confirmation.
  Do not describe a suggestion as something that already changed the room.
- You **settle** on a place. The group **agrees**.

---

## Counting

The count block is the single most-read element. Always **absolute, never
percentage**, and always paired with the total on second line.

```
6            of 34 · 4 likely · 3 unsure
still work
```

- 0 → the block turns `--spoke-unsure` and reads `0 / still work`, with the
  subline explaining the zero: still to check, one blocking need, or a
  collision. Missing evidence is not itself a collision.
- 1 → "1 still works" (verb agrees).
- The big number counts confirmed places **and** likely ones: a guess with a
  reason is still an option the room can act on. The subline breaks that
  number down — "4 likely" is part of the six, never an addition to
  it. **likely** and **unlikely** are the only words for a guess; never
  "probably", "maybe", "estimated". A guess is drawn dashed.
- Unknowns are part of the total but never folded into the headline count:
  "3 unsure" means the data is missing, **not** that the place failed.
- Unlikely places are counted apart as well: "2 unlikely" reads beside the
  total, and a guess leaning against a need never rules a place out.
- A declared impasse is only *said* while nothing works: with likely places
  still standing, the block and the header count them instead of announcing a
  dead end, and the ways out stay on the brief as offers.

## Deltas

Always signed, always relative to the current set, never a percentage.

- `−19` a need ruled out 19 places
- `+3` relaxing this would bring back 3
- `34→15` in a history row

Deltas count confirmed places only, while the big number also counts likely
ones. The room computes what a need ruled out and what relaxing it would
bring back on verified evidence alone, so a guess never moves a delta.

Phrase the offer as a consequence, not an instruction:
"**+3** if 'outdoor seating' went optional" — not "Relax outdoor seating to see more".

---

## Confidence

A guess carries its confidence as a word, never a number: **fairly sure**
(the source would nearly verify it), **likely** / **unlikely** (a reasoned
guess), **a guess** (thin evidence). The evidence itself is quoted where
there is one: "the menu mentions a vegan bowl".

## Confirming a fact

Every confirmable need row in a place panel offers the text actions `Confirm`
and `Rule out`. After this person confirms it, the row reads `confirmed by you
· Sep 3` and offers `undo`. Another person's confirmation reads `confirmed by
Sarah · Sep 3`; only its confirmer or an organizer gets `undo`.

The fact ledger's source phrase is `confirmed by Sarah` (or `confirmed by you`
to Sarah). When this evidence is what clears a need, the explanation is
`Sarah confirmed it`. A contradiction is explicit: `the record and confirmed
by Sarah disagree`. For a private question, peers and other rooms see neither
the sentence nor its hashed fact row; the shared history says only `Sarah
confirmed a question at The Barn.`

These controls are schema-driven. The page ships no fact-specific or
domain-specific control or label. A confirmation is a participant's evidence
for this room; it is not a change to the shared venue record or a claim that
the fact has been independently verified. The confirmation path binds the
action to a participant, not to proof that a human clicked.

## Privacy phrasing

Describe who can read the content and who processes it separately. A private
need's **effect** is visible to the room; its **content** is withheld from
peers. This is not anonymity: ownership and activity can still be visible.
Never leak the content, and never pretend the effect didn't happen.

- ✅ "A private condition ruled two out"
- ✅ "Someone can't travel far" *(shown only to the person who said it)*
- ✅ "A private condition" *(the peer row for either private scope)*
- ✅ "A private condition about distance" *(only with an owner-authorized topic hint)*
- ❌ "Sarah's mobility requirement ruled two out"
- ❌ "2 places hidden" *(hides that anything happened)*

The three choices have different processing boundaries:

- **Shared:** the room can read the need.
- **Private:** the server stores and evaluates the need. When entered through
  natural language, the configured model provider also processes the text.
  Peers receive effects rather than the condition.
- **Agent only:** an external agent can retain the condition and send a
  content-free declaration and per-place verdicts. With the built-in agent,
  the text instead goes to server memory and the configured interpretation
  and screening models. It is omitted from the stored requirement and event
  records and from the tool-calling agent's context. Restarting the server
  loses the held text; the declaration does not prove screening is running.

Never promise "nothing reaches us", "only on your device", or anonymity for
the built-in path. The composer's short scope descriptions do not yet state
all these boundaries. The screening card explains that other people see which
places work without the condition, and that the built-in agent uses Spokes
and its model providers to check it. See [known limitations](../../docs/KNOWN-LIMITATIONS.md)
for the current screening failure modes.

## In progress

Work the room is doing is stated as what it is doing, never as a bare
"Loading…".

- A need just said: `saying it…` before commitment, then `checking 12
  places…` on the pending row. Zero places to check: `checking…`.
- The whole area still arriving: `120/343` beside the head-row ring, with
  `adding places · 120 of 343` as accessible text. Absolute both sides,
  never a percentage.
- A place being looked up: `looking it up…` in the panel; a ring on the map.
- The hover card on the map carries the place's name and first photo, nothing else — no verdict, no numbers.
- The agent: `reading what you said…` then `updating 40 places…`. Never
  "thinking", never "processing".
- Nothing under a second shows a state at all; a ring that flashes for a
  glance is noise.
- Progress of every kind — the area filling, the pipeline, a lookup, the room
  refining on its own — is one ring in the count's head row, with `N/M` beside
  it wherever there are honest numbers. The sentences ride on `aria-valuetext`
  and the live region: `adding places · 60 of 90`, `checked 84 places for 2
  needs · 5 to go`, `looking up 2 · 5 to go`, and, out of budget, `paused for
  now` — the room is waiting its turn. This uses one slot, with no progress
  line below the count. Never "AI is searching". Where no honest number is
  available, the ring alone is paired with accessible text.
- A question need that has answers: `· looked up` beside its label.
- A fact read from the web names where: `from example.org ↗` as a link,
  host only, always clickable. Sources in words: `found on the web`,
  `found on the place's site`, `a guess from what the place publishes`.
- A photo from the recorded website reads `from the place's site ↗`. A
  Creative Commons photo reads `photo · <credit> · <licence> ↗`, using the
  source's actual credit and licence. An image linked by OpenStreetMap reads
  `photo · from OpenStreetMap ↗` when it has no embedded credit. A Commons
  geosearch photo reads `photo near this place · <credit> ↗`; "near" is
  explicit because coordinates plus a name match are strong evidence, not an
  assertion that the file was attached to the record.

## Agent phrasing

Name the actor and the authority in the same breath:

- "Review this suggestion before applying it to the room." — a built-in
  tool-calling mutation awaits its owner's approval
- "Your approved change was applied." — only after successful approval
- "Your agent staged it for your confirmation." — beyond the private
  adjustment grant; staging has not applied the change
- "Your agent screened 6 places for you" — after accepted screening results,
  not merely because an evaluation request exists

The review card uses **Approve change**, **Dismiss**, and **Saving…**. It
shows the stored values and says **"These are the values that will be applied.
Review any shared text before approving."** A suggestion expires after five
minutes, is single-use, and belongs to its participant. Approval applies its
stored arguments at the original room revision; stale or expired suggestions
need a fresh request. Do not call this a blanket permission for later actions.

This review applies to built-in tool-calling mutations, not every natural
language operation or direct external-agent tool call. Private adjustment
confirmation and agreement confirmation are separate steps. The staged card
says "Your agent staged it for your confirmation." This does not claim proof
of a human gesture. See [AgentActionReview](src/components/AgentActionReview.tsx) and the
[interaction contract](../../docs/protocols/INTERACTION-AND-BINDING.md).

Never "AI", never "assistant" in chrome (the user's chat client owns that
word), never anthropomorphise beyond "your agent".

If a turn stops part-way through, say what is true and preserve the person's
words: "Your agent could not finish that. Your words are still here so you can
try again." Never silently reinterpret a failed question or instruction as a
new need.

## Clarifying a sentence

A clarification names the concrete gap as a short question: `20 what?`,
`500 m from where?`, `Which Alexanderplatz?`, or
`No sushi — closest on record:`. It never says the agent failed to understand.

Choice labels state consequences: `€20 per person`, `20 min walk`,
`within 500 m of where you start`, `a place in the room`, `somewhere else`.
They use sentence case, no exclamation marks, no protocol words, and no more
than 60 characters. Say `need`, never `filter`.

Safe guesses are applied and echoed under the row as `read as … · change`:
`read as 10 min walk`, `read as under €15`, or
`measured from the area centre`. The recovery action is always
`Say it differently`; it restores the person's original words and focuses the
composer.

---

## Empty & error states

Each states what's true, then the one thing to do.

- **Empty room** — "Nothing yet. Say anything that would rule a place in or
  out — a condition, a time, how far you can get — and choose who gets to see it."
- **No candidates at all** — "Nothing here fits yet. Widen the area, or drop
  a need." Never "No results found."
- **Impasse** — "Nothing works for all three." Then the ways out, quantified.
  The count block's subline says what the zero is made of: `none confirmed ·
  17 still to check` while unknowns remain, `two needs collide` when several
  needs each rule places out, `one need rules the rest out` when one does.
- **Stale protocol** — "This room is running an older version. Reload to catch
  up." Never a version number in the main UI — that belongs in `{ }`.
- **Offline** — "You're seeing the map as of 9:24. Changes will sync."

## Map exploration

- Return action: **“Back to the area”**.
- Organizer action after panning: **“Search here”**.
- One-place action: **“Bring into the room”**, followed by
  **“Everyone in the room will see it.”**
- Desktop batch action: **“Bring in all here (N)”**, where N is the absolute
  number that will be brought in and never exceeds 40.

## Finding a place, and layers

- Find control: a magnifier button labelled **“Find a place”**, which is also
  the field's placeholder. It finds by name; never offer to find "restaurants
  near you" or any other kind of place.
- Nothing matched: **“No place here goes by that name.”** Never "No results".
- Once a place is chosen the find button says so by inverting and reads
  **“Showing <name>. Find another place.”**, with a `✕` beside it labelled
  **“Stop showing <name>”**. The name itself stays on the map: the place's own
  card takes the suffix **“· found”**, in the same family as “· proposed”,
  “· staged”, “· settled”.
- Layers control: a stacked-planes button labelled **“Layers, none on”** or
  **“Layers, 2 on”**; its rows read **“Buildings in 3D”**, **“Places not in
  the room”**, **“Landmarks”**, **“Transit lines”**.
- “Search here” keeps its own meaning — moving the room's area to the middle
  of the map. Never call finding a place a search in visible copy.

Use **bring in** for moving a place from the map's explore layer into the
room. Never expose “ref”, endpoint names, command names, or pool vocabulary in
the visible copy.

## Starting point

- Own roster line: **“Starting from Rosenthaler Platz”**. Peers get no line.
- Controls: **“Set where you start”**, **“Finish setting where you start”**,
  and, when the browser supports it, **“Use my location”**.
- Map instruction: **“Drag your mark on the map, or use its arrow keys.”**
- Place distance: **“12 min from you”**, never “away”.
- A peer event says only **“Sarah updated where they start from.”** Coordinates
  and labels never appear in peer copy.
- Sharing control: **“Show where you are to the room.”** It is off by default.
- Privacy line: **“Off: only you and the room’s server know your position. On:
  everyone in the room sees it on the map while you are here.”** Name both
  states; never imply that the private address label is shared.
- Sharing events say **“Sarah is showing where they are”** and **“Sarah stopped
  showing where they are.”**

## Opening a room

The three screens before a room, in the order a product would ask.

- **Who and what.** **"Your name"**, then **"What are you trying to do?"**
  with **"In your own words. One outing or several."** underneath. The
  placeholder rotates through the examples in [copy.ts](src/ui/copy.ts).
  The action is **"Work out what that takes"** and its busy line is
  **"Working out what that takes…"**.
- **What it takes.** Headed **"What that takes"**, with **"One place to
  find."** or **"N places to find, in order."** — absolute, never a
  percentage. Each box is **"Step N of M"**; a later one adds **"after that,
  near there"**, because that is what the room will actually do. A box's
  pending rows keep **"From what you said"** and **"Leave out"**. Each step's
  **"Kind of place"** comes from the server. The plan supports up to three
  steps; later ones can be removed before opening. The action is
  **"Open the room"**.
- **The region.** The demo's data boundary is explicit: Spokes is
  **"built to work anywhere"**, but the demo runs on prepared Berlin Mitte
  and San Francisco regions. Tagged **"demo limit"** so nobody mistakes it
  for a feature. Each region gives counts of the classes this plan needs,
  its facts on record,
  and its as-of date — all server-measured.

A failed review says **"Your words could not be read just now. Choose the
kind of place and keep going."** The class selector and room creation remain
available. Clarification choices say **"Pick one"** or **"Pick any that
apply"**, with **"Use these"** for a set. Pending needs are not yet room
facts and do not use works or unsure language.

Inside a multi-step room, **"now"** marks the active step and **"settled on
<name>"** marks completed ones. Steps are sequential, not selectable tabs.
Settling an intermediate step moves the search near that place. A later
proposal needs fresh stances; readiness carries forward. Do not promise plan
editing or reopening completed steps after creation.

## Adding someone

- The control is **"Add someone"**; the dialog says **"Send this link, or let
  them point a phone at the code."**
- The rules are stated, not enforced silently: **"Each link is for one
  person. Once it is used, it stays theirs."** and **"Unused links stop
  working after an hour."**
- A link's state is a phrase, never a status: **"not used yet"**,
  **"Sarah joined"**, **"expired"**.
- Actions are **"Copy link"** / **"Copied"**, **"Share"** when native sharing
  is available, and **"New link"**. Each new person needs a separate link.
- A refusal names nobody: **"This link is already in use. Ask for a new
  one."** Who holds it is the room's business.

The unused-link expiry is not a session countdown. A claimed invite is bound
to that browser and can recover its participant there. Do not describe it as
a reusable group link or promise that copying it transfers an existing seat.

## Being handed a link

- Third person for whoever started it — **"Alex is working this out with a
  group."** — then the goal verbatim, plan step titles and kinds of place,
  and **"1 person is in so far."** The preview does not reveal private needs
  or the full roster.
- Accounts are offered and refused in the same breath rather than hidden:
  **"Log in"**, disabled, under **"The demo has no accounts. Join as a guest
  instead."**
- The name field is **"Your name"**, the action **"Join"**, and its busy
  state **"Joining…"**.

## Distance referents

- Scope needs name their measuring point: **“within 500 m of U
  Alexanderplatz”**, **“within 10 min walk of Café Einstein”**, and **“within
  800 m of where you start”**.
- An unresolved place is plain and pending: **“a place no longer in the
  room”** or **“an unknown landmark”**. It never reads as a failure.
- A participant position the reader may not see is always **“where someone
  starts from”**. Never combine the participant's name with that phrase or
  imply where the position lies.
- Landmark disambiguation asks **“Which Alexanderplatz did you mean?”** and
  offers at most three `name · place type` choices.

## Tone

Plain, short, declarative. No exclamation marks. No "Oops". No emoji anywhere
in chrome. Sentence case everywhere except the uppercase section labels
(`WHAT MATTERS`, `TWO WAYS OUT`, `HOW IT GOT HERE`).

Second person for the user's own things ("your agent", "yours"), third person
for others ("Sarah added"), never first person — the app has no voice of its own.

## The pipeline ring

The count block's head row carries one ring with `N/M` while the room is
checking places for the stated needs. Its accessible text says "checked 122
of 179 places for 3 needs", with the mix in flight — "· 8 reading · 12
checking". Reading is a place's site, menu or a search being read; checking
is the evidence going against your needs. Out of budget reads "paused for
now" in accessible text. Drained: the ring and numbers disappear without
changing the block's height. "Fetching", "processing",
"pipeline", "queue" and "stage" are wire words and stay behind `{ }`.

The place panel says which stage a place is in, in one control at the top
left: "reading the record…" while the first read runs, then "waiting its
turn…", "reading what the place publishes…", "checking it against your
needs…". One ring beside the words, no spinner. The words are not
decoration — reduced motion stands the ring still, and they are then the
whole signal.

Opening a place fills the panel progressively: what is cached shows at once,
then each step of the fast track lands in place and renames the control —
"waiting its turn…", "reading the site…", "checking against your needs…", "looking at the
photos…", "asking the web…" — and, after three seconds without the plan
closing, "still reading the site…".

When nothing is running the same control becomes the way to ask for a fresh
read. It is labelled "Look it up again" and says what the last read left
behind: "looked up just now · 3 facts changed", "looked up just now ·
nothing new", "looked up 4 min ago", or "what the record says" when the
record has no time on it. No photo is ever announced separately; a place
being looked up is said once, here.

Two groups in the panel lead with a count and fold the rest: "hours for 7
days on record" for the week, and "12 on record · 3 not on record" for the
facts nobody asked about. Absolute counts, a middot between them, never a
percentage and never "show more".
