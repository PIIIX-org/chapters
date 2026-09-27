# Deep Market & User Research: What Developer Knowledge Platforms Lack, What Users Crave, and What Chapters Must Build

> **Executive Synthesis**: The knowledge base market is divided into two flawed paradigms: **"The Corporate Graveyard"** (Confluence, Notion) — slow, disconnected from code, and abandoned into information rot; and **"The Solitary Island"** (Obsidian, Logseq) — lightning-fast and loved by individual developers, but fundamentally broken for teams due to sync conflicts, lack of access control, and zero native multiplayer. 
>
> **Chapters** occupies the sweet spot: **Local-first Markdown speed + Real-time CRDT multiplayer + Git code repository intelligence + AI-navigable MCP architecture**. This report outlines the exact industry gaps, user cravings, non-negotiable table stakes, and high-impact differentiators to dominate this space.

---

```mermaid
quadrantChart
    title Knowledge Systems Landscape: Team Collaboration vs. Code/AI Native
    x-axis "Decoupled from Code / Pure Text" --> "Deep Code & AST Native"
    y-axis "Single-Player / Siloed" --> "Real-Time Team Multiplayer"
    quadrant-1 "The Golden Frontier (Chapters Target)"
    quadrant-2 "The Corporate Graveyard (Confluence, Notion)"
    quadrant-3 "The Outdated Wiki (DokuWiki, MediaWiki)"
    quadrant-4 "The Solitary Island (Obsidian, Logseq)"
    "Confluence": [0.20, 0.85]
    "Notion": [0.28, 0.75]
    "Outline": [0.35, 0.65]
    "Obsidian": [0.25, 0.20]
    "Logseq": [0.30, 0.15]
    "Swimm": [0.85, 0.40]
    "Sourcegraph": [0.90, 0.55]
    "Chapters (Current)": [0.72, 0.70]
    "Chapters (Post-Roadmap)": [0.92, 0.90]
```

---

## 1. What the Industry Lacks (The Critical Market Gaps)

### 1.1 The Code-Doc Schism ("The Truth Gap")
* **The Reality**: The ultimate source of truth in any software company is the **Git repository**. Design decisions happen in PRs, issues, and code reviews.
* **The Failure**: Documentation tools (Confluence, Notion, Slite) live in an isolated universe. Once an Architecture Decision Record (ADR) or API doc is written, it begins rotting immediately. Within 3 weeks of shipping code, the document is stale, misleading, and dangerous.
* **The Industry Void**: No platform seamlessly marries a Markdown note vault with a synced, parsed Git repository under one roof where notes can link directly to live AST code symbols and alert authors when the underlying code changes.

### 1.2 The "Team Obsidian" Paradox
* **The Craving**: Developers universally praise Obsidian for its raw speed, plain Markdown on disk, bi-directional wikilinks, and visual knowledge graphs.
* **The Breakdown**: Every attempt to deploy Obsidian across an engineering team fails:
  1. *Sync collisions*: Git-based syncing or Syncthing leads to ugly merge conflicts when multiple engineers edit notes simultaneously.
  2. *Zero access control*: No granular role-based permissions (readers vs. writers vs. admins).
  3. *High non-technical barrier*: Product managers and designers refuse to manage Git remotes or terminal hooks.
* **The Industry Void**: A tool that provides the **raw speed and Markdown ownership of Obsidian** combined with **conflict-free Yjs CRDT real-time multiplayer and enterprise RBAC**.

### 1.3 The Global Graph "Hairball" Fallacy
* **The Problem**: In tools like Obsidian, Roam, and Logseq, the global graph view is widely dismissed on Hacker News and Reddit as **"aesthetic vanity" / "node flexing"** — a pretty 3,000-node constellation that users admire once on Twitter and never use again.
* **The Reason**: Global graphs cause severe cognitive overload. They lack hierarchy, filtering, or logical entry points. Hitting `Cmd+K` or full-text search is 100x faster than hunting for a node in a bouncing ball of yarn.
* **The Industry Void**: Purpose-driven, contextual graph tools: **Local Ego Graphs** (showing only 1-2 degrees of separation), **Concept Pathfinding** (discovering the shortest chain of decisions connecting Module A to Feature B), and **Supernode Bottleneck Analysis** for architecture debugging.

