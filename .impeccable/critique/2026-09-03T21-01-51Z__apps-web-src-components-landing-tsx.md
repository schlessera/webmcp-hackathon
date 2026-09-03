---
target: the landing page
total_score: 21
max_score: 32
na_heuristics: 9,10
p0_count: 0
p1_count: 2
timestamp: 2026-09-03T21-01-51Z
slug: apps-web-src-components-landing-tsx
---
Method: dual-agent (A: critique-a · B: critique-b)

Target: the Spokes landing page (Persuade surface) — `apps/web/src/components/Landing.tsx` + `apps/web/src/landing.css`, live at `http://127.0.0.1:5173/`.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Sticky bar takes the ink ground on entering the second half and the `{ }` reveal animates; but a 10,488px desktop / 14,419px mobile page gives no sense of its own length, and "Start a room" hints nothing about what follows. |
| 2 | Match System / Real World | 3 | Cream half speaks plainly; the lede's "converge on a place" is engineer-speak, and the ink half assumes protocol literacy by design. |
| 3 | User Control and Freedom | 3 | CTA and wordmark always reachable in the sticky bar; no way to jump between the two halves, and "Got a link? Open it." offers no input to open one. |
| 4 | Consistency and Standards | 2 | `:653` says "19 tools", `:518` says "Twenty-two"; the lists total 22. Two of three "Start a room" buttons render the wrong size/colour from a cascade tie. |
| 5 | Error Prevention | 3 | One action, little to get wrong; the delta chip "+9 if 'vegetarian options' went optional" (`:292`) cites a need absent from the rows drawn beside it. |
| 6 | Recognition Rather Than Recall | 3 | Legend present, every beat tied to a real screenshot; a judge must recall "22" from 4,700px earlier to catch the "19". |
| 7 | Flexibility and Efficiency | 2 | Two audiences, two halves, no accelerator: no anchors, no `{ }` control in the bar, first "WebMCP" at y≈4,700. |
| 8 | Aesthetic and Minimalist Design | 2 | Cream half is a 4. Ink half is ~1,900 words whose `h2`s (13px mono) sit *under* 20px display `dt`s — the rubric words a judge scans for are the quietest text on screen. |
| 9 | Error Recovery | n/a | Static page; error states live in the room. |
| 10 | Help and Documentation | n/a | Persuade surface; five doc links present, not a help system. |
| **Total** | | **21/32 (66%)** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment.** Authored for Spokes — but only the top half. A neighbouring product could not ship the cream half unchanged; it could ship most of the ink half.

Product-specific: the hero plate tilted at the count block's own angle with a caption in the product's counting voice (`:143-163`); the "What matters" aside built from four real need rows, two private, with deltas (`:203-233`) — the thesis stated in component vocabulary with no prose; all seven beats drawn in the room's own chrome (`:280-306`, `:343-365`, `:410-426`); the mark legend (`:452-461`); and the `{ }` reveal (`:500-524`, `landing.css:399-446`), which turns CLAUDE.md §6 into page structure while the sticky bar changes ground.

Category-generic: the four-tile stat row (`:634-657`) is the SaaS big-number grid. The six ink sections are, by heading, the hackathon judging rubric — structurally a submission form styled in the brand, not a page composed for a reader. The two-column `dl` of dense paragraphs is README shape.

Net: the top ~45% is exceptional and specific; the bottom ~55% is generic in form even where its content is specific.

**Deterministic scan.** `detect.mjs --json apps/web/src/components/Landing.tsx` returned `[]`, exit 0 — zero findings. The static sweep is equally clean: zero raw hex/rgb/hsl outside tokens, all 27 `font-family` and 47 `font-size` declarations token-driven, all 7 `<img>` tags carrying width/height/alt/loading/decoding, exactly one `h1` with no heading-level skips across 20 headings, zero `!important`, one `z-index` (3), zero emoji, zero exclamation marks. Browser: no page-level horizontal overflow at 1440px or 390px, zero console errors, every tap target measured at 44px or above.

