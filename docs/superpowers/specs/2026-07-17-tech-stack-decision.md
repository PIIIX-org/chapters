# Chapters — Tech Stack Decision

Marks the transition from design phase to implementation. Decided
2026-07-17 with one governing criterion, set by the project owner: **the
stack must serve AI navigability best** — the platform's defining promise
(AI-navigable graph, MCP-first access, search tuned for AI recall).

## Decision: TypeScript end to end

One language, one runtime, one deployable unit.

| Layer | Choice |
|---|---|
| Runtime | Node.js (current LTS) |
| HTTP API | Fastify |
| Realtime sync relay | Hocuspocus (Yjs server) — same process as the API |
| CRDT | Yjs |
| Frontend | React + Vite |
| Editor | CodeMirror 6 + y-codemirror.next (already named in the Editor spec) |
| Database | PostgreSQL |
| Keyword search | Postgres full-text search |
| Embeddings | Local ONNX model via Transformers.js (default: `bge-small-en-v1.5`) |
| Vector search | pgvector |
| Graph analysis | graphology |
| MCP server | Official MCP TypeScript SDK |
| Repo layout | pnpm workspaces: `server/`, `client/`, `shared/` |
| Deployment | Single Docker image + docker-compose (app + Postgres) |

Notes remain plain OKF markdown files on disk (per sub-project 7's spec);
Postgres holds accounts, shares, sessions, audit/security logs,
notifications, and the search/embedding indexes — never the canonical note
content.

## Why this serves the AI-navigation criterion

- **AI navigability lives in the data layer, which is stack-neutral.**
  OKF files, the embedding index, hybrid retrieval, and MCP tool design
  determine what an AI can find — and the embedding *model* (not the
  language invoking it) determines recall. The same model produces the
  same vectors from Node or Python.
- **Where the stack does touch the AI story, TypeScript is the native
  path.** The specs' most distinctive requirement is that MCP writes flow
  through the live CRDT engine as first-class visible participants, with
  per-operation permission checks and server-initiated kicks
  (sub-projects 5 & 6). Hocuspocus provides exactly those hooks
  (per-message auth, server-side document manipulation); this is the
  riskiest subsystem, and it gets the most battle-tested tooling. The MCP
  TypeScript SDK is additionally the reference implementation.
- **Local embeddings, no external API.** Note content never leaves the
  instance to compute embeddings — consistent with the self-hosted
  privacy posture and the graph spec's "no per-query LLM calls" design.
- **A single-language monorepo with shared types is itself
  AI-navigable** — one ecosystem for AI coding agents contributing to
  Chapters' own codebase.

## Rejected: Python (FastAPI) backend + TS frontend

The stack floated early in the design phase, never finalized. Its real
advantages — `leidenalg` for true Leiden, `sentence-transformers` for
embeddings — are batch-shaped and peripheral: an AI consumer of the graph
can't tell which library computed the communities or vectors. Its costs
land on the core: two runtimes to deploy, and the CRDT relay — the
security-hardened heart of the collab+MCP design — hand-rolled on the
less mature library (`pycrdt`).

## Accepted deviations from the specs (tracked, not silent)

- **Community detection ships as Louvain first** (graphology's
  implementation), not Leiden as the graph spec names. Same family of
  algorithm, same consumer-visible output (community assignments).
  Upgrade path if cluster quality disappoints: Leiden via WASM (igraph)
  or an optional worker — an isolated batch job either way, swappable
  without touching anything else.
- **Embedding model is a pragmatic default, not the research frontier.**
  `bge-small-en-v1.5` (or a peer small model) runs on CPU at save-time on
  modest self-hosted hardware. The model is a config-level swap; the
  stored-vector format is what the design fixes.

## Build order

Unchanged from the specs: sub-projects 1 → 7 as numbered, starting with
Auth & Vault/Sharing. Each sub-project gets its own implementation plan
before code.
