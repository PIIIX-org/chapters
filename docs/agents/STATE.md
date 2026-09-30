# STATE

Resume anchor. Keep under 40 lines. Update + push at every task boundary.

- **Status**: Full Platform Visual & Behavioral Audit (135 screenshots, 20 defects cataloged, 6 advanced suites [Concurrency, 1k-Node 61 FPS, 30k-Word KaTeX/Mermaid, Zero-Mouse a11y, Touch Targets, Network Chaos]); Deep UI/UX Audit & Polish (48 screenshots, 6 defect categories resolved); Full-Stack Security Audit & Remediation (12/12 resolved).
  - Comprehensive Visual & Behavioral Audit (135 screenshots, 2026-09-30): Full-spectrum evaluation across 16 categories via CDP. Cataloged 20 defects (4 Critical: rail layout occlusion, button overlap, mobile header collapse, 405 revision diff; 7 High: raw UUID leak, QR code absence, text clip, touch target deficit [38/39 < 44px], PDF drop syntax bug; 9 Med/Polish). Interactive dashboard at `docs/visual-and-behavioral-audit-report.html` and note `audit/2026-09-30-comprehensive-visual-and-behavioral-audit`.
  - Deep UI/UX Audit (48 screenshots): Fixed dialog overflow/trapping in DialogContent (max-h + scroll), note title sidebar truncation in FileTree via NoteActions compact icon buttons, mobile 375px graph header collision in ColorModeToggle/GraphCanvas, mobile rail collision via pl-16 across all page wrappers, pointer cursors on Rail/NotificationBell/AccountMenu, and outline button affordances on Delete team and Change email.
  - UI/UX Polish (#316): Tactile button depress physics (active:scale-[0.96]), cursor-pointer restore, isolated destructive actions with safety borders in VaultActions/NoteActions, VaultCard settings modal trigger, ScopePicker opaque popover at z-30/z-50, unified top controls bar, dynamic context notice positioning.
  - WebMCP ADR: Documented architectural decision against WebMCP browser standard (in-tree native MCP tools + stdio/SSE are self-contained, auditable, and decoupled from client browser context).
  - Security Audit & Remediation (2026-09-28): 12/12 vulnerabilities remediated at root cause (3 Critical, 3 High, 4 Medium, 2 Low). SVG CSP sandboxing, Mermaid DOMPurify strict, gitUrl SSRF filter, MFA verification guard, mass assignment schema guards, TOTP secret backup scrubbing, admin hierarchy, email code lockout, git size caps, global perspective role checks, 0 npm audit advisories.
  - Graph Perspectives (§4.2): Scoped saved graph views & filter presets (Architecture, Security, Recent) with team sharing, REST API, UI & MCP tools.
  - MCP Prompts Suite: 20 engineering prompts (`prompts/list` & `prompts/get`) for continuous session capture, ADRs, drift audits, blast radius.
  - #286–#293: Rename sync, CRDT write-through, admin reactivation, wikilink refactoring, mark-all-read notifications, revision diff, incoming backlinks, responsive mobile shell.
  - Symbol Embeddings (#262): Fine-grained AST symbol vector embeddings (384d), snippets & line ranges in MCP `find_symbols`, `search`, and UI.
  - Concept Pathfinding: BFS shortest path explorer across notes and code in Graph Canvas and MCP `find_graph_path`, step breakdown & visual path illumination.
  - Scheduled Offsite Backups (#260): Automated snapshots to S3/GCS or local path with AWS SigV4, retention pruning, status API & admin UI.
  - Git Drift Detection: Staleness & drift check across frontmatter and wikilinks on git sync/webhook with UI alerts & notifications.
  - AST Note-to-Code Links: Cross-type [[repo:name/file#symbol]] wikilinks navigating to code files with symbol declaration & line reveal.
  - Image & Asset Uploads: Clipboard paste & drag-drop asset upload to vault storage with live image preview & export/import packaging.
  - Mermaid & KaTeX: Live block/inline KaTeX preview, live rendered Mermaid diagrams with click-to-edit cursor focus.
  - Local Ego Graph: 1–2 hops local network in Note Inspector with SVG layout, depth toggle, relation pills, accessible roster.
- **Previous Phases**: UI Redesign (#206), OKF v0.2 (#209–#213), Shell (#218–#239), Hardening (#244–#277), Prod Promotions (#303, #307, #309, #316, #318).
- **Architecture Traps**:
  - `prod` == `dev` needs Taha's explicit OK. PRs target `dev` directly, never stacked.
  - 1 container + 1 Postgres per customer. Control plane in separate private repo.
  - Collab is a person, no autosave PUT (CRDT is the note). Viewer read-only forever.
  - Exact seq scan for semantic edge recompute (#123). Mutation-verify every test.
- **Suite**: 1,281 automated tests (889 client, 392 server across 186 test files), 100% passing. Zero open bugs. Zero vulnerabilities.
- **Deferred**: cli-visualizer (#9, assigned), partial restore (#261), per-type notification prefs (#263).
- **Decided against (do NOT re-open)**: WebMCP browser standard (adr-001), Leiden (#265), graph DB (#268), GraphRAG (#267), cross-file calls (#266).
- **Open issues**: #9 (assigned).

