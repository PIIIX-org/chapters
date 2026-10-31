-- #678: the opt-in usage report (server/src/usage/, backend-reference.md §5.12). Off by default:
-- while `instance_state.usage_report_enabled` is false nothing is written to these tables.
-- `usage_salt` keys the hashes of tokens, session ids and search queries (never stored as text).
-- Both columns stay out of the drizzle model, so a backup carries neither: a restored instance
-- starts with the report off and a new salt.
--
-- `usage_events`: one row per MCP tool call (and per client-reported event), ids and numbers
-- only: no note text, path or query text. Kept 7 days, then rolled up into `usage_daily`
-- (per UTC day, account, tool and profile), which is kept 30 days. Logged tables: a crash keeps
-- the report. Additive (the 0021 rule, backup.md §5): older code ignores them after a
-- code-only rollback.
ALTER TABLE "instance_state" ADD COLUMN "usage_report_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_state" ADD COLUMN "usage_salt" text;--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_id" uuid NOT NULL,
	"token" text NOT NULL,
	"session" text,
	"tool" text NOT NULL,
	"profile" "mcp_profile" NOT NULL,
	"vault_id" uuid,
	"repository_id" uuid,
	"outcome" text NOT NULL,
	"response_tokens" integer NOT NULL,
	"latency_ms" real NOT NULL,
	"retrieval_mode" text,
	"degraded" text,
	"query_hash" text,
	"query_length" integer,
	"query_lang" text,
	"filters" jsonb,
	"hit_ids" uuid[],
	"target_id" uuid,
	CONSTRAINT "usage_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "usage_events_account_at" ON "usage_events" ("account_id", "at");--> statement-breakpoint
CREATE INDEX "usage_events_at" ON "usage_events" ("at");--> statement-breakpoint
CREATE INDEX "usage_events_target" ON "usage_events" ("target_id") WHERE target_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"account_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"profile" "mcp_profile" NOT NULL,
	"calls" integer NOT NULL,
	"response_tokens" bigint NOT NULL,
	"latency_ms" double precision NOT NULL,
	"errors" integer NOT NULL,
	"zero_results" integer NOT NULL,
	CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("day", "account_id", "tool", "profile"),
	CONSTRAINT "usage_daily_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "usage_daily_account_day" ON "usage_daily" ("account_id", "day");
