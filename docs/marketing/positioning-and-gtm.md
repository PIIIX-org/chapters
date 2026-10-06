# Chapters (Elara) — Marketing Positioning, Messaging & GTM Strategy

> **Core Thesis**: Chapters is not just another wiki or personal note-taking tool. It is the **first living team second brain built for the agentic era** — bridging human architectural reasoning (plain Markdown notes) with real-time codebase truth (Tree-sitter AST symbols) and autonomous AI workflows (Model Context Protocol).

---

## 1. Executive Positioning Statement

### The One-Liner
> **Chapters is an open-source, self-hostable team second brain that connects plain Markdown notes directly to your Git codebase and exposes both to AI agents via an interactive knowledge graph and Model Context Protocol (MCP).**

### Category Creation: The "Living Second Brain"
Traditional documentation platforms fail because they sit in one of three flawed silos:
1. **The Corporate Graveyard (Confluence, Notion)**: Disconnected from code, high input lag, clunky WYSIWYG, and abandoned into stale documentation rot.
2. **The Solitary Island (Obsidian, Logseq)**: Loved by developers for speed and local Markdown files, but broken for teams due to sync collisions, merge conflicts, and zero server-side RBAC (*The Team Obsidian Paradox*).
3. **The Headless Code Scraper (Graphify, GitNexus, Swimm)**: Highly capable at parsing code ASTs, but lacking a human collaborative second brain, team vaults, and rich Markdown notes.

**Chapters is the first platform that unites all three: human speed, code truth, and agentic memory.**

---

## 2. The Four Pillars of Differentiation

```mermaid
graph TD
    subgraph P1["Pillar 1: Team Markdown Freedom"]
        OKF["Google OKF v0.2 + Plain Files"] --> CRDT["Yjs Collaborative CRDT"]
        CRDT --> NO_CONFLICT["Zero Git Merge Conflicts"]
    end

    subgraph P2["Pillar 2: Living Code-Doc Symbiosis"]
        GIT["Git Repo Ingestion"] --> AST["Tree-sitter AST Symbol Indexing"]
        AST --> ANCHOR["Symbol Anchors [[repo:...#symbol:...]]"]
        ANCHOR --> DRIFT["Automated PR Drift Detection"]
    end

    subgraph P3["Pillar 3: Agentic Memory & MCP"]
        MCP["57 MCP Tools + 20 Prompts"] --> PROG["Progressive Disclosure Navigation"]
        PROG --> TOKEN["70x-120x Token Reduction for AI Agents"]
    end

    subgraph P4["Pillar 4: Sovereign Self-Hosting"]
        DOCKER["Single Docker Container"] --> VEC["Decoupled ChromaDB / Local ONNX"]
        VEC --> PRIVACY["100% On-Premises Privacy"]
    end
```

### Pillar 1: Solving the "Team Obsidian Paradox"
* **The Problem**: Developers love Obsidian's raw speed and local Markdown files on disk, but deploying it across a team using Git sync produces instant merge conflicts, clobbered notes, and no permissions.
* **The Chapters Solution**: Plain Markdown files on disk adhering to Google's **Open Knowledge Format (OKF v0.2)** with strict ISO 8601 UTC offsets, combined with an in-memory **Yjs collaborative CRDT relay** providing Google Docs-style real-time collaboration with role-based access control (RBAC).

### Pillar 2: Ending the "Code-Doc Schism"
* **The Problem**: Engineering documentation rots within 3 weeks of shipping code. Links break when files are refactored or lines shift.
* **The Chapters Solution**: Ingests Git repositories, parses Abstract Syntax Trees (ASTs) using **Tree-sitter**, and enables notes to link directly to functions, classes, and types:
  ```markdown
  [[repo:chapters/server/src/graph/assemble.ts#symbol:assembleGraph]]
  ```
  If code changes or moves, the symbol anchor resolves dynamically, and webhook-driven drift detection alerts the author.