### 1.4 The AI Agent "Token Burn" Trap
* **The Problem**: When coding agents (Cursor, Windsurf, Claude Desktop, Antigravity, Devin) are tasked with understanding architecture, current tools either:
  - Dump raw 2,000-line Markdown or HTML files into the context window, causing massive token waste and "lost-in-the-middle" reasoning failure.
  - Rely on naive semantic chunking (RAG) that loses structural hierarchy (e.g. pulling a snippet of a method without knowing what class, module, or architecture decision spawned it).
* **The Industry Void**: An MCP (Model Context Protocol) knowledge graph that uses **Progressive Disclosure**: delivering high-level summary catalogs and AST symbol skeletons first, and providing granular MCP tools for the agent to navigate depth on demand.

---

## 2. What Users Crave (The Deep Psychological & Workflow Desires)

```mermaid
mindmap
  root((What Users Crave))
    Zero-Maintenance Living Docs
      Auto-Drift Detection on PRs
      AST-Anchored Symbol Links
      Live Updating Code Snippets
    Instantaneous Frictionless UX
      Sub-10ms Keystroke Latency
      Offline-First + Background CRDT Sync
      Obsidian-Style Wikilink Autocomplete
    Actionable Graph Intelligence
      Local Ego-Graphs (1-2 Hops)
      Pathfinding Between Disparate Concepts
      Supernode / Bottleneck Spotting
    AI-Agent Harmony
      Token-Efficient MCP Progressive Disclosure
      Agent Memory Across Sessions
      Natural Language Architecture Queries
```

### 2.1 "Don't Make Me Maintain It" (Living Documentation)
Engineers do not hate writing documentation; they hate maintaining documentation that rots. Users crave:
- **AST-anchored links**: Links that target `UserService.authenticate` instead of `src/auth.ts#L42-L58`. When the function moves to line 120 or another file, the link persists.
- **Drift alerts**: When a GitHub/GitLab webhook triggers on PR merge, the system highlights: *"This PR refactored the Token Expiry logic. Note `auth/session-spec.md` is now potentially out of date."*

### 2.2 Sub-Millisecond Speed & Text Ownership
- Users despise the sluggishness of web-based enterprise wikis (Notion's heavy Electron bundle and Confluence's clunky WYSIWYG editor).
- Developers crave **pure Markdown**, full keyboard navigation (Vim/Emacs keybindings, `g`-chords, palette shortcuts), and instant response times with offline resilience.

### 2.3 Meaningful "Why" Tracing in Code
When a new engineer joins or when an incident occurs, the first question is always: *"Why was this architected this way?"*
- Today, the answer is buried across forgotten Slack threads, Jira tickets, or lost PR comments.
- Developers crave a **direct line from code to context**: opening a file in the repository viewer and immediately seeing the linked ADR, whiteboard note, or post-mortem in the sidebar.

---

## 3. What We MUST Add (Table Stakes / P0)

These are the non-negotiables required for production adoption, developer trust, and competitive parity:

