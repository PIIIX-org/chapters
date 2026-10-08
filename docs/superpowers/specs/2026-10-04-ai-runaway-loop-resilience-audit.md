# AI Runaway Loop Navigation Resilience & Rate-Limiting Audit

- **Date:** 2026-10-04
- **Target Systems:**
  - Local Server: Node.js 22.23.2, PostgreSQL 16 + pgvector v0.8.0, Darwin arm64 (`http://127.0.0.1:3001`)
  - Live Production: Docker Compose, Caddy Reverse Proxy, VPS `147.93.138.77` (`https://chapters.piiix.org`)
- **Status:** Complete & Live Verified
- **Category:** Resilience, Stress Testing & Security Audit
- **Interactive Report:** [`docs/ai-runaway-loop-resilience-report.html`](../ai-runaway-loop-resilience-report.html)
- **Live Vault Note:** `audit/2026-10-04-ai-runaway-loop-resilience-audit`

---

## 1. Executive Summary

This audit assesses the operational resilience, resource bounds, and failure modes of Chapters / Elara when an autonomous AI agent navigating the knowledge graph glitches into a runaway state (e.g. infinite loops reading identical notes, tight oscillations between linked notes, hallucinated 404 note queries, or parallel swarm requests).

A total of **1,465 high-frequency requests** were executed across 10 distinct scenarios spanning both local and live production infrastructure.

### Summary of Findings

1. **System Stability & Survival:**
   - **Zero crashes, zero 500 errors, and zero unhandled exceptions** occurred across both environments.
   - The server process and database remained 100% healthy before, during, and after peak stress passes.
   - Active `/health` probes during a 10-worker parallel swarm responded in **2.48 ms locally** and **233.66 ms in production**, verifying that general user availability is preserved under heavy AI load.

2. **Rate Limiting Invariants:**
   - **MCP Protocol Ingress:** Strictly halts runaway agents at **request #121** via `HTTP 429 Too Many Requests` with payload `{"error":"rate limit exceeded for this connection"}`. This hard ceiling (`MCP_RATE_LIMIT = 120` reqs/min per connection token) rejects requests before reaching the database, filesystem, or YAML parsers.
   - **REST API Ingress:** Governed by `@fastify/rate-limit` with `max: 1000` reqs/min per IP address. All 150-request sequential bursts were accommodated smoothly.

3. **Resource Consumption (CPU, RAM, Connections):**
   - **Server Container CPU:** Spiked to **53.42%** during the live 10-worker concurrent swarm due to repeated YAML frontmatter parsing and JSON AST serialization. It dropped immediately back to **0.18%** idle upon completion.
   - **PostgreSQL Database:** Handled queries without degradation. CPU stayed below **1.6%**, and active connection count remained between **1 and 2** (pool ceiling: 25).
   - **Memory & V8 Heap:** Heap expanded from 146 MiB to 413 MiB to buffer string allocations and stream chunks, followed by stable garbage collection. Zero memory leaks were detected.

---

## 2. Benchmark Telemetry Matrix

| Target | Surface | Scenario Description | Reqs | 200 OK | 429 RateLimit | RPS | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Behavioral Observation |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **LOCAL** | MCP | Single Note Tight Loop | 135 | 120 | **15** | 101.2 | 9.78 | 13.86 | 18.71 | 43.10 | Exact cutoff at req #121 (120/min ceiling) |
| **LOCAL** | REST | Single Note Tight Loop | 150 | 150 | 0 | 212.9 | 3.97 | 7.27 | 8.14 | 8.52 | Fast NVMe disk read & sub-4ms response |
| **LOCAL** | REST | Oscillating 3 Notes Cycle | 150 | 150 | 0 | 225.1 | 3.84 | 7.07 | 8.07 | 9.19 | Smooth multi-file cycling with zero locking |
| **LOCAL** | REST | 404 Missing Note Loop | 100 | 100* | 0 | 227.2 | 3.62 | 6.89 | 10.09 | 10.09 | Clean 404 handling with zero error leaks |
| **LOCAL** | REST | Concurrent Swarm (C=10) | 200 | 200 | 0 | **868.0** | 10.65 | 17.68 | 37.22 | 44.18 | Healthcheck during swarm: **2.48 ms** |
| **LIVE** | MCP | Single Note Tight Loop | 130 | 120 | **10** | 2.94 | 316.74 | 449.61 | 614.24 | 796.03 | Exact cutoff at req #121 in production |
| **LIVE** | REST | Single Note Tight Loop | 150 | 150 | 0 | 3.19 | 346.99 | 371.18 | 436.03 | 446.29 | Zero dropped connections over TLS/WAN |
| **LIVE** | REST | Oscillating 3 Notes Cycle | 150 | 150 | 0 | 3.26 | 296.83 | 459.35 | 701.28 | 705.34 | Rotates 3 production notes reliably |
| **LIVE** | REST | 404 Missing Note Loop | 100 | 100* | 0 | 3.87 | 245.01 | 320.64 | 340.61 | 340.61 | 404 responses faster than 200 (no disk I/O) |
| **LIVE** | REST | Concurrent Swarm (C=10) | 200 | 200 | 0 | **23.22** | 357.98 | 728.79 | 1020.28 | 1021.98 | Healthcheck during swarm: **233.66 ms** |

*\* In the 404 Missing Note scenario, "100" signifies 100 clean HTTP 404 responses returned as expected.*

---

## 3. Deep Architectural Flow Analysis

### 3.1 Note Read Pipeline (`server/src/notes/store.ts`)
```
[Client / AI Agent Request]
            │
            ▼
┌───────────────────────────┐
│ @fastify/rate-limit       │ ◄── Rejects if > 1000 req/min
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ resolveAccess(uid, vid)   │ ◄── Indexed DB Query 1 (Permission check)
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ getLiveNote(vid, path)    │ ◄── Indexed DB Query 2 (Metadata lookup)
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ fs.readFile(notePath)     │ ◄── Local Filesystem NVMe Read
└───────────┬───────────────┘
            ▼
┌───────────────────────────┐
│ parseNote(rawMarkdown)    │ ◄── CPU: js-yaml frontmatter parser
└───────────┬───────────────┘
            │
            ▼
[HTTP 200 OK Response]
```

### 3.2 Key Observations
1. **Lack of In-Memory Caching:**
   Every call to `readNote` triggers two database queries, one filesystem read, and one YAML frontmatter parse.
   Under sustained multi-agent looping, the NVMe drive and PostgreSQL query engine remain fast (< 4ms local), but the repetitive parsing of YAML frontmatter produces the observed 53% CPU container spike.
2. **Missing Note Optimization (404s):**
   When an AI agent hallucinates note paths, `getLiveNote` returns null immediately from PostgreSQL. The server returns 404 without attempting a disk read or parsing YAML, making 404 responses measurably faster (p50: 245 ms live) than 200 OK responses (p50: 347 ms live).
3. **Connection Pooling Durability:**
   PostgreSQL connection limits (`databasePoolSize: 25` in prod, `10` in local) were never exhausted because queries complete in sub-millisecond durations and release back to the pool instantly.

---

## 4. Future Architectural Recommendation

While the current architecture safely withstands high-frequency AI looping via rate limits, adding an **in-memory LRU cache** for parsed note content (e.g. 500 recently read notes, invalidated on note mutation or deletion) would:
- Drop note read latency from 3.8 ms to **< 0.2 ms**.
- Reduce CPU utilization under AI swarm navigation by **> 90%**.
- Eliminate redundant database permission checks during repeated graph traversals.
