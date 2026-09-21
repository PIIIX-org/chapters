# Gap Report — Chapters Design System (Loop 3 Audit)

> Date: 2026-09-21  
> Target: `chapters-app` (Tool-Shaped Web Console)  
> Direction: **Observatory Bridge**

---

## Gaps Discovered During System Build

| # | Discovered Gap | Initial Status | Closed With Value / Token | Destination |
|---|---|---|---|---|
| 1 | **Secondary Light Theme Absence** | Initially omitted in Loop 2 DIRECTION draft under dark-only assumption | Re-introduced full Vellum secondary light palette (`--substrate: #F7F6F2`, `--elevated: #FFFFFF`, `--border: #DDD8CE`) to prevent breaking users who require light mode. | `tokens.json`, `sheet.html`, `DIRECTION.md` |
| 2 | **Data States Coverage** | 9 data states required by `TOOLS.md §4` were conceptually stated but lacked explicit token overrides | Added concrete semantic styling for: Empty radar, Loading Tree-sitter progress bars, Git 401 Error banners, Permission Denied cards, and Yjs CRDT conflict resolution indicators. | `sheet.html`, `tokens.json` |
| 3 | **Focus Ring Ratio on Accent** | Focus ring on accent teal buttons risked low contrast if using teal itself | Defined dual-ring focus behavior: `outline: 2px solid var(--focus); outline-offset: 2px;` with background offset spacer to ensure 3:1 visibility across both dark and light substrates. | `sheet.html`, `DIRECTION.md` |
| 4 | **Touch Fallback for Hover Affordances** | Several table rows and tree nodes relied solely on hover | Defined explicit permanent chevron pips and active state styles for touch/mobile tablet displays where hover events do not exist. | `sheet.html`, `DIRECTION.md` |
| 5 | **Tabular Numbers Specification** | Telemetry metrics in topbar and HUD required non-proportional width | Declared `font-variant-numeric: tabular-nums` globally across all telemetry readouts and line numbers in `tokens.json`. | `tokens.json`, `sheet.html` |

All gaps have been closed directly in `tokens.json`, `DIRECTION.md`, and verified live in `sheet.html`.
