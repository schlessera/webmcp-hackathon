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
6            of 34 · 3 unsure
still work
```

- 0 → the block turns `--spoke-unsure` and reads `0 / still work`, with the
  subline naming the collision: "two needs collide".
- 1 → "1 still works" (verb agrees).
- Unknowns are counted separately and never folded into the total:
  "3 unsure" means the data is missing, **not** that the place failed.
- Guesses are counted apart too: "4 likely" means a guess with a reason
  (a word on the menu, the kind of place) says these would work. **likely**
  and **unlikely** are the only words for a guess; never "probably",
  "maybe", "estimated". A guess is drawn dashed.

## Deltas

Always signed, always relative to the current set, never a percentage.

- `−19` a need ruled out 19 places
- `+3` relaxing this would bring back 3
- `34→15` in a history row

Phrase the offer as a consequence, not an instruction:
"**+3** if 'step-free' went optional" — not "Relax step-free to see more".

---

## Confidence

A guess carries its confidence as a word, never a number: **fairly sure**
(the source would nearly verify it), **likely** / **unlikely** (a reasoned
guess), **a guess** (thin evidence). The evidence itself is quoted where
there is one: "the menu mentions a vegan bowl".

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
- A place being looked up: `looking it up…` in the panel; a ring on the map.
- The agent: `reading what you said…` then `updating 40 places…`. Never
  "thinking", never "processing".
- Nothing under a second shows a state at all; a ring that flashes for a
  glance is noise.

## Agent phrasing

Name the actor and the authority in the same breath:

- "Your agent screened 6 places for you" — inside the grant
- "Your agent staged it; only this gesture applies it" — beyond the grant
- "Joe's agent accepted for him" — acted with delegated authority

Never "AI", never "assistant" in chrome (the user's chat client owns that
word), never anthropomorphise beyond "your agent".

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
- A capped viewport says **“Zoom in to see every place here.”**

Use **bring in** for moving a place from the map's explore layer into the
room. Never expose “ref”, endpoint names, command names, or pool vocabulary in
the visible copy.

## Tone

Plain, short, declarative. No exclamation marks. No "Oops". No emoji anywhere
in chrome. Sentence case everywhere except the uppercase section labels
(`WHAT MATTERS`, `TWO WAYS OUT`, `HOW IT GOT HERE`).

Second person for the user's own things ("your agent", "yours"), third person
for others ("Sarah added"), never first person — the app has no voice of its own.
