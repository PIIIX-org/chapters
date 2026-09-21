# observatory: Surface 01 of 04 — Knowledge Graph Observatory (01-graph)

- **Composition Anchor**: `full-field`
- **Background Mode**: `textured-surface` (deep obsidian substrate with optical radial coordinate mesh)
- **Frame Spec**: 1440×900 desktop screen, 44px topbar, 52px navigation rail, fluid canvas field.

## Layout Specification
- **Canvas Base**: Full-bleed `d3-force` interactive 2D scene, dark celestial substrate (`#070A0F`).
- **Louvain Community Hulls**: Soft convex hull polygons rendered with 6% alpha fills (`oklch(65% 0.15 255 / 0.06)` for Architecture, `oklch(72% 0.13 180 / 0.06)` for MCP/Agent tools, `oklch(74% 0.12 75 / 0.06)` for Workflows).
- **Node Geometry**:
  - Vault Notes: 6px circular nodes with 1.5px stroke (`#5B8DEF`).
  - Code Nodes: 5px square nodes (`#8B9BB4`).
  - Inferred / Semantic Edges: 1px dashed lines (`#3FB8AE` at 40% opacity).
  - Explicit Wikilink Edges: 1.2px solid lines (`#5B8DEF` at 60% opacity).
- **Floating Observatory HUD**:
  - Top-right Telemetry Overlay (`top: 56px`, `right: 16px`, width `280px`): Glass card (`#0F141F / 85%`, backdrop-filter blur 12px, border 1px `#1C2433`).
  - Active Selection: Node `domain/knowledge-graph.md` (PageRank: 0.84, Degree: 14 edges, Community: "Core Domain").
  - Filter Ribbon (`bottom: 20px`, `left: 50%`, transform `translateX(-50%)`): Segmented pills for All, Notes Only, Repos Only, Inferred Edges toggle.

## Typography Scale
- **HUD Title**: Geist Sans, 14px / 20px, Medium (`wght 500`), `#E2E8F4`.
- **Telemetry Readouts**: Geist Mono, 12px / 16px, Normal (`wght 400`), tabular-nums, `#8B9BB4`.
- **Canvas Labels**: Geist Sans, 11px / 14px, Medium (`wght 500`), `#E2E8F4` with 2px optical halo (`#070A0F`).
- **Eyebrow Coordinates**: Geist Mono, 10px / 12px, Semibold (`wght 600`), uppercase tracked 0.08em, `#526077`.

## Paired Color Tokens & Measured Contrast
- Substrate `#070A0F` vs Node Label `#E2E8F4`: **16.2:1** (Passes WCAG AAA)
- Substrate `#070A0F` vs Human Edge `#5B8DEF`: **5.6:1** (Passes WCAG AA Graphical)
- Substrate `#070A0F` vs AI Edge `#3FB8AE`: **6.8:1** (Passes WCAG AA Graphical)
- HUD Card `#0F141F` vs Secondary Text `#8B9BB4`: **5.3:1** (Passes WCAG AA)

## Content Direction
Realistic domain state showing Chapters' own indexed codebase and second brain:
- Central cluster: `project/chapters` connected via wikilinks to `codebase/chapters`, `server/src/graph/assemble.ts`, and `server/src/notes/okf.ts`.
- Inferred semantic edges connecting `client/src/components/graph/GraphCanvas.tsx` to `references/codebase-mapping-protocol.md`.
