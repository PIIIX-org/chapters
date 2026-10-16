-- 0019 left the column default at 'write' while POST /api/mcp-connections
-- gives an account token 'admin' when no level is named: two defaults for one
-- column. The route always writes an explicit level, and a restore fills in
-- the 0019 rule for older dumps, so the column keeps no default (#641).
-- Existing rows are not touched.
ALTER TABLE "mcp_connections" ALTER COLUMN "access" DROP DEFAULT;
