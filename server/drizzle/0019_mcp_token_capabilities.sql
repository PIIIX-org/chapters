CREATE TYPE "public"."mcp_access" AS ENUM('read', 'write', 'admin');--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "access" "mcp_access" DEFAULT 'write' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "allowed_tools" text[];--> statement-breakpoint
-- Existing account tokens keep every tool they had. Existing vault- and
-- repository-pinned tokens stay at the column default, 'write': they lose the
-- admin tools (share, revoke, update settings, delete, purge, purge_revision)
-- on their pin (#549).
UPDATE "mcp_connections" SET "access" = 'admin' WHERE "scope" = 'account';
