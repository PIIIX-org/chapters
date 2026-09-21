# observatory: Surface 04 of 04 — Quick Capture & Command Palette Hub (04-command)

- **Composition Anchor**: `centered-statement` (640px floating command console centered over dimmed observatory backdrop)
- **Background Mode**: `duotone-treated` (dimmed atmospheric backdrop with blur)
- **Frame Spec**: 1440×900 desktop screen, floating modal dialog with backdrop scrim.

## Layout Specification
- **Backdrop Scrim**: `rgba(7, 10, 15, 0.75)` with `backdrop-filter: blur(16px)`.
- **Command Modal Container (640px wide, max-height 520px)**:
  - Material: Obsidian glass (`#0F141F / 95%`), border 1px `#1C2433`, drop-shadow `0 24px 64px -16px rgba(0, 0, 0, 0.85)`.
  - Search Header: Prominent command input with search icon, live placeholder "Search notes, code symbols, or run MCP tools...", clear affordance, esc key pill.
- **Sectioned Search Results**:
  - Category: *Recent Notes* (with vault tags, last edited timestamp).
  - Category: *Code Symbols* (with repo icon, file path, AST symbol badge).
  - Category: *Actions & MCP Tools* (`create_note`, `sync_repository`, `graph_export`).
  - Active Selected Row: Elevated pill background `#1C2433` with bright primary indicator pip on left (`#5B8DEF`).
- **Footer Telemetry Strip**:
  - Keyboard hint bar: `↑↓` to navigate, `↵` to select, `tab` to filter category, `esc` to close.
  - Active index indicator: `483 files indexed • pgvector active • MCP connected`.

## Typography Scale
- **Command Input**: Geist Sans, 16px / 24px, Normal (`wght 400`), `#E2E8F4`.
- **Category Eyebrow**: Geist Mono, 11px / 14px, Semibold (`wght 600`), uppercase tracked 0.08em, `#526077`.
- **Result Item Title**: Geist Sans, 14px / 20px, Medium (`wght 500`), `#E2E8F4`.
- **Result Item Meta & Path**: Geist Mono, 12px / 16px, Normal (`wght 400`), `#8B9BB4`.
- **Footer Keys**: Geist Mono, 11px / 14px, `#8B9BB4` inside 18px kbd badges (`#161D2B`).

## Paired Color Tokens & Measured Contrast
- Scrim `#070A0F` vs Modal Surface `#0F141F`: Distinct elevation layer.
- Modal Surface `#0F141F` vs Input Text `#E2E8F4`: **14.1:1** (Passes WCAG AAA)
- Result Meta `#8B9BB4` vs Active Row `#1C2433`: **4.8:1** (Passes WCAG AA)
- Kbd Badge `#161D2B` vs Kbd Key `#E2E8F4`: **13.2:1** (Passes WCAG AAA)

## Content Direction
Active search query: `"assemble"`
Results displayed:
1. `assemble.ts` — `server/src/graph/assemble.ts` (Repository `chapters`)
2. `assembleGraph()` — Exported function in `assemble.ts` (14 callers)
3. `concepts/knowledge-graph.md` — Mentions graph assembly and Louvain clustering
4. `Run MCP Tool: graph --aggregate` — Query Louvain community topology
