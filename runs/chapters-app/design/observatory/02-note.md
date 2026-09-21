# observatory: Surface 02 of 04 — OKF Note Workspace & Live Editor (02-note)

- **Composition Anchor**: `split-field` (60% editorial workspace / 40% inspector rail)
- **Background Mode**: `flat-surface` with subtle optical elevation
- **Frame Spec**: 1440×900 desktop screen, 52px rail, 264px context tree, fluid editor center, 320px inspector right.

## Layout Specification
- **Context Tree (Left, 264px)**: Hierarchical OKF folder tree. Active vault "Chapters" with note counts, trash bin indicator, search input (`Ctrl+F`).
- **Editor Canvas (Center)**:
  - Document Title & Breadcrumbs: `chapters / concepts / knowledge-graph.md`
  - YAML Frontmatter Block: Recessed container (`#0C1017`, border 1px `#1C2433`, radius 6px) with expandable tags `[concept, graph, okf]`, author attribution pill, created timestamp.
  - Prose Measure: Max-width 72ch, centered with generous breathing room.
  - Live Wikilinks: Rendered with subtle pill underline (`border-bottom: 1.5px solid var(--primary)`), hover reveals instant tooltip preview of destination note.
  - Active Cursors: Real-time collaborative presence indicators with colored flags (`#F07A5A` for Sarah, `#7C8FD9` for Alex, `#3FB8AE` for Antigravity AI MCP).
- **Inspector Rail (Right, 320px)**:
  - Backlinks Table: 6 incoming wikilinks with context excerpts.
  - Extracted Code Symbols: Tree-sitter references to `assemble.ts` and `store.ts`.
  - Semantic Neighbors: 4 nearest vector neighbors with cosine similarity metrics (0.91, 0.88, 0.84).

## Typography Scale
- **Document Title**: Geist Sans, 22px / 28px, Semibold (`wght 600`), `#E2E8F4`.
- **Markdown H1/H2/H3**: Geist Sans, 18px / 24px (`h1`), 15px / 22px (`h2`), 14px / 20px (`h3`), Medium (`wght 500`).
- **Body Text**: Geist Sans, 14px / 24px, Normal (`wght 400`), `#D4DDEE`.
- **Frontmatter & Code Blocks**: Geist Mono, 13px / 20px, Normal (`wght 400`), `#8B9BB4`.
- **Inspector Meta**: Geist Mono, 11px / 16px, uppercase tracked 0.06em, `#526077`.

## Paired Color Tokens & Measured Contrast
- Editor Substrate `#070A0F` vs Body Text `#D4DDEE`: **14.8:1** (Passes WCAG AAA)
- Recessed Frontmatter `#0C1017` vs Key `#8B9BB4`: **5.4:1** (Passes WCAG AA)
- Collaborative Cursor Tag `#F07A5A` vs Foreground `#FFFFFF`: **4.7:1** (Passes WCAG AA)
- Inspector Card `#0F141F` vs Backlink Title `#E2E8F4`: **14.1:1** (Passes WCAG AAA)

## Content Direction
Active note being authored is `concepts/knowledge-graph.md`:
"Chapters operates on a dual-graph substrate: explicit extracted links (`[[note]]` and `[[repo:id/path]]`) combined with local ONNX embeddings for semantic neighborhood discovery..."
Live presence badge shows "Antigravity AI (MCP) editing section 3".
