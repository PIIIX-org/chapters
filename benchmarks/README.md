# Premise benchmark

[← Back to Main Repository](../README.md)

Elara exists so agents find information faster, more accurately and with
fewer tokens. This benchmark measures exactly that, on every change that can
move it: **how many tokens and tool calls a scripted agent needs to reach
the evidence for a question**, using Elara's MCP tools, compared with the
same agent using ripgrep and ranged reads on a checkout of the same commit.
It is the release gate for retrieval and token changes (#570, #572).

**These are the only benchmark numbers that may be published for Elara.**
A number is publishable when a run of `benchmarks/run.ts` in the `bench`
job of `.github/workflows/elara-lab.yml` produced it, its run is linked, and
it is recorded in [`baseline.json`](baseline.json) (or shown as a delta by
the gate). Nothing measured against production, by an unmerged runner, or
by hand. The TP-01 to TP-15 results that used to be listed here, the reports
under [`docs/benchmarks/`](../docs/benchmarks/README.md) and the artifacts
in `runs/` are **retracted**: their runners were never merged, they ran
against production, and some results are impossible (TP-01 reported
NDCG@10 = 1.37; NDCG cannot exceed 1). Do not cite them. Evidence: Elara
vault note `audit/2026-10-14-ai-performance-study`.

## Method

| part | file |
|---|---|
| questions, pinned repositories, gold evidence, grep keywords | [`questions/*.json`](questions/) |
| metrics (hit@k, MRR, NDCG@10, line precision/recall, tokens) | [`lib/metrics.ts`](lib/metrics.ts) |
| the two scripted agents and their caps | [`lib/policies.ts`](lib/policies.ts) |
| ripgrep and ranged reads | [`lib/ripgrep.ts`](lib/ripgrep.ts) |
| production guard | [`lib/guard.ts`](lib/guard.ts) |
| runner (lab instance, checkouts, indexing, both policies) | [`run.ts`](run.ts) |
| gate, baseline writer, run comparison | [`../.github/scripts/bench-gate.mjs`](../.github/scripts/bench-gate.mjs) |

**Instance.** The `bench` job builds Elara from the commit under test with
the lab's compose files and bootstraps it (`docs/agents/lab.md`). The runner
refuses any base URL that is not `http://localhost|127.0.0.1|[::1]:<port>`,
so it cannot be pointed at production.

**Corpora.** Every suite pins a public repository to a full commit SHA. The
runner fetches exactly that commit, deletes `.git`, copies the tree into the
app container and connects it as a `local_path` repository (a git URL
connection follows the upstream head and re-polls every 5 minutes, so it
cannot be pinned). It waits until every file is embedded before the first
question, so indexing never competes with the measured calls. The grep
agent searches the same tree on the runner.

| suite | repository @ commit | questions | from |
|---|---|---|---|
| `chapters` | PIIIX-org/chapters @ `345f1db` | 29: 14 where-is, 15 exact identifier | study round 1 (A1-A14, S1-S15) |
| `diagram-design` | cathrynlavery/diagram-design @ `11b08ea` | 20: where, how, name, why, install | study round 2, `/elara-map` |
| `vectorcraft` | storytold/vectorcraft @ `a067177` | 20: where, how, identifier, architecture, build | study round 2 |
| `context-mode` | mksglu/context-mode @ `dbec980` | 20: where, flow, identifier, architecture, config | study round 2 |
| `rea` | PIIIX-org/rea-snapshot @ `c527772` (tree of upstream morluto/rea `ca7450b`) | 20: where, flow, identifier, architecture, config | study round 2 |

The round-1 note questions (N1-N10) are not included: their corpus is the
production Chapters and ELara vaults, which must not be queried by a
benchmark or copied into this public repository. `rea-snapshot` must stay
public and unchanged while the `rea` suite uses it (fix-list item 191).

**Questions.** Each question has: the text (the Elara agent's search
query), `relevant` files (graded 1; the ranking metrics use these),
`gold` evidence as `path:line` / `path:start-end` (verified at the pinned
commit; the runner fails if a range is past the end of its file), and
`keywords` for the grep agent: ripgrep regexes taken from the question's own
words or identifiers, never from the answer. Evidence that names a whole
file without lines counts as relevant but not as gold.

**The two agents.** No language model is involved; each agent is a fixed
procedure, so a run is deterministic up to the index Elara builds.

| | Elara agent | grep agent |
|---|---|---|
| ranking call | MCP `search {query: question, repositoryId, limit: 10}` | `rg --count -i -e <keywords>` over the checkout, files sorted by matching lines (ties by path), first 50 shown |
| then, per ranked file, best first | MCP `read_file` (the whole file; Elara has no line ranges) | `rg -n` in that file (first 50 lines, each cut at 200 characters), then up to 3 ranged reads of 41 lines (10 before, 30 after a match not yet shown) |
| lines put in context | whole files read; for `search` symbol hits, the snippet's lines (file hits carry a keyword headline without line numbers, so they show none) | the `rg -n` lines and the ranged reads |

Both stop as soon as every gold range has been in their context (an oracle
stop, identical for both, so the benchmark measures retrieval and not answer
judgment), or at a cap: 15 calls, no new call after 40,000 tokens, at most
10 files of the ranking, and every response cut at 100,000 characters
(25,000 tokens, what an agent harness shows of one tool result). Tokens are
characters / 4 of what the agent was shown (no tokenizer is installed in the
runner; the same estimate applies to both agents).

**Metrics** (per suite, means over questions):

| metric | meaning |
|---|---|
| `hit1`, `hit5`, `hit10` | a relevant file is among the first 1/5/10 distinct files of the ranking call |
| `mrr` | 1 / rank of the first relevant file (0 when none) |
| `ndcg10` | DCG@10 of the distinct ranked files over the ideal DCG@10 of the judged relevances (gain / log2(rank + 1)); a file counts once; always in [0, 1] |
| `goldReached` | questions where the first gold range was fully seen |
| `tokensToGold`, `tokensToGoldMedian` | tokens received until the first gold range was fully seen; a miss counts as 65,000 (the most an episode can spend: budget + one capped response) |
| `callsToGold` | calls until then; a miss counts as 15 |
| `linePrecision`, `lineRecall` | gold lines seen / lines seen, gold lines seen / gold lines, at the end of the episode |
| `tokens`, `calls` | spent per question (whole episode) |
| `msMedian` | median wall time of an episode: MCP round trips for Elara, ripgrep and file reads for grep (not comparable across machines; reported, never gated) |

Unit tests: `node --test 'benchmarks/lib/*.test.ts'` (CI `checks` job),
including the NDCG properties (in [0, 1] over 2,000 random graded rankings,
perfect ranking = 1, a document returned several times counts once, the
ideal comes from the judgments) and the production guard.

## Gate

The `bench` job compares the run with [`baseline.json`](baseline.json)
(`.github/scripts/bench-gate.mjs`) and prints the delta table in the job
summary. Gated: the Elara agent's `hit5` and `tokensToGold`, per suite.

- **Regression** (red): `hit5` drops by more than 1 question of the suite,
  or `tokensToGold` rises by more than 10 %. On a pull request the reference
  is the **base commit's** baseline and the base commit's copy of the gate,
  so a PR cannot lower the bar it is judged by.
- **Stale baseline** (red): the run differs from the PR's `baseline.json`
  by more than the same tolerance in either direction. An improvement must
  be recorded in the same PR; so must any change of questions, keywords or
  policy configuration (the suite's `fingerprint` changes), or of the index
  outcome.

Thresholds: see [Noise](#noise) for the two runs of the same commit they are
set against.

| tier | when | suites |
|---|---|---|
| chapters | PRs to `dev` that touch `server/src/{search,mcp,repositories,db}/`, `server/drizzle/`, `server/package.json`, `pnpm-lock.yaml`, `Dockerfile`, `docker-compose.yml`, `benchmarks/`, the lab plumbing it uses, the workflow or the gate | `chapters` |
| all | nightly on `dev`, every PR to `prod` (promotion), by hand | all five |

The job is not a required status check yet (fix-list item 177); treat a red
`bench` job as blocking review. A deliberate trade-off (worse on one gated
metric for a reason) is an owner decision recorded in the PR.

## Run it

```sh
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f tier=none -f bench=chapters   # or bench=all
gh run download <run-id> -R PIIIX-org/chapters -n bench-results -D bench-results
```

`tier=none` skips the lab tests; the bench job builds its own instance.
Locally (Linux, Docker, bun, ripgrep): bring the lab up as in
`docs/agents/lab.md` (`docker compose -f docker-compose.yml -f
lab/docker-compose.lab.yml up -d --build`, `bun lab/bootstrap.ts`), then
`BENCH_SUITES=chapters bun benchmarks/run.ts`.

Record a run as the baseline (only from a CI run of the PR's head, linked in
the PR):

```sh
node .github/scripts/bench-gate.mjs --write-baseline bench-results/results.json
node .github/scripts/bench-gate.mjs --compare run-a/results.json run-b/results.json   # noise between two runs
```

`--write-baseline` replaces the entries of the suites in that run and keeps
the others.

## How to read a run

`bench-results/results.json` holds, per suite: the fingerprint, the index
outcome (files, symbols, seconds), both agents' aggregates, and per question
both agents' rank, tokens and calls to gold, line precision/recall, the top
10 files and the trace of every call (tool, argument, tokens, truncated,
ms). `gate.md` (also the job summary) is the delta table plus the questions
whose Elara rank or tokens-to-gold changed. The Elara column is the product;
the grep column is what an agent gets without Elara. A lower `tokensToGold`
than grep is the premise; the baseline below says where Elara stands.

## Current numbers

Elara at `dev` 751982d (the code of commit a941c16), run
[38848135892](https://github.com/PIIIX-org/chapters/actions/runs/38848135892),
recorded in [`baseline.json`](baseline.json). Means per question; tokens are
characters / 4; a miss costs 65,000 tokens and 15 calls.

| suite | hit@5 Elara / grep | NDCG@10 Elara / grep | gold reached Elara / grep | tokens-to-gold mean Elara / grep | tokens-to-gold median Elara / grep | tokens per question Elara / grep | line precision Elara / grep |
|---|---|---|---|---|---|---|---|
| chapters (29) | 0.97 / 0.69 | 0.79 / 0.60 | 29 / 23 | 3,812 / 14,442 | 1,662 / 759 | 6,589 / 3,393 | 0.025 / 0.094 |
| diagram-design (20) | 0.90 / 0.75 | 0.66 / 0.49 | 19 / 16 | 13,944 / 15,373 | 8,212 / 2,457 | 24,647 / 9,198 | 0.024 / 0.038 |
| vectorcraft (20) | 0.70 / 0.60 | 0.35 / 0.32 | 13 / 10 | 30,776 / 33,986 | 21,410 / 35,896 | 33,952 / 6,805 | 0.017 / 0.114 |
| context-mode (20) | 0.75 / 0.85 | 0.52 / 0.57 | 11 / 8 | 40,423 / 40,247 | 53,041 / 65,000 | 48,321 / 14,101 | 0.035 / 0.038 |
| rea (20) | 0.60 / 0.65 | 0.28 / 0.34 | 13 / 11 | 30,872 / 30,602 | 16,779 / 5,745 | 28,637 / 6,865 | 0.019 / 0.044 |

How to read it, honestly:

- **Finding the right file**: Elara's search ranks a relevant file in the
  top 5 more often than keyword grep on three repositories (chapters,
  diagram-design, vectorcraft) and less often on two (context-mode, rea).
- **Cost to the evidence**: Elara reaches gold on more questions in every
  suite, so its mean tokens-to-gold (where a miss costs 65,000) is lower on
  chapters, diagram-design and vectorcraft and within 1 % of grep's on
  context-mode and rea. When both find it, grep is usually cheaper: grep's
  median tokens-to-gold is lower on chapters, diagram-design and rea.
- **Cost per question**: Elara spends 1.9 to 5 times more tokens per
  question than grep on every repository. The cause is `read_file`: it
  returns whole files (no line ranges), so Elara's line precision is the
  lowest in every suite.
- On chapters most Elara answers come from the search response itself: a
  symbol hit shows the definition lines (22 of 29 questions, 13 of the 15
  identifier questions, reach gold in 1 call). Repositories whose code
  Elara does not extract (vectorcraft: Rust, 6 symbols for 1,609 files) or
  whose answers live in Markdown and config get no such shortcut.
- Latency (`msMedian`) is measured on the lab runner with no other load and
  says nothing about production.

## Noise

Two `bench=all` runs of the same commit
([38848135892](https://github.com/PIIIX-org/chapters/actions/runs/38848135892),
[38848138390](https://github.com/PIIIX-org/chapters/actions/runs/38848138390);
compare with `--compare`). The grep agent is deterministic: identical in
every metric. Elara:

| suite | hit@5 | tokens-to-gold mean | questions that changed |
|---|---|---|---|
| chapters | 0.9655 / 0.9655 | 3,812 / 3,799 (-0.3 %) | 6: ranks of tied hits (S1 1 to 3, A4 and S12 3 to 2) and response sizes |
| context-mode | 0.75 / 0.75 | 40,423 / 39,868 (-1.4 %) | 1: W4 reached gold at 53,898 tokens in one run and missed in the other |
| diagram-design | 0.9 / 0.9 | 13,944 / 13,944 | 0 |
| rea | 0.6 / 0.6 | 30,872 / 30,876 | 2 (tokens only) |
| vectorcraft | 0.7 / 0.7 | 30,776 / 30,776 | 0 |

A third instance (the first `chapters` run of PR #622,
[38852760271](https://github.com/PIIIX-org/chapters/actions/runs/38852760271))
moved one question across the top-5 line (A1, rank 3 to 6): hit@5 0.9655
to 0.931, exactly the one-question tolerance, with tokens-to-gold within
10 %.

Between the two runs hit@5 did not move and tokens-to-gold moved by at most 1.4 %. The gate's
tolerances (hit@5: one question per suite; tokens-to-gold: 10 %) are above
that noise; one question that flips between hit and miss can still move a
suite with a low mean (chapters) by more than 10 %, and the gate treats that
as material, because reaching the evidence or not is the premise.

## Future: LLM-agent A/B trials

Fix-list item 174 covers scheduled trials with a real agent; this harness
does not run a language model. The study's 8 blind A/B tasks (Elara-only
vs local-only, graded on correctness, completeness and false claims) are the
starting set: T1 how an MCP `edit_note` reaches disk; T2 the blast radius of
a rename; T3 onboarding to the search subsystem; T4 checking a vault note
(`specs/repository-sync-flow`) against the code; T5 how `[[repo:...]]` links
become graph edges; T6 the five most recent significant bugs; T7 MCP bearer
token scoping; T8 where a 1 MB note-body cap must be enforced. The tasks,
the answers of both arms and the grading are in the Elara vault note
`audit/2026-10-14-ai-performance-study-round-2`. That round ran against
production, so its timings and token counts are not benchmark numbers and
are not quoted here; a trial built under item 174 will measure them against
the lab like this benchmark does.
