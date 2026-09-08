---
version: 1
slug: "apps-web-src-components-onboarding-tsx"
primary_target: "apps/web/src/components/Onboarding.tsx"
related_targets: ["apps/web/src/components/RegionDialog.tsx", "apps/web/src/styles.css"]
---

# Onboarding secondary controls

Mode: Operate. Refined 2026-09-08. Preserve the existing Field Notebook identity
and the goal → plan review → demo region flow. DESIGN.md remains authoritative.

Back, Change what you said, clarification actions, and region choices reuse the
app's `.btn` foundation: cream paper, neutral borders, rounded corners, printed
shadows, and Bricolage action text. Removal controls reuse `.btn-text` with quiet
ink, underlined labels, and a small drawn minus. Row editing has less visual
weight than navigating or submitting the plan.

All secondary controls have deliberate hover, pressed, disabled, and keyboard
focus treatments, with at least 44px interaction height. Step order and relation
copy wrap together beside the removal control on narrow screens. Need rows use
a flexible label column so long labels do not push their removal control outside
the card. Primary actions, labels, and handlers retain their existing behavior.

The landing's `planning-mobile.webp` is recaptured from the actual plan-preview
flow; only its model transport is scripted. It documents the new controls in
the first journey section and in the full-screen original.

Build, typecheck, and all 14 landing tests pass. A batched browser check at 1180,
390, and 330px exercised ask, plan review, clarification, and region selection;
checked removal, Back, hover, keyboard focus, and disabled clarification actions;
and measured no horizontal overflow and at least 6.26:1 secondary-control text
contrast. Evidence is retained at `/tmp/spokes-onboarding-buttons/`.