| Feature | Category | Rationale & User Impact |
| :--- | :--- | :--- |
| **Local Ego Graph (1–2 Hops) in Inspector** | **Graph UX** | Global graphs overwhelm; local ego graphs ground the user. Displaying an interactive local graph in the note/repo inspector showing immediate connections is the #1 feature that turns graph visualization into a daily navigation tool. |
| **Math (KaTeX) & Flowcharts (Mermaid) Rendering** | **Editor** | Essential for technical engineering documentation. Architecture diagrams (sequence diagrams, flowcharts) and algorithmic formulas are mandatory for system design specs. |
| **AST-Anchored Symbol Links** | **Code-Doc** | Enable notes to link directly to parsed AST symbols (e.g. `[[repo:backend/src/auth.ts#Class:TokenService]]`). Prevents broken links when files are refactored. |
| **Automated Scheduled Backups (#260)** | **Reliability** | Team credibility requires automated, scheduled snapshots (S3, GCS, local path). Self-hosters will not trust production data to a system requiring manual UI zip downloads. |
| **PR / Webhook Documentation Drift Detection** | **Living Docs** | When a repository webhook fires on push/merge, check all notes linked to modified files/symbols and mark them with a subtle `drift: unverified` badge, closing the code-doc gap. |
| **Image & Asset Attachment Uploads** | **Editor** | Notes cannot be text-only; architecture screenshots, UI mockups, and terminal outputs must be pasteable directly into notes with local disk storage. |

---

## 4. What is GOOD TO HAVE (P1 Differentiators & Delighters)

High-leverage features that turn Chapters from an alternative into an undisputed category leader:

### 4.1 Concept Pathfinding & Shortest-Path Explorer
- **User Story**: An architect asks: *"How does our Billing Service connect to the Note Revisions table?"*
- **Capability**: User selects Node A and Node B in the graph view. The system runs Dijkstra/BFS and highlights the direct and indirect causal chains, ADRs, and intermediate code modules connecting them.

### 4.2 Saved Graph Perspectives & Filter Presets
- Allows teams to save scoped views of the knowledge graph:
  - *"ADRs & Architecture Decisions"*
  - *"Security & Auth Surface"*
  - *"Core Data Pipelines"*
- Filters by tag, folder type, repo, and time range.

### 4.3 Multi-User Live Presence & Cursor Indicators
- Displays colorful collaborator cursors and active viewer avatars in real-time note editing, providing the Google Docs / Figma multiplayer feel inside a local-first Markdown environment.

### 4.4 Symbol-Level Embeddings for Fine-Grained MCP Retrieval (#262)
- Instead of embedding an entire 600-line source file as a single vector, index individual AST functions and classes.
- Enables an MCP coding agent (Cursor, Claude) to query `How does authenticateUser validate MFA?` and receive the exact 20-line method embedding, reducing token spend by 85%.

### 4.5 MCP Prompts & Context Templates
- Provide pre-packaged MCP Prompts that coding agents can invoke directly:
  - `draft_adr`: Generates a standard Architecture Decision Record pre-linked to the active repository branch.
  - `audit_architecture_drift`: Analyzes the active git diff against all vault notes and produces a drift report.

---

## 5. Competitive Matrix

| Capability | Confluence | Notion | Obsidian | Outline | Swimm | **Chapters** |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Format** | Proprietary HTML | Proprietary Blocks | Local Markdown | Markdown | Markdown in Git | **Open Knowledge Format (OKF v0.2) + MD** |
| **Hosting** | Cloud / DC ($$$) | Closed Cloud | Local Files | Self-Host / Cloud | Cloud / GitHub App | **Self-Host (1 Container + Postgres)** |
| **Real-Time Multiplayer** | Yes (clunky) | Yes | ❌ (Sync conflicts) | Yes | ❌ (Git based) | **Yes (Yjs CRDT over WebSocket)** |
| **Synced Code Repositories** | ❌ | ❌ | ❌ | ❌ | Yes (IDE only) | **Yes (Full tree, code viewer, AST)** |
| **Knowledge Graph View** | ❌ | ❌ | Yes (Global only) | ❌ | ❌ | **Yes (2D/3D + Semantic Edges + Louvain)** |
| **Code-to-Note Bi-directional Links** | ❌ | ❌ | ❌ | ❌ | Partial | **Yes (Live backlinks + candidate match)** |
| **Native AI Agent MCP Interface** | ❌ | ❌ | Community plugin | ❌ | ❌ | **Native First-Class MCP Server (40+ tools)** |
| **Privacy / Local-Only Vector Index** | ❌ (Cloud LLMs) | ❌ (OpenAI) | Local via plugins | ❌ | ❌ | **100% Local ONNX Embeddings + pgvector** |

---

## 6. Actionable Implementation Roadmap

```mermaid
flowchart TD
    subgraph Milestone 1: "The Core Visual & Technical Depth"
        M1_1["Local Ego Graph in Inspector"]
        M1_2["Mermaid & KaTeX Editor Support"]
        M1_3["Image & File Paste Uploads"]
    end

    subgraph Milestone 2: "The Code-Doc Living Bridge"
        M2_1["AST-Anchored Note-to-Code Links"]
        M2_2["Git Webhook Drift Detection"]
        M2_3["Automated Object Backups (#260)"]
    end

    subgraph Milestone 3: "AI Agent & Graph Mastery"
        M3_1["Graph Pathfinding & Saved Perspectives"]
        M3_2["Symbol-Level Embeddings (#262)"]
        M3_3["MCP Prompts & Progressive Context Tables"]
    end

    M1_1 --> M2_1
    M1_2 --> M2_1
    M2_1 --> M2_2
    M2_2 --> M3_1
    M2_3 --> M3_2
```

### Recommendation for Next Slice
1. **Local Ego Graph (1–2 Hops) in Inspector**: Transform the graph from a standalone page into a constant, interactive companion that sits right next to whatever note or code file the user is currently viewing.
2. **Mermaid & KaTeX in Note Viewer**: Complete the technical documentation authoring experience so engineers can embed architecture diagrams and mathematical expressions seamlessly.
3. **AST-Anchored Code Links & Drift Indicators**: Fulfill the central promise of Chapters — bridging code and documentation into a single living, verifiable knowledge graph.
