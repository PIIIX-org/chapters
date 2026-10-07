# The 15 Master Test Plans (TP-01 to TP-15)

[← Back to Main Repository](../README.md) • [View Empirical Benchmarks & Reports](../docs/benchmarks/README.md)

---

## Overview

Every release and architectural iteration of Chapters is verified through 15 rigorous, automated Master Test Plans covering retrieval accuracy, concurrency, security, and disaster recovery. All test runs produce machine-readable JSON summaries and interactive HTML inspection dashboards.

![Master Test Suite Matrix Dashboard](../assets/charts/test-matrix-dashboard.svg)

---

## Verification Matrix

| Plan ID | Test Scope | Empirical Result | SLO Target | Status | Run Dashboard |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **TP-01** | **IR Retrieval Accuracy** | NDCG@10: 1.37 (pgvector) / 1.15 (Chroma) | NDCG > 0.85 | **PASS** | [Dashboard](runs/tp-01-ir-retrieval-accuracy/report.html) |
| **TP-02** | **AI Agent Navigation** | 90% goal success in 3.0 mean turns | Goal > 80% | **PASS** | [Dashboard](runs/tp-02-agent-navigation/report.html) |
| **TP-03** | **Git Sync & Ghost Purge** | 0 ghost symbols remaining after branch delete | 0 Ghost Nodes | **PASS** | [Dashboard](runs/tp-03-git-sync/report.html) |
| **TP-04** | **Chaos Crash Recovery** | 0 corrupt notes; 525.8 ms self-healing RTO | RTO < 2,000ms | **PASS** | [Dashboard](runs/tp-04-chaos-recovery/report.html) |
| **TP-05** | **Real-Time CRDT Stress** | 20 concurrent writers, 0.09 ms broadcast | p95 < 5.0ms | **PASS** | [Dashboard](runs/tp-05-crdt-stress/report.html) |
| **TP-06** | **Scale Volume Soak** | 50,000 notes indexed; 35 ms p50 latency | p50 < 100ms | **PASS** | [Dashboard](runs/tp-06-volume-soak/report.html) |
| **TP-07** | **Security Penetration** | 21 of 21 attack probes blocked | 100% Blocked | **PASS** | [Dashboard](runs/tp-07-security-audit/report.html) |
| **TP-08** | **Embedding Resilience** | 100% vector parity during model swap; 0 lost | 100% Parity | **PASS** | [Dashboard](runs/tp-08-embedding-resilience/report.html) |
| **TP-09** | **Tree-sitter Torture** | 92,245 LOC/sec sustained throughput | > 25,000 LOC/s | **PASS** | [Dashboard](runs/tp-09-treesitter-torture/report.html) |
| **TP-10** | **Context Budgeting** | 1.52% MAPE token estimator accuracy | MAPE < 5.0% | **PASS** | [Dashboard](runs/tp-10-context-budgeting/report.html) |
| **TP-11** | **Noisy Neighbor QoS** | 13k burst requests; +1.7 ms baseline impact | Delta < 10ms | **PASS** | [Dashboard](runs/tp-11-noisy-neighbor/report.html) |
| **TP-12** | **Pathological Graph** | 10,000 synthetic edges resolved in 0.65 ms | Latency < 10ms | **PASS** | [Dashboard](runs/tp-12-graph-topology/report.html) |
| **TP-13** | **Multilingual Search** | 100% accuracy on Arabic & CJK; 0.64 ms p50 | Acc > 95% | **PASS** | [Dashboard](runs/tp-13-multilingual-search/report.html) |
| **TP-14** | **Portability & PITR** | 100% OKF fidelity; zero data loss | 100% Fidelity | **PASS** | [Dashboard](runs/tp-14-portability-pitr/report.html) |
| **TP-15** | **24H Memory Soak** | 0.374 MB/hr drift; 0 connection leaks | Drift < 0.50 MB/h | **PASS** | [Dashboard](runs/tp-15-soak-memory-leak/report.html) |

---

## Test Suite Architecture & Categorization

The 15 Master Test Plans are grouped into four architectural pillars:

### 1. Information Retrieval & AI Agent Reasoning
- **TP-01 (IR Accuracy)**: Validates reciprocal rank fusion against industry benchmarks (TREC-COVID, BEIR).
- **TP-02 (AI Agent Navigation)**: Verifies multi-turn MCP tool invocation chains across complex note/code graphs.
- **TP-10 (Context Budgeting)**: Tests token budgeting accuracy to ensure AI prompts stay within context ceilings.
- **TP-13 (Multilingual Search)**: Audits non-Latin tokenization and vector similarity across Arabic, CJK, and mixed scripts.

### 2. Concurrency & Real-Time Synchronization
- **TP-05 (CRDT Stress)**: Spins up 20 headless WebSocket clients firing concurrent character insertions into Milkdown Yjs documents.
- **TP-06 (Volume Soak)**: Synthesizes 50,000 OKF Markdown documents and measures p50/p95/p99 query latencies.
- **TP-11 (Noisy Neighbor QoS)**: Bursts 13,000 requests against high-traffic vaults while measuring tail impact on isolated sibling tenants.

### 3. Ingestion, Parsing & AST Indexing
- **TP-03 (Git Sync & Ghost Purge)**: Validates Git shallow sync and verifies zero ghost AST symbols remain after branch deletion.
- **TP-08 (Embedding Resilience)**: Swaps embedding model providers mid-flight and validates zero lost vectors and schema parity.
- **TP-09 (Tree-sitter Torture)**: Ingests massive multi-file codebases (TypeScript, Go, Python, Rust, C++) at over 92,000 LOC/sec.
- **TP-12 (Pathological Graph)**: Benchmarks Louvain clustering and Dijkstra shortest-path algorithms across dense 10,000-edge topologies.

### 4. Enterprise Security, Resilience & Soak
- **TP-04 (Chaos Crash Recovery)**: Injects SIGKILL directly into the backend process during active writes to verify WAL recovery.
- **TP-07 (Security Penetration)**: Executes 21 automated attack vectors including SSRF, path traversal, and privilege escalation probes.
- **TP-14 (Portability & PITR)**: Validates export/import fidelity and point-in-time recovery compliance.
- **TP-15 (24-Hour Memory Soak)**: Runs continuous 24-hour load testing to monitor V8 heap slopes, handle leaks, and socket buffers.

---

[← Return to Chapters Main README](../README.md)
