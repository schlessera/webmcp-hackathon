# Spokes — copy lexicon

The app is **domain-agnostic**. The same screens must work for a dog walk, an
exhibition, a film in a given language, a quiet coworking room, or dinner.
Copy is where domain assumptions leak back in, so it is specified here.

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
- An agent **acted**, **staged**, or **proposed**. It never "suggests" — the
  word is too weak for something that changed the map.
- You **commit** a place. The group **agrees**.

---

## Counting

The count block is the single most-read element. Always **absolute, never
percentage**, and always paired with the total on second line.

```
6            of 34 · 4 of them likely · 3 unsure
still work
```

- 0 → the block turns `--spoke-unsure` and reads `0 / still work`, with the
  subline naming the collision: "two needs collide".
- 1 → "1 still works" (verb agrees).
- The big number counts confirmed places **and** likely ones: a guess with a
  reason is still an option the room can act on. The subline breaks that
  number down — "4 of them likely" is part of the six, never an addition to
  it. **likely** and **unlikely** are the only words for a guess; never
  "probably", "maybe", "estimated". A guess is drawn dashed.
- Unknowns are counted separately and never folded into the total:
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
"**+3** if 'step-free' went optional" — not "Relax step-free to see more".

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
domain-specific control or label.

## Privacy phrasing

This is the highest-stakes copy in the app. A private need's **effect** is
public; its **content** is not. Never leak the content, and never pretend the
effect didn't happen.

- ✅ "A private condition ruled two out"
- ✅ "Someone can't travel far" *(shown only to the person who said it)*
- ✅ "Joe's agent holds one condition back"
- ✅ "The room only learns that *one condition about distance exists* — not what it is"
- ❌ "Sarah's mobility requirement ruled two out"
- ❌ "2 places hidden" *(hides that anything happened)*

Say **who** only when the person made it public. Otherwise "someone".

## In progress

Work the room is doing is stated as what it is doing, never as a bare
"Loading…" (2026-09-03).

- A need just said: `checking 12 places…` on the row; `checking 12 for
  step-free access` in the count block. Zero places to check: `checking…`.
- The whole area still arriving: `adding places · 120 of 343` in the count
  block, absolute both sides. Not "loading", and never a percentage.
- A place being looked up: `looking it up…` in the panel; a ring on the map.
- The hover card on the map carries the place's name and first photo, nothing else — no verdict, no numbers.
- The agent: `reading what you said…` then `updating 40 places…`. Never
  "thinking", never "processing".
- Nothing under a second shows a state at all; a ring that flashes for a
  glance is noise.
- The room refining on its own: `looking up 12 · 40 to go` in the count
  block while places are being worked on, and a quiet line under it,
  `checked 84 places for 3 needs · 12 to go`. Out of budget: `paused for
  now` — nothing is wrong, the room is waiting its turn. Never "AI is
  searching", never a spinner without a number.
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

- "Your agent screened 6 places for you" — inside the grant
- "Your agent staged it; only this gesture applies it" — beyond the grant
- "Joe's agent accepted for him" — acted with delegated authority

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

## Opening a goal-first room

- The optional field asks **“What are you planning?”** and uses a concrete
  example such as **“lunch near Sarah's station”**. The person's words remain
  the room goal verbatim.
- A non-empty goal is reviewed under **“From what you said”** before anything
  is stored. Parsed needs are pending rows with **“Leave out”**; they do not
  use works or unsure language before the room exists.
- The review action is **“Review the room”**. The final action remains
  **“Open the room”**; its busy line is **“Opening the room…”**.
- The quiet selector label is **“Kind of place”**. Its option labels and
  counts are server-authored.
- When the review cannot be reached, say **“There is nothing else to add yet.
  Choose the kind of place and keep going.”** The class selector and room
  creation remain available; never expose a status code or endpoint name.
- A clarification gives its server-authored choices and **“Or say it in your
  words”** with **“Use this”**. A choice's needs join the pending rows; the
  person can still leave any of them out.
- The invites screen repeats the room goal above the per-person links.

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

The count block carries one line and one ring while the room is checking
places for the stated needs: "checked 122 of 179 places for 3 needs", with a
quiet clause naming the mix in flight — "· 8 reading · 12 checking". Reading
is a place's site, menu or a search being read; checking is the evidence
going against your needs. Out of budget reads "paused for now". Drained: the
ring and the line disappear; nothing lingers. "Fetching", "processing",
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
