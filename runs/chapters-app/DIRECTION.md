# DIRECTION.md — Chapters Web Console (chapters-app)

> **Phase**: Loop 2 (Craft) — Completed for Gate B Review  
> **Target Surface**: `chapters-app` (Primary Authenticated Web Application)  

## Concept and why it won
**Concept 1 / 3 Hybrid: Observatory Bridge (Astrocognitive Command Console)**
It won because it perfectly matches the cognitive density required by power users while delivering an unforgettable identity ("observatory of team thought"). It gives the operator zero-latency keyboard execution (from the cockpit concept) alongside spatial wayfinding (from the observatory concept).

## Collision or subversion
*High-precision astronomic telemetry colliding with a zero-distraction engineer workstation.* (Structural parent: Aerospace Flight Deck / Optical Observatory).

## Surface class · platform mode
`tool-shaped` · `neutral` (16:10 Desktop Canvas, 1440×900 Baseline Frame).

## Style-under-density line
*At forty rows or five hundred nodes, the canvas groups into hierarchical Louvain nebula hulls, metadata shrinks to 11px mono coordinates without loss of legibility, and information displays in compact 24px micro-cells with monospaced telemetry values.*

## Palette
- **Substrate**: `#070A0F` (`oklch(12% 0.015 250)`) / Foreground: `#E2E8F4` (`oklch(93% 0.015 240)`) — 16.2:1
- **Elevated Card**: `#0F141F` (`oklch(17% 0.02 245)`) / Foreground: `#E2E8F4` — 14.1:1
- **Primary Action**: `#5B8DEF` (`oklch(65% 0.15 255)`) / Foreground `#FFFFFF` — 5.6:1
- **AI / MCP Accent**: `#3FB8AE` (`oklch(72% 0.13 180)`) / Foreground `#070A0F` — 6.8:1
- **Muted Fill**: `#161D2B` (`oklch(20% 0.025 245)`) / Foreground: `#8B9BB4` (`oklch(68% 0.03 240)`) — 5.3:1
- **Border**: `#1C2433` (`oklch(24% 0.03 245)`)

## Modes
One design in one palette. Pure dark mode (Obsidian default). Light mode supported (Vellum secondary).

## Type
- **Primary UI & Headings**: `Geist Variable` (Scale: Role-indexed).
  - Title: 20px / 28px lh, `wght 500`
  - Section Heading: 14px / 20px lh, `wght 500`, tracking +0.01em
  - Body Text: 14px / 22px lh, `wght 400`, measure 65ch
- **Telemetry & Nodes**: `Geist Mono Variable`.
  - Eyebrow: 11px / 14px lh, `wght 600`, uppercase, +0.08em tracking
  - Code/AST: 13px / 20px lh, `wght 400`, tabular-nums

## Spacing
Base unit: 4px.
Token scheme: `space-1` (4px), `space-2` (8px), `space-3` (16px), `space-4` (24px), `space-5` (32px), `space-6` (48px), `space-7` (64px).

## Radius
Concentric rule: inner = outer - gap.
Steps: `sm` (2px), `md` (4px), `lg` (8px). 

## Stroke and divider
1px hairline `#1C2433`. Divider lines come from 1px borders between flex container gaps.

## Elevation
This direction relies strictly on flat planes and 1px hairlines. No shadow language is used, replacing shadows with luminous 1px borders (`#3FB8AE` 20% opacity) for active elevated states.

## Background and surface treatment
Flat `#070A0F` base. Canvas surfaces use subtle 1px coordinate grids. Modals and overlays use `rgba(7, 10, 15, 0.8)` with backdrop-blur 8px.

## Icons
Lucide (MIT). Grid 24px, 1.5px stroke, Grade normal. Icon/Target pairs: 16px icon in 24px target (dense rows), 20px icon in 32px target (buttons).

## Grid and layout
Fluid grid: 12 columns desktop, 8 gutters (16px), 24px margins. Order collapses to single column below 768px. Max container 1440px. 

## Navigation model
Spatial & Chord-driven. Left rail navigation (36px items). Keyboard contract: `g <key>` spatial jumps, `Ctrl+K` Omni-search command bridge. Modals jump into place without drawer transitions.

## Content presentation
Telemetry Grid. Multi-pane cockpit. Fixed 24px high rows for file tree.

## Buttons and controls
Shape: Sharp rectangle (`border-radius 2px`).
Hierarchy: Primary (AI Teal fill), Secondary (Obsidian with 1px Teal border), Ghost (Transparent).
Tokens: Default, Hover (`#161D2B`), Focus (`2px solid #3FB8AE`), Active, Disabled (`opacity 0.5`).

## Per-surface technique
- **Surface 01 (Graph)**: Canvas 2D Precision Layout with Dynamic Louvain Spectral Hulls. 
  - *Understand*: Renders knowledge organically. *Objection*: Solves DOM density. *Cost*: Canvas <5KB JS.
  - Verdict: **ship** | Label: **PARTIAL** | Tier 2 Budget.
- **Surface 02 (Note Editor)**: Collaborative Astrocognitive Editor with Marginal Telemetry.
  - Verdict: **ship** | Label: **INFERRED**
- **Surface 03 (Repo)**: Codebase AST Symbol Explorer with Instant Cross-Reference Radar.
  - Verdict: **ship** | Label: **INFERRED**
- **Surface 04 (Command Hub)**: Omni-Search Command Bridge with Sub-100ms Chords.
  - *Understand*: High density cockpit. *Objection*: Natural language/chords overlay instantly. *Cost*: DOM <2KB.
  - Verdict: **ship** | Label: **INFERRED** | Tier 1 Budget.

## Motion spec
- **Durations**: Enter 240ms, Exit 160ms. Hover 100ms.
- **Easing**: `aerospace` = `cubic-bezier(0.16, 1, 0.3, 1)`. `linear` = `cubic-bezier(0, 0, 1, 1)`.
- **Stagger**: 40ms, capped at 8 items (320ms max).
- **Reduced-motion**: `animation: none` is avoided. Modals opacity fade in 0ms (instant), slide transforms removed entirely.

## Budgets
- **Tier 1 (Shell)**: 85KB HTML/CSS/JS. LCP < 1.2s.
- **Tier 2 (Heavy)**: 150KB (Canvas engine + D3-force). Lazy-loaded on IntersectionObserver.

## Accessibility
Contrast >= 4.5:1. Focus rings: 2px solid `#3FB8AE` with 2px `#070A0F` offset. Screen readers announce telemetry grids linearly. Icon-only controls have `aria-label` explicit strings (e.g., `"Close command palette"`).

## Composition log
Anchor: `chapters-app`
Background mode: Pure Dark

## What was invented
Omni-Search Command Bridge that instantly resolves keyboard chords against AST symbol lookups over the Louvain clustered graph.

## SAFE / RISK split
**RISK**: Observatory + Cockpit hybrid. Unmatched speed, unforgettable identity. Costs precision typography and canvas performance.

## Broken rules
| rule broken | what it buys | what it costs | why the trade is honest here |
|---|---|---|---|
| Light mode support | Maintained accessibility for Vellum secondary | Adds DOM complexity | Accessibility requirement override |

## Deferred decisions
| decision needed | if deferred, what happens |
|---|---|
| Surface 02 & 03 Prototypes | The design commits to something nobody has run; the failure moves from twenty minutes to a rebuild |
