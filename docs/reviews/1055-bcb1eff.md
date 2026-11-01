# Review of #1055 — feat: symbol_at, references, callers, impact and tests_for o
Head reviewed: bcb1eff68a1774a9e661847c6ba219cf5753ee2d
Verdict: CHANGES

## Blockers
Both code blockers fixed and verified on a self-index: access-matrix entries in server + lab (lab 92/0); member-call noise gone (`callers where` 51 → 2 resolved, `callers json` 51 → 7 resolved, `impact buildApp` no longer reaches `useCollabDoc`, `impact json` 7/none); no resolved row lost across 13 comparison queries; 14/15 hand-checked callers right; `limit`/cursor docs and `capped` fixed; reader ~1,996. One item:
1. **The served manual contradicts the code on how `impact` walks** — `server/src/repositories/code-queries.ts:31` (and `docs/agents/backend-reference.md:3640`, `mcp-tools.md` line 544 in both copies) say "only `resolved` rows continue past level 1", but the code (and `code-queries-store.test.ts:137`) lets a textual non-member level-1 row continue, labelled `textual` (e.g. the true `restart()` → `buildApp` chain), and line 546 of the same manual says "only rows with a target continue". Make the three texts say: guessed member calls are dropped; levels 2–3 follow only `resolved` edges; a textual level-1 hop continues with the chain labelled `textual`.
Bench note: this head's plan ran chapters only (the base copy of `lab-plan.mjs` predates #1053). #1053 is landing now; after the branch updates, the gate runs all suites with the golds floor for `server/src/mcp/**` — that run must pass before merge.
Minor: `intRange` (`z.number().refine`) now also loosens the published schema of `search`/`find_symbols` `limit` and `graph_query` `limit`/`depth` (were `.int().min().max()` on dev) — keep the old schema for those or note it.


## Full record
# Re-review #1055 at bcb1eff (fix commit 0dd7a21)

The fix works and nothing right was lost. The only blocking item is a doc claim about `impact` that the code and tests contradict.

I indexed the repo's own 888 `.ts/.tsx/.mjs/.js/.py` files at bcb1eff into my own pgvector container. I ran the same queries at 3d406d9 and at bcb1eff. The container, clone and scratch files are removed.

## Previous blockers

1. **Access-matrix entries: fixed.**
   - `server/test/access-matrix.test.ts` has MCP `find_symbols` `refs` `references`, `callers`, `impact`, `tests` and `at`. It also has REST `/api/repositories/:id/code-refs` for `references`, `callers`, `impact`, `tests` and `at`.
   - `lab/tests/access-matrix.test.ts` has the same entries.
   - I ran the server suite: access-matrix, code-queries-store, code-refs-routes, mcp-code-queries, mcp-tool-budget, mcp-manuals and mcp-deterministic-answers all pass, 213/213 tests.
   - I did not run the lab file locally, because it needs a live instance. In the CI lab job on this head, `access-matrix` is 92 ok / 0 failed / 0 inconclusive. The lab gate passes with 0 regressions; the only failures are the 2 known #891 defects.

2. **Member-call noise: fixed.** Every query below was run with `limit` 50 and `depth` 3.

   | query | 3d406d9 | bcb1eff |
   |---|---|---|
   | `callers where` | 51 rows, 49 textual | 2 rows, both resolved and both true (`doctor.ts:81` and `:83`, the local `where()`) |
   | `callers json` | 51 rows, 44 textual | 7 rows, all resolved and true (`cache-epochs.test.ts`, local `json()`) |
   | `impact buildApp depth 3` | reaches `client/src/hooks/useCollabDoc.ts` | does not reach it; levels are 160 / 8 / none |
   | `impact json depth 3` | `">500"`, 475, 468 | 7 / none |

   - **Lost rows:** across my 13 comparison queries, no resolved row was lost. The one resolved-looking difference (`code-refs.ts:212` against `:211`) is a line shift from the PR's own edit.
   - **Five impact chains:**

     | chain | result |
     |---|---|
     | `askCode` | identical, 2 / 2 / 4 |
     | `resolveKeys` | levels 1 and 2 identical; level 3 loses 2 textual rows |
     | `textArray` | resolved rows identical |
     | `flushExtraction` | 153 / 113 / 69, against 70 at level 3 before |
     | `requireRepositoryAccess` | identical, 8 / 3 / 15 |

     - The 2 `resolveKeys` rows lost at level 3 are `extractionWork.processFile(...)`, a lower-case-receiver member call, and a bare `processFile(fileId)` in a test that is probably another `processFile`.
     - The `textArray` check was run once per definition: `code-edges.ts` and `block-rows.ts`, 10/6/51 and 14/32/69 rows. In the `block-rows.ts` chain the 2 textual rows at level 2 are gone.
     - The `flushExtraction` level-3 total dropping from 70 to 69 is one row I did not trace; it is not a resolved row in the first 50 shown.
   - **Hand-check of 15 `callers` rows:**
     - `where` ×2: both true.
     - `json` ×3 of 7: all true, local function.
     - `requireRepositoryAccess` ×4 of 8: all true, the local closure at `server.ts:673`.
     - `destroy` ×6 of 15 (`CollabClient.destroy`): 5 true (`A.destroy()`, `B.destroy()` in `collab-duplication.test.ts`, receivers built with `new CollabClient`). `panzoom.test.ts:104` is false: it is a destructured local from `createPanZoom`, and it is labelled textual.
     - So 14 of 15 are right.
   - **Do levels 2–3 walk only through resolved rows? Not exactly.**
     - Level-2 and level-3 edges must be `confidence = 'resolved'` (`code-queries.ts:285`).
     - A level-1 row that is textual but not a guessed member still puts its enclosing symbol into the frontier. The chain is then labelled textual and sorted last.
     - Evidence: `impact requireRepositoryAccess` shows 18 textual rows at levels 2–3. `impact buildApp` shows `last-read-restart.test.ts#restart` at level 2 as textual. That chain is true: `restart()` does a dynamic `import('../src/app.js')` and calls `buildApp()`. `code-queries-store.test.ts:137` asserts the same behaviour.

