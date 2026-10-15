# Benchmarks: retracted

[← Back to Main Repository](../README.md)

The TP-01 to TP-15 "Master Test Plans" results that this page used to list are **retracted pending a reproducible benchmark**. Do not cite them.

Why:
- The runners that produced them were never merged. They exist only on the unmerged `dev-chroma` branch, and they ran against production.
- Some reported results are impossible. TP-01 listed an NDCG@10 of 1.37, but NDCG cannot exceed 1; the run's own verdict was a failure.
- Other results did not measure Elara: the "24-hour soak" covers 29 ms of telemetry, the "agent navigation" plan involves no language model, and the graph-latency plan times a function defined inside the test script.

The same applies to the reports under [`docs/benchmarks/`](../docs/benchmarks/README.md) and to the artifacts kept in `runs/`.

The evidence is in the Elara vault note `audit/2026-10-14-ai-performance-study` (Chapters vault). A replacement benchmark will be published here only with a runner that is merged into this repository, runs against a disposable instance, and can be re-run by anyone.
