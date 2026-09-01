# Claude Design project sync record

Source project: `Mapview UI redesign mockups`
<https://claude.ai/design/p/62e29a7a-5606-4813-ae1e-1e6d77298bd5>

Re-synced 2026-09-01, after the mockup was trimmed to canonical frames and the
action accent moved from indigo to woad `#3d5a80`.

```
repo: schlessera/webmcp-hackathon
branch: main
path: apps/web
```

## Last sync


date: 2026-09-01T09:20:00Z

### Updated in this project

- Recreated the current Spokes web client (desktop ≥980px and the 620px demo window) from `apps/web` source, token-for-token against `styles.css`.
- Redesigned the mapview: tab dashboard replaced by a live toggleable "brief", data-discovered facets instead of predefined filters, details panel that pushes the map.
- Wire view, build ids, tool log and revision counter moved behind one `{ }` slide-over drawer.
- Added ChatGPT side-by-side, phone, and four non-food domains (park, museum, cinema, coworking) to prove domain agnosticism.

## Screen map

| Project screen | Built from |
| --- | --- |
| Spokes — Current UI.dc.html · A (desktop) | apps/web/src/App.tsx, components/MapView.tsx, components/CandidateSheet.tsx, components/RequirementsPanel.tsx, src/styles.css |
| Spokes — Current UI.dc.html · B (620px) | apps/web/src/App.tsx, components/DecisionsPanel.tsx, components/MapView.tsx, src/styles.css |
| Spokes — Mapview Redesign.dc.html · 1a–1e | apps/web/DESIGN.md, src/styles.css (tokens), src/spatial-types.ts, components/*.tsx (semantics), docs/PRODUCT-CONCEPT.md |
| Scenario data (names, roles, room) | apps/server/src/seed.ts, scripts/demo-overlay.json, packages/contracts/data/berlin-mitte-venues.json |

> The `1a–1e` row above is stale: those exploration frames were removed when the
> mockup was trimmed. The file now holds `4a`, `7a`–`7d`, `8a`–`8f`, `9b` only.