3. **Merge, CI, budget.**
   - Dev is merged: dev tip 50188c6 is an ancestor of the head, and `mergeable` is MERGEABLE. The CI merge ref a00552e therefore has the same tree as dev merged into the branch.
   - CI on this head is green: `checks`, `lab`, `bench (1–3)`, `bench-gate`, `fails-before`, `plan`, `pr-evidence`, `issue-close` and `evaluate` all pass. `review-verdict/dev` is still failing, as expected until a verdict.
   - Reader budget is 7984 chars, ~1996 tokens, so under 2,000. Admin `tools/list` is 41,371.
   - Lab plan on this head (`plan` job): tier fast, bench = chapters. The server paths match the bench rule at `elara-lab.yml:143`.
   - Bench gate on this head: Pass. Elara hit5 is 1 on all 3 instances, and goldReached is 29/29 against the baseline (grep 22). tokensToGold is 2403 against 2403. Four questions changed by 1–2 tokens.
   - **Gap:** CI ran only the `chapters` suite. I did not run context-mode or diagram-design here; triggering them would start a workflow. The goldReached 17 and 19 figures for those two suites come from the earlier review, at 3d406d9 and base, not from this head. For an all-suite gate on this head, someone must dispatch the `bench=all` workflow.

4. **Minors.**
   - **`limit`/cursor docs: fixed.** The manual now says `limit` is at most 50 per level with no cursor, and `askCode` documents the MAX_LIMIT cap.
   - **Capped flag: fixed.** `frontierCut` now marks the next level `capped`, and `total` prints `>n` with that level's own count.
   - **`intRange` type: still open.**
     - `intRange` is `z.number().refine`, so `tools/list` shows `"type":"number"` with no `integer`, `minimum` or `maximum`. The comment documents this as a budget trade, like `budget_tokens`.
     - It now also covers the existing `limit` of `search` and `find_symbols` and `limit`/`depth` of `graph_query`, which were `.int().min().max()` on dev. Their listed schema is looser, which tests do not catch.
   - **Duplicate-looking `to` rows:** unchanged and accurate.

## Findings (blocking, path:line)

1. **`server/src/repositories/code-queries.ts:31-36`: "only `resolved` rows continue past level 1" is false.**
   - The same text is in `docs/agents/backend-reference.md:3640` and in the `mcp-tools.md` `impact` bullet (line 544 in both copies).
   - The code and `code-queries-store.test.ts:137` let a textual, non-member level-1 row continue. The same manual's row bullet (line 546) says "only rows with a target continue past level 1", which contradicts line 544.
   - Fix the three texts to say what happens. Guessed member calls are dropped at level 1, levels 2–3 follow only `resolved` edges, and a textual level-1 hop continues with the chain labelled `textual`. Or make the code match the claim.
   - The fix is small, but the manual is a served surface and currently says two different things.

## Minor

- **Capitalised-variable receivers:** `A.destroy()` and `R.destroy()` take the capitalised-name path and count as a qualified static call, not a guessed member. They stay in `callers` as textual. In this repo they are right, but `P.destroy()` on an unrelated `P` would be shown. That is the extraction rule in `code-edge-rules.ts:249`, not a regression.
- **`intRange`:** see item 4 above.

Verdict: CHANGES