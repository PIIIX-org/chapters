# TRANSLATE.md — Chapters Web Console (chapters-app)

## 1. Surface Class
**`tool-shaped`** [HARD §15 binds]
Chapters is a self-hostable second brain and team knowledge base. Users open it every working day for multi-hour sessions to author plain-text markdown/YAML notes, trace interconnected knowledge graphs, browse synced codebases, and interact with AI agents via MCP.
- Aspect ratio for comps: 16:10 desktop screen with full operational chrome.
- Nine data states owed: empty, loading, partial, error, permission denied, offline, stale, conflict, bulk.
- Full keyboard completeness required (§15).

## 2. Viewer and Their Decision or Task
**Viewer**: A knowledge worker, software engineer, technical architect, or engineering lead working within an interconnected knowledge and code repository.
**Decision / Moment**: 
- Authoring and organizing structured OKF notes with bidirectional wikilinks (`[[note]]` and `[[repo:...]]`).
- Exploring and navigating dense knowledge graphs and codebase community clusters to understand project architecture without cognitive fatigue.
- Inspecting live collaborative revisions, file trees, metadata properties, and permissioned MCP connections.
**Density**: Professional, calm, high-information density. Space is earned, not padded. Hierarchy is articulated through subtle tonal elevation, crisp typography, and disciplined hairlines rather than bulky borders or decorative cards.

## 3. The Three-Second Feel
> **"A razor-sharp, living second brain where every thought, note, and line of code connects with crystalline clarity."**

Calm, responsive, deeply focused, and authoritative. It feels like stepping into a high-precision observatory for thought and code — zero visual noise, immediate responsiveness.

## 4. Archetype and Shadow
- **Archetype**: *The Archival Instrument / Modern Cybernetic Cartographer* — mathematically disciplined, quiet, authoritative, tactile, deeply capable, computational yet human. Every edge, label, and panel has intentionality.
- **Shadow**: *Sterile CAD terminal or cold database debugger* — the risk of overcorrecting into a lifeless, intimidating wireframe where typography is uninviting and human thought feels mechanised.

## 5. Anti-Positioning
1. **Generic Shadcn/Tailwind default SaaS dashboard**: Cookie-cutter zinc-900 cards, rounded-xl puffy containers, generic Lucide icon grids, and flat cards floating on uniform gray.
2. **Bloated consumer workspace (Notion / Craft)**: Cartoonish pastel emoji covers, oversized margins, slow animations, and bubbly aesthetic fluff.
3. **Uncurated graph clutter (raw Obsidian plugin hairball)**: Tangled, unweighted physics explosions with unreadable labels and jarring contrast.
4. **Neon Cyberpunk / Gamer HUD cliché**: Gimmicky neon glow borders, scanlines, decorative tech brackets, and illegible dark-on-dark contrast.

## 6. What Is Already Owned
- **Product Name**: Chapters (PIIIX-org/chapters)
- **Monogram**: "Ch"
- **Authorship Color Semantics** (Core Invariant):
  - **Human Primary**: `#5B8DEF` (dark) / `#2F6FE0` (light) — human cursors, human links, primary actions.
  - **AI / MCP Accent**: `#3FB8AE` (dark) / `#1F7770` (light) — AI/MCP generated content, inferred graph edges, AI cursor. Teal is never a human, never a generic hover color.
  - **Collaborator Ink Palette**: 5 calibrated hues (Vermillion `#F07A5A`, Indigo `#7C8FD9`, Plum `#C97FB0`, Ochre `#D9B24C`, Forest `#6FBF8A`).
- **Typography**:
  - UI Sans: Geist Variable
  - Machine / Code Mono: Geist Mono Variable
  - Self-hosted via `@fontsource-variable`, zero external CDN dependencies.
- **Architecture & Primitives**:
  - Open Knowledge Format (plain markdown with YAML frontmatter)
  - Canvas 2D Graph Engine with `d3-force`
  - CodeMirror 6 + Yjs CRDT real-time collaboration
  - 44px top bar, 52px navigation rail, collapsible context & inspector tracks.
