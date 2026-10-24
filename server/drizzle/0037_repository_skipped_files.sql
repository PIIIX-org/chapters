-- #465: what the last git or local-path sync left out of the index, as counts
-- per reason (too_large, binary, ignored, over_file_cap) plus a short sample
-- of paths. Written with the sync's status; null until a sync has run on a
-- version that records it (a git repository with null re-clones once even if
-- its remote has not moved, so a committed build/ gets indexed). Numbered
-- 0037 because open PRs hold 0033-0036; its `when` (1792350000000) is above
-- theirs, so it applies whatever order they merge in.
ALTER TABLE "repositories" ADD COLUMN "skipped_files" jsonb;