The detector caught one thing the design review did not: `landing.css:431,439` runs bespoke 640ms/760ms transitions on the `{ }` reveal, outside the four sanctioned animations. `prefers-reduced-motion` zeroes them correctly (`landing.css:443-445`), so this is a documented deviation rather than a defect.

The two assessments disagree on the horizontal scrollers. B measured them as contained by design (`.ld-code`, `.ld-table-wrap`) with the page itself never scrolling sideways — correct, and the CLAUDE.md rule is satisfied. A measured what a reader actually sees at 390px: the sources table truncating cells to "de…", "lin…", "th…". Not an overflow bug; a legibility one.

**Visual overlays.** Not available. The in-page overlay was skipped because port 8400 was held by the active live session at the time; no overlay exists in any browser tab. Evidence above comes from the CLI detector, DOM measurement, and 25 screenshots across both widths.

## Overall Impression

The first half of this page is the best argument the project makes anywhere: it does not describe the product, it is built from it. Then the reveal fires, and the page stops being a page and becomes the submission form — six rubric headings, 1,900 words, a 22-row list, set in a hierarchy that makes the headings smaller than the body. The single biggest opportunity is not adding anything. It is giving the ink half the same compositional care the cream half already got, and fixing the one number a judge will actually check.

## What's Working

1. **Evidence in the product's own vocabulary.** The "What matters" aside and the beats' count blocks are made of the same `.need-row`, `.count-block` and `.mark` the room ships. The page cannot drift from the product because it is the product.
2. **The `{ }` reveal as argument.** The handle rising from a cream lip while the sticky bar turns ink sells the two halves as one object, and makes the "nothing protocol-shaped in the main UI" invariant legible without a sentence of explanation.
3. **Discipline about truth.** "What it does not claim" (`:786-823`), measured numbers, no logos, no testimonials, no uptime. It obeys PRODUCT.md's do-not-invent list exactly, and reads as confidence rather than modesty.

## Priority Issues

**[P1] The one number a judge will check is wrong.**
`Landing.tsx:653` reads "19 tools, one command bus". `:518` reads "Twenty-two tools are registered", the two lists total 10 + 12 = 22, and the README badge, PRODUCT.md and the protocol manifest all say 22.
*Why it matters:* it sits in the "Execution" stat grid, where a judge goes to verify the claim. A number that contradicts the page 4,700px above it costs more credibility than a missing feature.
*Fix:* set it to `22` with the sub-line `10 negotiation · 12 spatial`, or relabel whatever 19 actually counts.
*Command:* `/impeccable clarify`

**[P1] Nothing reassures the visitor at the moment they act.**
The hero button says "Start a room" and nothing else. No account question answered, no city named — "Berlin" first appears at y≈4,300, "San Francisco" only inside a stat sub-line at y≈6,500. The existing `.ld-cta-note` (`:129-132`) speaks only to people who already hold a link.
*Why it matters:* on a Persuade surface the click is the whole job, and the visitor is asked to commit with zero information about what happens next.
*Fix:* one line beside the hero button in COPY.md voice: "No account. Choose Berlin or San Francisco, share one link; the group joins as guests."
*Command:* `/impeccable clarify`

**[P2] Two of three CTAs render wrong, from one cascade tie.**
`.ld-btn-big` (`landing.css:116`) and `.ld-btn-ink` (`:685`) both lose to `.btn` (`styles.css:1189`). Same specificity `(0,1,0)`; `main.tsx:3` pulls App → Landing → `landing.css` before `main.tsx:5` loads `styles.css`, so `styles.css` wins on order. Measured result: the hero button computes 12.5px at 97×44 instead of the declared 15px title size, so the page's primary action is the same size as the top-bar one, and the closing CTA renders cream instead of `--spoke-works-pop`.
*Why it matters:* the loudest moment on the page is silently downgraded to a secondary button, and the final ask loses its colour.
*Fix:* scope both as `.landing .ld-btn-big` / `.landing .ld-btn-ink`, the pattern already used at `landing.css:279`.
*Command:* `/impeccable polish`

