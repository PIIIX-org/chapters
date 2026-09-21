# observatory: Surface 03 of 04 — Code Repository & AST Ingestion Console (03-repo)

- **Composition Anchor**: `left-rail-caption` (280px directory tree / fluid code viewer / 300px AST outline)
- **Background Mode**: `flat-surface`
- **Frame Spec**: 1440×900 desktop screen, 44px topbar, 52px rail.

## Layout Specification
- **Repo Header Band**:
  - Branch Selector: `dev` branch badge with commit SHA `7f8a12d`.
  - Ingestion Freshness Pill: `Synced 4m ago` (`#4CC38A` live dot).
  - Webhook Trigger Status: Active (GitHub push integration).
  - Quick actions: Sync Now (`Ctrl+S`), Connect New Repo, MCP Permissions.
- **Repository Tree (Left, 280px)**:
  - Recursive folder hierarchy (`server/src/graph/assemble.ts`, `repositories/git-sync.ts`, etc.).
  - File status icons: Tree-sitter indexed checkmark, symbol count badge (`14 sym`).
- **Code Viewer (Center Fluid)**:
  - CodeMirror 6 read-only canvas with syntax highlighting mapped to the Observatory palette (cyan keywords, blue types, green strings, muted slate comments).
  - Sticky breadcrumb line: `chapters / server / src / graph / assemble.ts`.
  - Line numbers in Geist Mono with active line highlighting (`#161D2B`).
  - AST symbol jump points: Clicking a function or type reveals which vault notes reference it.
- **AST Outline & MCP Inspector (Right, 300px)**:
  - Tree-sitter extracted functions, interfaces, classes.
  - Linked Vault Notes: Notes containing `[[repo:chapters/server/src/graph/assemble.ts]]`.
  - MCP Tool Scope: Indicates whether this repository is currently readable/navigable by AI subagents.

## Typography Scale
- **Repo Title**: Geist Sans, 16px / 24px, Medium (`wght 500`), `#E2E8F4`.
- **Code Viewer**: Geist Mono, 13px / 20px, Normal (`wght 400`), tabular-nums, `#D4DDEE`.
- **Directory Tree Nodes**: Geist Sans, 13px / 18px, Normal (`wght 400`), `#8B9BB4`.
- **AST Symbol Badges**: Geist Mono, 11px / 14px, Semibold (`wght 600`), `#3FB8AE`.

## Paired Color Tokens & Measured Contrast
- Substrate `#070A0F` vs Code Foreground `#D4DDEE`: **14.8:1** (Passes WCAG AAA)
- Substrate `#070A0F` vs Syntax Keywords `#3FB8AE`: **6.8:1** (Passes WCAG AA)
- Code Line Numbers `#526077` vs Background `#070A0F`: **3.1:1** (Passes Graphical)
- Active File Row `#161D2B` vs Active File Label `#E2E8F4`: **13.2:1** (Passes WCAG AAA)

## Content Direction
Active file displayed is `server/src/graph/assemble.ts`:
```typescript
export async function assembleGraph(vaultId: string, repoIds: string[]) {
  const extractedEdges = await extractWikilinkEdges(vaultId);
  const semanticNeighbors = await queryVectorStore(vaultId, { topK: 5 });
  return clusterLouvain([...extractedEdges, ...semanticNeighbors]);
}
```
AST outline shows `assembleGraph`, `extractWikilinkEdges`, `clusterLouvain`.
Linked notes: `project/chapters`, `concepts/knowledge-graph`.
