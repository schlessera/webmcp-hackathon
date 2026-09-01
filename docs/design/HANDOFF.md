# Spokes redesign — handoff

Everything Claude Code needs to patch `apps/web` to the redesigned mapview.
Design source of truth is `Spokes - Mapview Redesign.dc.html` (in this folder).

## What's here

| File | Goes to | What it is |
|---|---|---|
| `tokens.css` | `apps/web/src/tokens.css` | Frozen palette, type, geometry, motion. Replaces the `:root` block in `styles.css`. |
| `CLAUDE.md` | repo root (merge) | The invariants. Read first. |
| `SPOKES-UI.md` | `apps/web/` | Anatomy, states, do/don't per component. |
| `COPY.md` | `apps/web/` | Domain-agnostic wording rules. |
| `FACETS.md` | `packages/server/` | **The blocking dependency** — a server capability that doesn't exist yet. |
| `fonts/README.md` | `apps/web/public/fonts/` | Self-hosting Bricolage Grotesque. |
| `../Spokes - Mapview Redesign.dc.html` | `docs/design/` | The mockups — 138 KB, imports whole. |

## Order of work

1. **Read `CLAUDE.md`.** Thirteen invariants; each explains why. Most rework
   on this codebase will come from breaking one unknowingly.
2. **Land `tokens.css`** and delete the old `:root`. Nothing else should
   define a colour.
3. **Build the shell** — header out of the status bar, edge-to-edge map,
   scrolling brief, pinned composer (`SPOKES-UI.md` §1–§5, mockup `4a`).
4. **Ship `facets` + `activeNeeds` server-side** (`FACETS.md` §1–§2). Until
   this lands, suggestion pills and details groups can only be faked, and
   faking them means hardcoding domain chips — the exact thing being removed.
5. **Then** the flow states (`7a`–`7d`), details panel (`8a`), `{ }` drawer
   (`8b`), consent ladder (`8d`), desktop (`8c`).

## The one thing to get right

The app must be **agnostic about what problem it solves**. Same screens for a
dog park, an exhibition, a film in a given language, a quiet coworking room.
Every control is generated from server data; the client never branches on
domain. If a domain word appears in chrome, or a filter is hardcoded, the
redesign has been undone regardless of how it looks.

## Palette, in one line
Green `#2c6b52` works · terracotta `#b05f2c` unverified · violet `#7d6396`
who-may-see · woad `#3d5a80` who-moved · ink `#334136` on cream `#fdf8ee`.
Ruled out is a small grey dot with no colour at all.

---

## Where these files landed in this repo

The table above is the designer's mapping. Applied here as:

| Handoff file | Repo path |
|---|---|
| `CLAUDE.md` | merged into root `CLAUDE.md` (§ "Spokes UI invariants") |
| `tokens.css` | `apps/web/src/tokens.css` (imported by nothing yet) |
| `SPOKES-UI.md` | `apps/web/SPOKES-UI.md` |
| `COPY.md` | `apps/web/COPY.md` |
| `FACETS.md` | `apps/server/FACETS.md` — this repo has no `packages/server`; the server is `apps/server` |
| `fonts/README.md` | `apps/web/public/fonts/README.md` |
| `Spokes - Mapview Redesign.dc.html` | `docs/design/` — 133,032 bytes, complete |
| `Spokes - Current UI.dc.html` | `docs/design/` — the pre-redesign baseline |
| `support.js` | `docs/design/support.js` — canvas runtime both mockups import |
| project `github.md` | `docs/design/SYNC.md` |

Two edits were made to `SPOKES-UI.md` on import, both frame ids retired when the
mockup was trimmed to canonical frames: `9a`–`9d` became `9b`, and `3g`/`4a`
became `4a`. The canonical set is `4a`, `7a`–`7d`, `8a`–`8f`, `9b`; any other id
in any doc is stale.
