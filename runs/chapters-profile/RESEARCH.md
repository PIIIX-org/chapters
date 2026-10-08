# Research Report: Chapters (Elara) — PIIIX-org/chapters

> **Target:** `PIIIX-org/chapters` (Project README)  
> **Pipeline:** `git-a-profile`  
> **Date:** October 7, 2026  
> **Author/Agent:** Antigravity Conductor (Gemini 3.8 Flash)  
> **Target Repo Location:** `/Users/taha/Documents/chapters`  
> **Authenticated Identity:** `Taha-Mahmoodi` (`gh` CLI with `admin:org`, `repo`, `workflow` scopes)

---

## 1. Loop 0: Bootstrap Verification Report

| # | Capability | Platform Tool / Method | Status |
|---|---|---|:---:|
| 1 | **Shell + Git + GitHub API** | Native `zsh`, `git`, GitHub CLI `gh` (authenticated as `Taha-Mahmoodi`) | **Native** |
| 2 | **Web Fetch & Search** | Antigravity search & fetch tools | **Native** |
| 3 | **GitHub GraphQL** | `gh api graphql` | **Native** |
| 4 | **Write SVG Files** | Python 3.9 script / direct file generation | **Native** |
| 5 | **Render SVG → PNG** | macOS `/usr/bin/qlmanage -t -s 900 -o . asset.svg` | **Native** |
| 6 | **Sample Brand Colors** | Python Pillow (`PIL`) + design tokens in `runs/chapters-app/tokens.json` & `client/src/index.css` | **Native** |
| 7 | **Screenshot Live Page** | Local Chrome DevTools / `npx playwright` / browser preview | **Native / Fallback** |
| 8 | **Anti-Slop Writing Guidance** | Inlined checklist + `stop-slop`, `ogilvy`, `copywriting` skills | **Native** |
| 9 | **Charts & Diagrams** | Native Mermaid (` ```mermaid `) + custom animated SVGs + Markdown tables | **Native** |

---

## 2. Intake (§0)

- **Subject:** `PIIIX-org/chapters` (The open-source, self-hostable second brain & codebase knowledge graph platform, also known as Elara).
- **User Request:** *"lets build a comprehancive easy to read with links to related documents and charts and stats that we gathered from our tests."*
- **Vibe:** Mission-control engineering deck — dark obsidian, authoritative, hyper-legible, backed by deep empirical telemetry from real hardware, zero marketing fluff.
- **Must-Haves:**
  1. Prominent links and navigation for the **7 Executive Benchmark Reports** (`docs/benchmarks/01` to `07`) and interactive HTML dashboards.
  2. Clear summary of the **15 Master Test Plans (`TP-01` to `TP-15`)** with empirical pass rates and key metrics.
  3. Visual charts and empirical stats from our Contabo VPS (`sohrab`) test runs:
     - Vector Engine Showdown: `pgvector` vs `ChromaDB` (+31.7% QPS, 84% lower tail latency, +3.13MB flat memory drift vs Chroma's +152.7MB surge).
     - Polyglot Tree-sitter ingestion: **92,245 LOC/sec** and 20,114 code symbols.
     - Real-time CRDT: 20 simultaneous writers, 100% SHA256 convergence, 0.09 ms latency.
     - Zero data loss: 525.8 ms self-healing crash recovery, 100% WAL PITR fidelity.
     - 24-hour soak: 0.374 MB/hr memory drift, 0 leaked connections, 0 leaked file descriptors.
  4. Competitive breakdown vs Obsidian, Swimm, Graphify, and Outline.
  5. Curated logical codebase map (structuring `client/`, `server/`, `docs/`, `skills/`).
  6. AI Agent integration guide with Model Context Protocol (MCP) and slash commands.
- **Explicit Do-Nots:**
  - No third-party badge services (`shields.io`, `readme-typing-svg`, fake counters).
  - No vague AI buzzwords or fluff prose. Every claim must trace directly to test telemetry.
  - Never alter or rename files on disk (`PRINCIPLES.md §16`).
  - Keep visible attribution: `<!-- forged-with: git-a-profile -->`.

---

## 3. Brand Identity & Sampled Palette (§7)

Colors sampled directly from `runs/chapters-app/tokens.json`, `client/src/index.css` (Observatory Bridge Dark Theme), and `client/public/favicon.svg`:

| Token Name | Hex Code | OKLCH / CSS Mapping | Role in README |
|---|---|---|---|
| **Substrate Dark** | `#070A0F` | `oklch(12% 0.015 250)` | Deep Obsidian canvas & card background |
| **Card Elevated** | `#0F141F` | `oklch(17% 0.02 245)` | Elevated surface for charts & code frames |
| **Border Slate** | `#1C2433` | `oklch(24% 0.03 245)` | Precision hairline border |
| **Text Primary** | `#E2E8F4` | `oklch(93% 0.015 240)` | High-contrast body & header typography (16:1 ratio) |
| **Text Muted** | `#8B9BB4` | `oklch(68% 0.03 240)` | Subtitles, parameter notes, table metadata |
| **Primary Human Blue** | `#5B8DEF` | `oklch(65% 0.15 255)` | Human action key, primary badges, links |
| **AI / MCP Teal** | `#3FB8AE` | `oklch(72% 0.13 180)` | AI agent indicator, MCP tool counts, AST tags |
| **Success Emerald** | `#2EC47C` | `oklch(70% 0.16 145)` | 100% SLO passes, benchmark winners, checkmarks |
| **Warning Amber** | `#F59E0B` | Standard Amber | Secondary notes, cautions |
| **Alert Vermillion** | `#C2472A` | Revision Ink | Human revision marker, chaos test injection |

---

## 4. Empirical Data & Test Telemetry Harvested (§8)

### 4.1 Production Hardware Telemetry (`sohrab` Contabo VPS)
- **Host Specs:** 12 Dedicated vCPUs AMD EPYC 7282 @ 2.80GHz, 48 GB DDR4 ECC RAM, 400 GB NVMe SSD, Ubuntu 24.04 LTS (Kernel 6.8.0-45).
- **Background Daemon:** 500ms synchronous Linux `cgroups v2` sampler monitoring microsecond CPU (`usage_usec`), memory RSS (`memory.current`), and disk I/O.

### 4.2 The 15 Master Test Plans (TP-01 to TP-15)
1. **`TP-01` IR Retrieval Accuracy:** Single-threaded Chroma NDCG@10 1.37 vs pgvector 1.15; pgvector dominates under concurrency.
2. **`TP-02` Autonomous AI Navigation:** 90.0% scenario success across 10 complex multi-turn developer workflows; 3.0 tool turns avg (50% reduction in agent thrashing).
3. **`TP-03` Incremental Git Sync & Ghost Purge:** 100% symbol purge precision (0 ghost symbols); incremental diff sync in 2.40s.
4. **`TP-04` Chaos Recovery:** 0 corrupted notes under mid-write SIGKILL; sub-second self-healing in 525.8 ms.
5. **`TP-05` Real-Time CRDT Multi-Client Stress:** 20 concurrent writers, 100% SHA256 convergence, 0.09 ms p95 broadcast latency, document compacted to 4.02 KB.
6. **`TP-06` Massive Scale Volume Soak:** 50,000 notes, 250,000 vectors; warm search p50 of 35.57 ms; 95.0% buffer cache hit ratio; 4.99 MB / 1k docs.
7. **`TP-07` Enterprise Security & Penetration Matrix:** 21/21 attack probes blocked (0 cross-vault leaks, 0 path traversals, 0 SSRF, 0 privilege escalations).
8. **`TP-08` Embedding Outage & Backpressure:** 100% vector parity across 429 throttles & 503 blackouts; 0 lost jobs.
9. **`TP-09` Polyglot Tree-sitter Torture:** 92,245 LOC/sec sustained throughput; 20,114 code symbols extracted across TypeScript, Go, Python, Rust, C++.
10. **`TP-10` Context Window Budgeting:** 1.52% MAPE token estimation error; 0 context overflows; BPE cl100k-calibrated compaction.
11. **`TP-11` Multi-Tenant Noisy Neighbor:** 13,000+ request flood; interactive tenant p50 shifted only +1.7 ms; 98.2% rogue flood shed via 429.
12. **`TP-12` Pathological Graph Topology:** 10k-edge star expansion p95 in 0.65 ms; Dijkstra shortest-path in 0.03 ms; 0 deadlocks.
13. **`TP-13` Multilingual & Technical Search:** 100% CJK & RTL Recall@5; 100% Code Symbol Recall@1; 0.64 ms avg search.
14. **`TP-14` Vault Portability & WAL PITR:** 100% OKF v0.2 conformance; 9.2 MB/s export; 100% recovery on WAL replay (0 notes lost).
15. **`TP-15` 24-Hour Continuous Memory Soak:** 100% uptime; 0.374 MB/hr drift slope; total RSS delta +8.23 MB; 0 connection leaks; 0 FD leaks.

### 4.3 Vector Engine Showdown: `pgvector` vs `ChromaDB`
- **QPS at $c=25$ workers:** `pgvector` **10.87 QPS** vs Chroma 8.83 QPS (**+23.1% higher**)
- **QPS at $c=10$ workers:** `pgvector` **8.80 QPS** vs Chroma 6.68 QPS (**+31.7% higher**)
- **Tail Latency p95 ($c=10$):** `pgvector` **1,425 ms** vs Chroma 2,620 ms (**84% lower tail latency**)
- **Memory Drift Under Concurrency:** `pgvector` **+3.13 MB flat** vs Chroma **+152.7 MB surge**
- **Infrastructure:** `pgvector` 2 containers (app + db) with single atomic ACID transaction vs Chroma 3 containers with dual-write drift.

---

## 5. Chartable Structure Candidates (§5)

1. **Candidate 1: Vector Engine Concurrency & Latency Ladder**
   - *What it shows:* QPS throughput curve and p95 tail latency comparing `pgvector` vs `ChromaDB` across 1, 5, 10, and 25 concurrent workers.
   - *Value:* Gives instant visual proof of the empirical test results.
2. **Candidate 2: The 15 Master Test Plans (TP-01 – TP-15) Executive Matrix**
   - *What it shows:* A high-density dashboard table/grid linking to each test report and interactive HTML dashboard, showing Workload, Key Metric, and 100% Pass status.
   - *Value:* Fulfills the user's explicit request for direct links and stats from our tests.
3. **Candidate 3: End-to-End System & Dual-Index Architecture Flow**
   - *What it shows:* How Plain Markdown (OKF v0.2) + Git Repositories flow through Tree-sitter AST extraction, CRDT relay, PostgreSQL 17 + pgvector, and Fastify MCP server (57 tools / 20 prompts) to AI agents (Claude, Cursor, Antigravity).
   - *Value:* Teaches how the engine actually works.
4. **Candidate 4: Competitive Breakdown Matrix**
   - *What it shows:* Chapters vs Obsidian, Swimm, Graphify, and Outline across 10 dimensions (plain files, CRDT multiplayer, AST symbol links, unified graph, MCP server, vector DB).
5. **Candidate 5: Curated Codebase Map (§16)**
   - *What it shows:* Logical architecture map of the repository (`client/`, `server/`, `docs/`, `benchmarks/`, `skills/`).

---

## 6. Three Signature Concepts Proposed (§4)

### Concept 1: The Observatory Control Deck (Recommended)
- **Vibe:** Mission-control flight deck. Deep obsidian substrate (`#070A0F`), crisp hairline gridlines, cyan/blue signal telemetry.
- **Hero Asset:** An animated SVG banner styled as a dual-pane engineering console: left pane showing live knowledge graph topology with pulsing semantic bridges; right pane showing real-time test telemetry dials (10.87 QPS, 92k LOC/s, 0.37 MB/hr drift, 100% SLO Pass).
- **Reinvented Badge System:** "Telemetry Status Modules" — dark monolithic rectangular blocks with glowing status pips (`[● 100% OKF v0.2]`, `[● 57 MCP Tools]`, `[● pgvector HNSW]`, `[● Yjs CRDT]`).
- **Showcase / Navigation:** Curated, collapsible flight decks linking directly to:
  1. *Executive Benchmark Suite* (Reports 01 to 07 + interactive HTML dashboards)
  2. *Master Test Runs* (TP-01 to TP-15)
  3. *AI Agent Integration Deck* (MCP tools, slash commands, agent skills)
  4. *Core Codebase Structure* (Curated logical map)
- **Visual Charts:** Native Mermaid data-flow diagrams + custom committed SVG telemetry charts with dark-mode contrast.

### Concept 2: The Architectural Blueprint Matrix
- **Vibe:** Technical CAD blueprint, precision engineering drawing, clean cyan-on-slate grid.
- **Hero Asset:** Isometric architectural schematic SVG illustrating the dual indexing pipeline (Markdown filesystem on the left, Git Tree-sitter AST on the right, converging into the unified PostgreSQL knowledge graph).
- **Reinvented Badge System:** "Schematic Pin Tags" — IC-chip style connector pins with technical parameter specs and micro-callouts.
- **Showcase / Navigation:** Layered structural blueprints representing the 4 platform tiers (Storage Layer, Computation/CRDT Layer, Retrieval Layer, Protocol/MCP Layer).

### Concept 3: The UNIX Terminal Telemetry Monolith
- **Vibe:** Minimalist, brutalist, high-density terminal screen. Raw performance and uncompromising clarity.
- **Hero Asset:** Dynamic VT100-style terminal window SVG displaying real-time benchmark command execution, memory allocations, and cgroup telemetry logs.
- **Reinvented Badge System:** Terminal flag chips (`--crdt=yjs`, `--vector=pg17+hnsw`, `--throughput=92k-loc-s`).
- **Showcase / Navigation:** High-density Markdown data tables and ASCII diagrams.

---

## 7. Gate A Decision Checklist

Present to user:
1. **Intake & Vibe**: Does the "Observatory Control Deck" match your vision for Chapters?
2. **Concept Selection**: Pick Concept 1 (Observatory Control Deck), Concept 2 (Blueprint Matrix), or Concept 3 (UNIX Monolith).
3. **Diagrams & Charts**:
   - Vector Engine Performance Chart (`pgvector` vs `ChromaDB` QPS & Latency)
   - Master Test Suite Matrix (TP-01 to TP-15 with links to all 7 reports and HTML dashboards)
   - Dual-Index Architecture Flow
   - Competitive Comparison Matrix
4. **Rendering Style Choice (§5)**:
   - Option A: Code-rendered (Native GitHub Mermaid diagrams + rich Markdown tables) — clean, dark/light native, zero file rot.
   - Option B: Graphical (Custom committed SVG charts and badges + Mermaid) — richest visual presentation with animated SVG hero and custom telemetry badges.
   - Option C: Hybrid — Custom committed SVG Hero & Telemetry Badges + Native GitHub Mermaid diagrams for architectural workflows + Markdown tables for dense stats. (Recommended)
