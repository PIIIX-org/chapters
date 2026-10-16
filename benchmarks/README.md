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
the gate). Numbers of real AI agents doing tasks come only from the
scheduled [agent trial](#agent-trial) (#571). Nothing measured against
production, by an unmerged runner, or by hand. The TP-01 to TP-15 results
that used to be listed here, the reports
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
words or identifiers (or a word form of them: `fused` → `fus(e|ed|es|ion)`),
never from the answer. Evidence that names a whole file without lines counts
as relevant but not as gold.

**The two agents.** No language model is involved; each agent is a fixed
procedure, so a run is deterministic up to the index Elara builds.

| | Elara agent | grep agent |
|---|---|---|
| ranking call | MCP `search {query: question, repositoryId, limit: 10}`; hits of exactly equal score are read in path order (the server leaves such ties to row order, #623) | `rg --count -i -e <keywords>` over the checkout, files sorted by matching lines (ties by path), first 50 shown |
| where in the files | (the `search` response itself) | one `rg -n -i -m 5 -e <keywords> -- <top 10 files>`: the first 5 matching lines of each, each line cut at 200 characters |
| reads, best file first | MCP `read_file` of each hit (the whole file; Elara has no line ranges) | up to 2 ranged reads per file of 41 lines (10 before, 30 after a match the earlier read did not show) |
| lines put in context | whole files read; for `search` symbol hits, the snippet's lines (file hits carry a keyword headline without line numbers, so they show none) | the `rg -n` lines and the ranged reads |

Note that the grep ranking lists up to 50 files and Elara's at most 10
hits; hit@k, MRR and NDCG are cut at 10, so this does not favour either.

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
| `tokensToGoldReached` | the same, mean over the questions this agent reached (misses left out) |
| paired (job summary, `paired` in results) | mean tokens-to-gold of both agents on the questions **both** reached: the like-for-like cost |
| `callsToGold` | calls until then; a miss counts as 15 |
| `linePrecision`, `lineRecall` | gold lines seen / lines seen, gold lines seen / gold lines, at the end of the episode |
| `tokens`, `calls` | spent per question (whole episode) |
| `msMedian` | median wall time of an episode: MCP round trips for Elara, ripgrep and file reads for grep (not comparable across machines; reported, never gated) |

Unit tests: `node --test 'benchmarks/lib/*.test.ts'` (CI `checks` job),
including the NDCG properties (in [0, 1] over 2,000 random graded rankings,
perfect ranking = 1, a document returned several times counts once, the
ideal comes from all the judgments: the TP-01 runner hardcoded an ideal DCG
for one exact match while it credited relevance to every file in the same
folder, which is how it reported 1.37) and the production guard.

## Gate

Every bench run is **three instances** (three `bench` jobs, three lab
instances of the same build); `bench-gate` takes the per-metric median of
the three and compares it with [`baseline.json`](baseline.json)
(`.github/scripts/bench-gate.mjs`), and prints the delta table in the job
summary. Gated: the Elara agent's `hit5` and `tokensToGold`, per suite.

- **Regression** (red): `hit5` drops by more than 2 questions of the suite,
  or `tokensToGold` rises by more than 10 %. On a pull request the reference
  is the **base commit's** baseline, judged by the base commit's copy of the
  gate.
- **Suite changed** (red on a PR): the suite's `fingerprint` covers the
  questions, keywords, policy configuration **and the harness source**
  (`benchmarks/run.ts`, `benchmarks/lib/*.ts`). When it differs from the base
  baseline's, the base cannot judge the run, so the gate fails unless the PR
  carries the label `bench-suite-change` and a line
  `Bench-suite-change: <why>` in its body. The summary then shows the base
  baseline, the PR's baseline and the run side by side for the reviewer.
- **Baseline lowered** (red on a PR): the PR's `baseline.json` records a
  worse `hit5` or `tokensToGold` than the base's. Needs the label
  `bench-baseline-lowered` and a line `Bench-baseline-lowered: <why>`. So
  the bar only goes down by an owner decision, never one tolerance per PR.
  The same holds for a promotion to `prod`, whose base is `prod`'s baseline.
- **Stale baseline** (red): the run differs from the PR's `baseline.json`
  by more than the tolerance in either direction (an improvement must be
  recorded in the same PR), or its fingerprint or index outcome differs.

Labels and the PR body are read when the gate runs: after adding an
override, re-run the `bench-gate` job. The gate and its tolerances come
from the base commit, but the workflow file comes from the PR, so a PR
could still edit the job itself. `bench-gate` is a required check (#574),
so the job cannot simply be dropped, but an edited job can still pass:
reviewers read every change to `benchmarks/`, the gate and the workflow.
There are no code owners: with one account, a code-owner review could
never be given.

Thresholds: hit@5 two questions = the measured noise of one instance (one
question, see [Noise](#noise)) plus one question of margin; tokens-to-gold
10 % against at most 5.6 % measured.

| tier | when | suites |
|---|---|---|
| chapters | PRs to `dev` that touch `server/src/{search,mcp,repositories,db}/`, `server/src/{config,index,app}.ts`, `server/drizzle/`, `server/package.json`, `pnpm-lock.yaml`, `Dockerfile`, `docker-compose.yml`, `benchmarks/`, the lab plumbing it uses, the workflow or the gate | `chapters` |
| all | nightly on `dev`, every PR to `prod` (promotion), by hand | all five |

`bench-gate` is a required status check on `dev` and `prod` (#574); it is
skipped, which passes, when no suite applies.

## Run it

```sh
gh workflow run elara-lab.yml -R PIIIX-org/chapters --ref <branch> -f tier=none -f bench=chapters   # or bench=all
gh run download <run-id> -R PIIIX-org/chapters -p 'bench-results-*' -D runs
```

`tier=none` skips the lab tests; each bench job builds its own instance.
Locally (Linux, Docker, bun, ripgrep): bring the lab up as in
`docs/agents/lab.md` (`docker compose -f docker-compose.yml -f
lab/docker-compose.lab.yml up -d --build`, `bun lab/bootstrap.ts`), then
`BENCH_SUITES=chapters bun benchmarks/run.ts`.

Record a run as the baseline (only from a CI run of the PR's head, all
three instances, linked in the PR):

```sh
node .github/scripts/bench-gate.mjs --write-baseline runs/bench-results-1/results.json,runs/bench-results-2/results.json,runs/bench-results-3/results.json
node .github/scripts/bench-gate.mjs --compare run-a/results.json run-b/results.json   # noise between two instances
```

`--write-baseline` records the per-metric median of the instances (a miss
counts as worst), replaces the entries of the suites in that run and keeps
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

Elara at `dev` 751982d, run
[38856349787](https://github.com/PIIIX-org/chapters/actions/runs/38856349787)
(harness 9f658fa), per-metric median of its three instances, recorded in
[`baseline.json`](baseline.json). Means per question; tokens are
characters / 4; a miss costs 65,000 tokens and 15 calls.

| suite | hit@5 Elara / grep | NDCG@10 Elara / grep | gold reached Elara / grep | tokens-to-gold mean Elara / grep | tokens-to-gold median Elara / grep | tokens per question Elara / grep | line precision Elara / grep |
|---|---|---|---|---|---|---|---|
| chapters (29) | 0.97 / 0.69 | 0.78 / 0.58 | 29 / 22 | 4,198 / 16,655 | 1,669 / 759 | 6,946 / 3,375 | 0.025 / 0.094 |
| diagram-design (20) | 0.90 / 0.75 | 0.64 / 0.49 | 19 / 16 | 14,762 / 15,373 | 11,533 / 2,457 | 25,008 / 9,198 | 0.021 / 0.038 |
| vectorcraft (20) | 0.70 / 0.60 | 0.36 / 0.32 | 13 / 10 | 30,670 / 33,986 | 20,351 / 35,896 | 34,105 / 6,805 | 0.017 / 0.114 |
| context-mode (20) | 0.75 / 0.85 | 0.56 / 0.57 | 12 / 8 | 37,927 / 40,247 | 42,028 / 65,000 | 48,904 / 14,101 | 0.036 / 0.038 |
| rea (20) | 0.60 / 0.65 | 0.30 / 0.34 | 13 / 11 | 31,282 / 30,602 | 16,779 / 5,745 | 28,310 / 6,865 | 0.022 / 0.044 |

Like for like, on the questions **both** agents reach (`paired`):

| suite | questions both reach | tokens-to-gold Elara | tokens-to-gold grep | Elara / grep |
|---|---|---|---|---|
| chapters | 22 | 3,857 | 1,273 | 3.0× |
| diagram-design | 15 | 11,122 | 2,937 | 3.8× |
| vectorcraft | 5 | 9,248 | 4,545 | 2.0× |
| context-mode | 6 | 15,398 | 3,077 | 5.0× |
| rea | 8 | 7,536 | 2,308 | 3.3× |

How to read it, honestly:

- **Finding the right file**: Elara's search ranks a relevant file in the
  top 5 more often than keyword grep on three repositories (chapters,
  diagram-design, vectorcraft) and less often on two (context-mode, rea).
- **Reaching the evidence**: Elara reaches gold on more questions in every
  suite. That is what its lower mean tokens-to-gold mostly measures: a
  miss costs 65,000, and grep misses more.
- **Cost when both reach it**: on questions both agents reach, grep is 2 to
  5 times cheaper on all five suites, and Elara spends 2 to 5 times more
  tokens per question overall. The cause is `read_file`: it returns whole
  files (no line ranges), so Elara's line precision is the lowest in every
  suite.
- On chapters many Elara answers come from the search response itself: a
  symbol hit shows the definition lines, so most identifier questions reach
  gold in one call. Repositories whose code Elara does not extract
  (vectorcraft: Rust, 6 symbols for 1,609 files) or whose answers live in
  Markdown and config get no such shortcut.
- Latency (`msMedian`) is measured on the lab runner with no other load and
  says nothing about production.

## Noise

The grep agent is deterministic: identical in every run. Elara's ranks move
between instances of identical code because the server breaks score ties by
database row order (#623); the agent breaks exact score ties by path, which
does not cover ties that change the candidate set. Measured, per suite,
Elara hit@5 / tokens-to-gold:

| suite | 3 instances of run 38856349787 | earlier single instances (harness a941c16): runs 38848135892, 38848138390, PR runs 38852760271, 38853656282 (chapters only) |
|---|---|---|
| chapters | 0.9655 / 4,198; 0.9655 / 4,199; 0.9655 / 4,184 | hit@5 0.9655, 0.9655, 0.931, 0.931 (A1 rank 3 or 6); tokens-to-gold 3,812 to 4,026 (+5.6 %) |
| diagram-design | 0.95 / 14,666; 0.9 / 15,030; 0.9 / 14,762 | 0.9, 0.9; 13,944 both |
| vectorcraft | 0.7 / 30,670 in all three | 0.7, 0.7; 30,776 both |
| context-mode | 0.75 / 37,927; 0.75 / 37,927; 0.75 / 38,304 | 0.75, 0.75; 40,423 / 39,868 (W4 reached gold in one run only) |
| rea | 0.6 / 31,282; 0.6 / 31,282; 0.6 / 31,285 | 0.6, 0.6; 30,872 / 30,876 |

So one instance moves hit@5 by at most one question and tokens-to-gold by
at most 5.6 %. The gate compares medians of three instances and allows two
questions on hit@5 (noise + one question of margin) and 10 % on
tokens-to-gold. One question flipping between hit and miss can still move
a suite with a low mean (chapters) by more than 10 %; the gate treats that
as material, because reaching the evidence or not is the premise.
(Indexing took about half as long in run 38856349787 as in the earlier
runs, on the same code; index time is reported, not gated.)

## Agent trial

The benchmark above runs no language model. The agent trial (#571) runs
real AI agents on the study's 8 blind A/B tasks, weekly, against a lab
instance built from the commit under test (the staging server; production
is never measured). **Agent numbers may only be published from this
workflow**: a run of `benchmarks/agent-trial/run.ts` in the `trial` job of
[`.github/workflows/agent-trial.yml`](../.github/workflows/agent-trial.yml),
with its run linked. Not from a dry run, not from production, not by hand.
The round-2 study's timings and token counts (vault note
`audit/2026-10-14-ai-performance-study-round-2`) ran against production and
are not quoted.

| part | file |
|---|---|
| tasks, pinned commit, key facts with file:line evidence, false claims | [`agent-trial/tasks.json`](agent-trial/tasks.json) |
| deterministic grading | [`agent-trial/lib/grade.ts`](agent-trial/lib/grade.ts) |
| the agent loop and its caps | [`agent-trial/lib/loop.ts`](agent-trial/lib/loop.ts) |
| model adapters (OpenAI-compatible, Anthropic) and the scripted dry-run model | [`agent-trial/lib/model.ts`](agent-trial/lib/model.ts) |
| the two arms' tools | [`agent-trial/lib/tools.ts`](agent-trial/lib/tools.ts) |
| what each arm is told; dry-run plans | [`agent-trial/lib/arms.ts`](agent-trial/lib/arms.ts) |
| credential gate | [`agent-trial/lib/config.ts`](agent-trial/lib/config.ts), [`agent-trial/gate.ts`](agent-trial/gate.ts) |
| optional LLM judge | [`agent-trial/lib/judge.ts`](agent-trial/lib/judge.ts) |
| runner (lab instance, checkout, indexing, both arms, results) | [`agent-trial/run.ts`](agent-trial/run.ts) |

**Tasks.** T1 how an MCP `edit_note` call reaches disk; T2 the blast radius
of renaming `regenProgressiveIndices` and changing the slug rule; T3
onboarding to the search subsystem; T4 checking a design description of
repository sync against the code; T5 how `[[repo:...]]` links become graph
edges; T6 recent significant bug fixes; T7 MCP bearer-token scoping; T8
where a 1 MB note-body cap must be enforced. All on PIIIX-org/chapters @
`345f1db`, the commit the round-2 grades used. Two prompts differ from round
2, each with an `adaptation` note in the file: T4 restates the claims of
the vault note it checked (the note is not public and a fresh instance does
not have it), and T6 asks for the fixes the code, tests and docs document
(the arms get the tree, without git history or vault notes).

**Two arms, one loop.** Both arms get the same system rules (file:line
evidence, `[INFERENCE]` for anything unverified, no answers from memory) and
the same caps, and run through the same loop:

| | Elara arm | local arm |
|---|---|---|
| source | the lab instance's MCP server, the pinned tree indexed as a `local_path` repository | a checkout of the same tree on the runner (no `.git`) |
| tools | `search`, `find_symbols`, `read_file`, `browse_repository`, `repository_status`, `graph`, `find_graph_path`, with the server's own schemas; each call is one MCP `tools/call` | `list_files` (glob), `grep` (JavaScript regex, `path:line:text`; `path` `.` or empty = the whole checkout), `read_file` (offset/limit, numbered lines; refuses a path that resolves outside the checkout, symlinks included) |
| access | a token pinned to the repository, read access, allow-listed to those tools | the checkout only |

Caps per task: 30 tool calls (the round-2 cap), 600,000 tokens in + out
summed over turns (every turn resends the context, so this bounds the
cost), 8,192 output tokens per turn, 100,000 characters per tool result,
15 minutes. They hold before every model call, not between turns
(`lib/loop.ts`):

- **Tokens.** A tool turn is sent only when it and a final answer after it
  both fit in what is left; otherwise the model gets one last turn without
  tools, whose output limit is cut to what is left, and which drops the
  newest tool results (replaced by a `[dropped: ...]` stub, counted in
  `droppedResults`) if they would not fit. If even the conversation without
  them does not fit, the episode ends with no answer. Input is estimated
  before sending as characters / 4 × 1.5, then × the largest provider
  tokens-per-estimate ratio seen in the episode plus 5 %, so the cap is hard
  to the accuracy of that estimate. The unit tests drive a model that spends
  its whole output allowance against 100,000-character tool results (1 and
  10 calls per turn); the old between-turns check let that reach 901,625 and
  1,501,568 tokens (#651 review).
- **Time.** Tools stop at 15 minutes minus a reserve for the final answer
  (a fifth of the cap, at most 3 minutes); every model request carries an
  abort signal for the time left, retries included; a tool turn cut off at
  the tool deadline is followed by the final turn (`abortedTurns`).
- **Judge.** The optional judge spends from the same 600,000 tokens (it is
  not run when it would not fit) and is cut off after 3 minutes.
- **Run.** An episode starts only while it and its judge call fit in the
  run budget (`AGENT_TRIAL_RUN_BUDGET_MIN`, 300 in the workflow, under the
  job's 350-minute timeout and GitHub's 360-minute limit); the rest are
  listed as not run. Results are written after every episode
  (`complete: false` until the end), so a cut-off run keeps what it measured.

Recorded per task and arm: tokens in and out (as the provider reports them),
tool calls, turns, wall time, stop reason, the answer and a trace of every
call (tool, arguments, size, time, the first 300 characters).

**Grading.** No language model. Each task has 7 to 17 key facts from the
round-2 ground truth, each with file:line evidence that the runner checks
at the pinned commit before any model call (the range must exist and
contain an anchor string). A fact counts as found when every one of its
case-insensitive regexes matches the answer. False claims (claims the
round-2 graders refuted, 9 over 5 tasks) are flagged per sentence or table
row when the sentence matches every pattern and carries no negation or
refutation word ("no", "not", "says", "wrong", "instead of", ...), so an
answer that repeats a claim to reject it is not flagged. Unit tests check
every fact against a sample phrasing, every false claim against a sample
and a refutation, and that a task's prompt alone scores no fact. Checked
once by hand on the 16 round-2 answers (not a CI run): each of the 9 facts
the patterns did not find is absent from that answer, and the false-claim
check flagged 5 of the graders' 11 false claims, with no flag on a true
sentence. Regexes still miss paraphrases and most false claims, so `facts`
is a floor and the false-claim count a lower bound. With
`AGENT_TRIAL_JUDGE=1` and a credential, the same model also judges each
fact; that verdict is recorded next to the deterministic one (`judge`),
never instead of it.

**Enabling it.** The owner provides no model API key for CI (#571), so
without a credential the weekly run ends green at the gate with the notice
`skipped: no agent credential (#571)` and builds nothing. The key belongs in
the `agent-trial` environment (Settings → Environments; deployment
branches: `dev` only), **not** in the repository secrets, which every
branch's workflow could read. Only a run on `dev` binds that environment;
the gate job gets only whether the key exists, and the trial job gets the
key only in a live run. To enable:

| setting | kind | value |
|---|---|---|
| `AGENT_TRIAL_API_KEY` | secret of the `agent-trial` environment | the provider key |
| `AGENT_TRIAL_MODEL` | variable (repository or environment) | the model name |
| `AGENT_TRIAL_PROVIDER` | variable, optional | `openai` (any OpenAI-compatible `chat/completions` API) or `anthropic` (messages API); default `anthropic` for `claude-*` models, else `openai` |
| `AGENT_TRIAL_BASE_URL` | variable, optional | API base (OpenAI: up to `/v1`; Anthropic: the host) |
| `AGENT_TRIAL_JUDGE` | variable, optional | `1` for the LLM judge |

```sh
gh secret set AGENT_TRIAL_API_KEY -R PIIIX-org/chapters --env agent-trial
gh variable set AGENT_TRIAL_MODEL -R PIIIX-org/chapters --body <model>
```

The OpenAI adapter sends `max_completion_tokens`; a compatible server that
only knows `max_tokens` needs a proxy.

```sh
gh workflow run agent-trial.yml -R PIIIX-org/chapters --ref dev                       # live (skips without a credential)
gh workflow run agent-trial.yml -R PIIIX-org/chapters --ref dev -f model=scripted     # dry run
gh workflow run agent-trial.yml -R PIIIX-org/chapters --ref dev -f tasks=T1,T7 -f arms=local
gh run download <run-id> -R PIIIX-org/chapters -n agent-trial-results -D runs
```

A dry run (`model: scripted`) replaces the model with a fixed script (per
arm: status or listing, a search, a read of the first fact's evidence file)
to test the plumbing end to end: lab build, checkout, evidence check,
indexing, the pinned token, MCP and local tool calls, grading, artifact. Its
numbers are marked `dryRun` and are not agent numbers. Locally (Linux,
Docker, bun): bring the lab up as in `docs/agents/lab.md`, then
`AGENT_TRIAL_MODE=scripted bun benchmarks/agent-trial/run.ts`. Unit tests:
`node --test 'benchmarks/agent-trial/lib/*.test.ts'` (CI `checks` job).

**How to read a run.** `agent-trial-results/summary.md` (also the job
summary) has one row per task and arm: facts found / total, the false
claims flagged, tokens in and out, tool calls, wall time, stop reason; then
totals per arm, and any episode not run. `results.json` adds the model, caps, harness hash, index
outcome, which facts were found and missed, the sentence of each flagged
false claim, the full answer and the trace. Compare arms on the same run
only: models, prices and Elara change between runs. Read the answers before
quoting a number: a missed fact can be a paraphrase the regex does not
know, and the `judge` column (when present) shows where that happened.