**[P2] The page ends on its weakest material.**
Reading order closes with a licence table and "a DNS-rebinding window remains", then the button. Peak-end says the last thing read carries the memory.
*Why it matters:* the page spends its strongest asset first and its weakest last, which is exactly backwards for a surface asking for a decision.
*Fix:* move "Where the facts come from" and "What it does not claim" ahead of "Potential impact"; close with the links row and the CTA.
*Command:* `/impeccable layout`

**[P2] The ink half inverts its own hierarchy.**
Its section headings (`.ld-wire-h`, 13px mono) are set smaller than the `dt` terms beneath them (`.ld-facts dt`, 20px display). The words a judge scans for — "WebMCP leverage", "Execution", "Potential impact" — are the quietest text on screen, and there are no anchors to reach them.
*Why it matters:* the half of the page written specifically for judges is the half hardest for a judge to skim.
*Fix:* give `.ld-wire-h` the display h2 size, drop `.ld-facts dt` to title size, and add one mono strip of the six section names as in-page anchors under the reveal.
*Command:* `/impeccable typeset`

## Persona Red Flags

**Jordan (First-Timer).** "Take me there" (`:424`) is a real green chip in the DOM that does nothing when clicked; the toggle-shaped need rows likewise. Meets "converge" in the lede and "counterfactual" at `:774`. Never told whether an account is needed.

**Riley (Skeptic / Judge).** Hits "19" against "Twenty-two". Reads "+9 if 'vegetarian options' went optional" (`:292`) beside rows about outdoor seating and step-free access. Reads "forty places" (`:386`) beside a drawn "of 21". Sees "Got a link? Open it." with no input to open one. Every beat carries a dead `data-side="text"` attribute.

**Casey (Mobile / Low-Bandwidth).** 14,419px is roughly 17 screens. Two horizontally scrolling boxes, one truncating table cells to two characters. The sticky bar consumes 64px throughout, and two "Start a room" buttons sit within 300px of each other with the more reachable one undersized.

**Judge with 90 seconds** (project-specific). The first "WebMCP" appears at y≈4,700 on desktop. The rubric words are the smallest headings on the page. The tool list and the "cannot grant consent" proof sit below the ink fold.

**Organizer planning a real outing** (project-specific). The two supported cities are named only in a stat sub-line. Never told that guests join by link without an account. "Agree, then go" (`:400-426`) is the shortest beat with the least evidence, though it is the moment the product exists for.

## Minor Observations

- Global focus ring uses `--spoke-act`, a semantic colour spent on a non-semantic state.
- The 68px pop-green `{ }` handle is the loudest element on the page while DESIGN.md says that control must never be prominent. The landing-page exception is defensible but nowhere stated.
- `.ld-marks` reverts to one column at ≥960px (`landing.css:734`), so the legend towers over the paragraphs it explains.
- `text-wrap: balance` on an `h1` that also carries a hard `<br>`; `scroll-behavior: smooth` with no anchors to smooth-scroll to; `role="list"` applied to divs.
- Bespoke 640ms/760ms reveal transitions sit outside the four sanctioned animations, though reduced-motion is handled correctly.
- Contrast passes everywhere measured (5.66:1 to 8.93:1). Copy discipline is excellent: zero emoji, zero exclamation marks, no domain nouns in chrome.

## Questions to Consider

1. Why describe press-and-hold when the hero could be the seeded room, live?
2. What if the top bar were the room's own bar, and `{ }` opened this page's ink half?
3. Should the rubric words be the cream half's `h2`s, leaving the ink half as pure verification?
4. Could one live count block replace the four static stat tiles?
5. Why a legend at all, when every mark could carry its meaning on hover the way the room's rows do?