### Pillar 3: Purpose-Built for AI Coding Agents (MCP-First)
* **The Problem**: Dumping 2,000-line Markdown documents into Claude Desktop, Cursor, or Antigravity burns context tokens and causes hallucinated reasoning.
* **The Chapters Solution**: A stateless, permission-scoped **Model Context Protocol (MCP)** server providing **57 tools** and **20 first-class engineering prompts**. AI agents navigate through **progressive disclosure** (overview indexes first, symbol skeletons second, deep reading on demand), cutting token spend by up to 70x.

### Pillar 4: Sovereign Self-Hosting & ChromaDB Decoupling
* **The Problem**: Enterprise engineering teams refuse to send proprietary architecture decisions and source code to third-party cloud LLM vectors.
* **The Chapters Solution**: 100% local ONNX embeddings (`bge-small-en-v1.5`), vanilla PostgreSQL, and high-concurrency vector decoupling via **pure ChromaDB** (`dev-chroma`), eliminating database connection pool bottlenecks under heavy load.

---

## 3. Elevator Pitches by Audience

### A. The 10-Second Hook (Twitter / Hacker News)
> "Obsidian for teams, with real-time multiplayer, synced Git repos, and an MCP knowledge graph that coding agents can actually navigate without burning tokens."

### B. The 30-Second Elevator Pitch (Product Hunt / Founders)
> "Chapters is an open-source second brain for software teams. It combines the speed of plain Markdown files with real-time CRDT collaboration, syncs with your Git repositories using Tree-sitter AST symbol linking, and gives your AI agents (Claude, Cursor, Antigravity) persistent memory through a 57-tool Model Context Protocol server. Self-host it in one Docker command with zero cloud lock-in."

### C. The 2-Minute Technical Pitch (CTO / Engineering Lead)
> "Every engineering team suffers from the Code-Doc Schism: architecture docs in Confluence or Notion rot the moment code merges. Chapters fixes this by treating documentation and code as a single unified knowledge graph. 
> 
> Notes live as plain Markdown files on disk conforming to Google's Open Knowledge Format (OKF v0.2). Real-time edits flow over WebSocket using Yjs CRDTs, eliminating the merge conflicts that make Git-backed Obsidian impossible for teams. Chapters clones and indexes your Git repositories, parsing AST symbols via Tree-sitter so your notes link directly to live functions and classes (`[[repo:...#symbol:...]]`). 
> 
> Furthermore, Chapters exposes a native MCP server with 57 tools and 20 engineering prompts, allowing AI coding assistants to traverse architecture hierarchies, trace causal paths with Dijkstra/BFS, and audit drift without blowing past token limits. It runs 100% self-hosted on PostgreSQL and ChromaDB with local ONNX embeddings."

---

## 4. Objection Handling & Competitor Teardowns

| Competitor | Their Pitch | Why Chapters Wins (The Direct Counter) |
| :--- | :--- | :--- |
| **Obsidian** | "Local-first markdown files & graph view." | "Obsidian is brilliant for one person, but broken for teams. Sharing a vault via Git causes merge conflicts and lacks permissions. Chapters gives you the same plain Markdown files with conflict-free Yjs real-time multiplayer and Git repository AST indexing." |
| **Notion** | "All-in-one connected workspace." | "Notion is heavy, proprietary, and completely disconnected from Git. Code snippets in Notion are dead text that immediately rot. Chapters anchors documentation directly to live AST code symbols and is 100% open-source and self-hostable." |
| **Outline** | "Fast, beautiful team wiki." | "Outline is a great wiki, but it has no knowledge graph, no Git repository ingestion, no code symbol linking, and no native 57-tool MCP server for AI agents. Outline is docs-only; Chapters is docs + code + agents." |
| **Swimm** | "Code-coupled documentation in IDE." | "Swimm is closed-source SaaS. Chapters is open-source (MIT), self-hostable, adheres to Google OKF v0.2, and provides a full team second brain with interactive 2D graph views, Louvain community clustering, and autonomous agent MCP tools." |
| **Graphify** | "Turn code into a knowledge graph for MCP." | "Graphify is a fantastic CLI tool for code, but it isn't a wiki or second brain. It has no user interface, no collaborative editor, no OKF notes, and no team access control. Chapters provides the entire platform." |
| **`okf-mcp`** | "Serve OKF bundles over MCP." | "okf-mcp is a headless daemon. Chapters is a complete, production-grade web application featuring a rich live-preview editor, visual 2D force-directed graph canvas, Yjs collaboration relay, and multi-vault organizational management." |

