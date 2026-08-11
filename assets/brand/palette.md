# Brand palette — ilinxa capture

Single source of truth for the banner, social preview, and diagram colors. It
mirrors the app's shipped theme tokens so the docs and the product read as one
system.

| Role | Hex | Usage |
|---|---|---|
| Primary (coral) | `#CC785C` | Links, emphasis, badges, diagram accent, active state |
| Ink | `#1A1A18` | Dark-theme background, banner background |
| Paper | `#F0EEE6` | Light-theme background, banner text on dark |
| Neutral | `#6B7280` | Secondary text, diagram lines, muted UI |

Rules: coral is the only accent — use it sparingly for emphasis, never as a
background fill. Every asset must stay legible on GitHub's dark theme, so test
both themes before committing. Diagrams use the neutral grey for lines and coral
for the highlighted path only.
