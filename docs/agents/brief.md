# Chapters — Project Brief

One page. Read this first, every session.

## What

Chapters is an open-source, self-hostable "second brain" web platform: a
team knowledge base of plain markdown + YAML notes (OKF format), a
live-preview editor (CodeMirror 6), real-time collaboration (Yjs CRDT),
and — its defining promise — **an AI-navigable knowledge graph** with
permission-scoped MCP access. One deployment serves one organization.

## Why

Every existing tool forces a trade-off: Obsidian has no server/team mode,
SaaS tools hold notes hostage in proprietary formats, enterprise catalogs
aren't for note-taking. Chapters keeps plain files on disk, adds a real
server, and structures the graph so an AI assistant can navigate it
accurately. Full origin story: repo `README.md`.

## Source of truth

- Design: `docs/superpowers/specs/` — 12 specs (7 sub-projects + security
  audit + notifications + admin dashboard + MFA + tech stack). The specs
  are final; implementation follows them, deviations get tracked in
  writing.
- Stack: `docs/superpowers/specs/2026-07-17-tech-stack-decision.md` —
  TypeScript end to end, chosen for best AI navigability.
- Operations: the other files in this folder (`implementation.md`,
  `handling-protocols.md`, `github-workflow.md`, `STATE.md`).

## Build order

Sub-projects 1 → 7 as numbered in the specs: Auth & Vault/Sharing →
Editor → Graph engine → Search → Real-time collab → MCP → Data export.
Cross-cutting specs (notifications, admin dashboard, MFA) slot in after
their dependencies.

## Current phase

**Backend only.** The UI is deferred until the backend is done and the
UI's page-by-page structure has been designed; then the UI phase starts
(shadcn MCP for components, GSAP + anime.js for motion — see
`implementation.md`). Current position and next step: `STATE.md`.