---

## 5. Ideal Customer Profiles (ICPs)

### ICP 1: AI-Native Engineering Teams
* **Profile**: 5–50 developers heavily utilizing Claude Code, Cursor, Windsurf, or Antigravity.
* **Pain Point**: Coding agents suffer from context amnesia between sessions and hallucinate architecture decisions.
* **Why They Adopt Chapters**: The 57 MCP tools and 20 engineering prompts allow agents to query architecture specs, draft ADRs, and navigate code paths with progressive disclosure.

### ICP 2: Tech Leads & Software Architects
* **Profile**: Staff/Principal Engineers responsible for system design, RFCs, and onboarding.
* **Pain Point**: Onboarding takes months because architecture rationale is scattered across Slack, PRs, and abandoned wikis.
* **Why They Adopt Chapters**: Shortest-path concept navigation (`find_graph_path`) and AST note-to-code links allow new hires and architects to trace "why this code was written" in seconds.

### ICP 3: Open-Source & Self-Hosting Advocates
* **Profile**: Privacy-conscious companies, fintech, healthcare, or security-focused dev shops.
* **Pain Point**: Cloud documentation tools violate compliance; local single-player tools don't scale to teams.
* **Why They Adopt Chapters**: Docker one-line deployment, vanilla Postgres, ChromaDB decoupling, local ONNX embeddings, and zero telemetry leaks.

---

## 6. Go-To-Market (GTM) Launch Playbook

### Channel 1: Show Hacker News
* **Title**: `Show HN: Chapters – Open-source team second brain with synced Git repos and MCP knowledge graph`
* **Core Post Structure**:
  1. *The Problem*: Why we built this (the failure of Team Obsidian and the rotting Confluence wiki).
  2. *The Architecture*: Fastify + Yjs CRDT + Tree-sitter AST + OKF v0.2 + pure ChromaDB / pgvector.
  3. *The Demo*: Video showing a developer editing a note, linking to an AST function, and Claude Desktop navigating the graph via MCP.
  4. *Open Source & Self-Hostable*: Links to GitHub (`PIIIX-org/chapters`), Docker Compose, and benchmark numbers.

### Channel 2: GitHub Trending & Social Hooks (X / Twitter)
* **Hook 1**: *"We tried using Obsidian for our engineering team. It was disaster. Here is how we fixed the 'Team Obsidian Paradox' with Yjs CRDT and Google's Open Knowledge Format."*
* **Hook 2**: *"Stop dumping 2,000 lines of documentation into Cursor. Here is how progressive disclosure over MCP cuts agent token usage by 70%."*
* **Hook 3**: *"Code moves. Line numbers change. Here is how AST-anchored wikilinks (`[[repo:...#symbol:...]]`) eliminate broken documentation forever."*

### Channel 3: Agent Skills & AI Ecosystem Distribution
* Chapters already ships with native skills for:
  - Antigravity / Gemini CLI (`~/.agents/skills/chapters` and `elara`)
  - Claude Desktop & Claude Code
  - Cursor (`.cursor/rules`)
  - Windsurf
* Contributing Chapters as a canonical provider in the Model Context Protocol ecosystem registry ensures immediate organic agent discovery.
