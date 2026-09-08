---
target: the landing page
total_score: 26
max_score: 32
na_heuristics: 7,9
p0_count: 0
p1_count: 0
target_identity: "file:/home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx"
target_fingerprint: "sha256:98f214b2e9cdeb08f55bcedbbec7d88ae7d407c94c7788c5ea5e0cbb640c739b"
target_path: /home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx
timestamp: 2026-09-07T20-55-18Z
slug: apps-web-src-components-landing-tsx
closed: true
---
Method: dual-agent (A: /root/design_review · B: /root/detector_evidence)

**Spokes has a strong visual identity. The biggest improvements are earlier demo qualification and more selective screenshot storytelling.** The cream, ink-green, Bricolage typography, semantic marks, and printed shadows feel authored for this product. Preserve that identity.

Reviewed the current landing page at desktop, tablet, and phone widths, including 330px. These findings concern the landing page and its immediate navigation; room creation and live group negotiation were not exercised.

**Design health: 26/32 — Good.** No blocking or major usability issue was found in the inspected landing interactions.

| # | Heuristic | Score | Assessment |
|---|---|---:|---|
| 1 | Visibility of system status | 4 | Start, anchors, and privacy disclosure give clear feedback. |
| 2 | Match with the real world | 3 | Human language; an external agent's optional status is explained late. |
| 3 | User control and freedom | 4 | Back, native disclosures, and screenshot originals work. |
| 4 | Consistency and standards | 4 | Cohesive visual language and predictable actions. |
| 5 | Error prevention | 2 | The two-region demo restriction is far below the first Start action. |
| 6 | Recognition over recall | 3 | Numbered steps help; supporting controls can be distant from their explanation. |
| 7 | Flexibility and efficiency | n/a | Expert accelerators are not required for this Persuade surface. |
| 8 | Aesthetic and minimalist design | 3 | Strong hierarchy; repeated full-height screenshots slow the narrative. |
| 9 | Error recovery | n/a | No applicable landing submission/error state was inspected. |
| 10 | Help and documentation | 3 | Useful FAQ and references; trial qualifications arrive late. |
| | **Total** | **26/32** | **Good; eight applicable heuristics.** |

**What works**

- **The real product supplies the proof.** The desktop hero shows the group's needs, map, count, and evidence together. It makes the shared decision visible.
- **The privacy story has emotional and factual weight.** “Not every reason needs an audience” names the social problem clearly. The linked explanation covers processing and inference without making an absolute secrecy promise.
- **Starting stays easy on mobile.** The primary action remains visible in the sticky header. Start, Back, keyboard skip, section anchors, and privacy disclosure worked. No horizontal overflow appeared at 330, 390, 768, 1280, or 1440px.

**Priority changes**

1. **[P2] Put the demo limits beside the first Start button.** The hero invites visitors to plan an outing, but the Berlin Mitte / San Francisco SoMa restriction appears in a FAQ section beginning roughly **8,800px down the 390px-wide page**. An organizer can start with an unsupported location in mind.

   **Fix:** add “Interactive demo for Berlin Mitte and San Francisco SoMa” beside the hero action, and clarify nearby that an external agent is optional. Keep the detailed FAQ and existing goal-first flow.

   Source: [hero and trial reassurance](/home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx:86), [regional qualification](/home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx:197). Suggested command: `$impeccable clarify`.

2. **[P2] Make each supporting screenshot reveal its decisive control sooner.** At 390px, each portrait image is about **733px tall**, and the four-step walkthrough takes about **5,000px**. Readers repeatedly scroll through map area before reaching the visibility menu, impasse choice, or arrival controls. On desktop, the same captures shrink to about **278px wide**, making their small labels harder to read.

   **Fix:** keep the full map hero and all four decisions. Show clearly identified crops of the relevant controls in supporting figures, preserving enough context and a visible “View full screen” link to each authentic original. The aim is to put the claim and its proof together.

   Source: [supporting figures](/home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx:14), [image sizing](/home/alain/dev/webmcp-hackathon/apps/web/src/landing.css:63). Suggested command: `$impeccable layout`.

3. **[P3] Show one concrete agent contribution.** The dark technical section explains agent authority and shared commands carefully, but its evidence is prose and documentation links. A builder or challenge reviewer still has to imagine what an agent actually changes.

   **Fix:** replace some of that prose with one compact, authentic example of an agent suggestion awaiting review or an agent action changing the visible room. Keep protocol details in the technical section and use an existing valid capture or a fresh real interaction.

   Source: [agent section](/home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx:168). Suggested command: `$impeccable shape`.

**Cognitive load and emotional journey**

Cognitive load is moderate: two checklist weaknesses are working memory and progressive disclosure. The relevant screenshot controls can be far from their explanation, while detailed operating rules precede basic trial qualifications. No ungrouped decision point exceeded four distinct choices.

The hero opens confidently, and the private-needs message provides the emotional peak. Repeated portrait maps slow the middle. The agreed-place outcome provides a satisfying resolution; tighter evidence would help readers reach it sooner.

**Persona red flags**

- **First-time organizer:** can start easily before learning the demo's geographical limits or that an external agent is optional.
- **Distracted mobile visitor:** has comfortable primary controls, but must scroll through repeated maps to understand each new capability.
- **Builder or challenge reviewer:** can find technical documentation, but lacks a compact visual demonstration of an agent's contribution.

**Minor observations and detector evidence**

Screenshot enlargement needs a visible touch cue; its accessible name and desktop cursor already explain the behavior. The technical introduction and footer also have long desktop lines worth tightening in a typography pass.

The CLI detector returned **zero findings** for `Landing.tsx`. Browser detection reported **five flagged records across four rule categories**: line length, cream palette, clipped overflow, and layout transition. The cream palette is an explicit brand commitment. Clipping and transition signals did not establish a visible product defect. The [technical introduction's reading width](/home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx:174) is a minor typography improvement; the [single attribution line](/home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx:224) is lower priority. The detector does not measure the sequencing and screenshot issues above.

The browser also logged a React development warning about `fetchPriority` on the [hero image](/home/alain/dev/webmcp-hackathon/apps/web/src/components/Landing.tsx:98). Treat it as implementation cleanup; the image loaded and no uncaught page error was recorded.

**Questions to consider**

What must an organizer know before trying the demo, and which rules can wait until the room? Which single agent interaction would demonstrate Spokes most clearly? Can each supporting image show its decisive control alongside the claim?
