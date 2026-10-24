-- #428 (ADR-004 §2.6, D4): a token's tool profile, the set of tools it lists
-- and may call: reader, writer or admin (every tool). Every existing token
-- becomes 'admin', so it lists and calls exactly what it did before. The
-- default stays on the column: it is the mint route's default for a token
-- minted without a profile, older code's inserts keep working after a
-- code-only rollback (backup.md §5), and a backup made before 0032 restores
-- its tokens as 'admin'. Numbered after 0031 (#558), with a larger `when`.
CREATE TYPE "public"."mcp_profile" AS ENUM('reader', 'writer', 'admin');--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "profile" "mcp_profile" DEFAULT 'admin' NOT NULL;
