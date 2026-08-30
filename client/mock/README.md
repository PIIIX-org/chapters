# Mock API

A dependency-free fixture server so the client can be run, clicked through
and screenshotted without Postgres or the real server. Dev tooling only —
nothing here ships.

- **Fakes:** every `/api/*` path `client/src/api/*.ts` calls — session,
  auth flows (any credentials log in), vaults + trash, notes, revisions,
  graph (aggregate + community drill-down), search, notifications, shares,
  teams, repositories + files, MCP connections, account/MFA, export/import,
  admin. State is in memory and mutates, so create/rename/delete flows work
  until restart.
- **Cannot fake:** the Yjs relay and SSE. The note editor opens and shows
  its `offline`/`reconnecting` status; readers see `reconnecting`.
- **Role:** the session is an admin by default; `MOCK_ROLE=member` switches.

Run it on the port `client/vite.config.ts` already proxies `/api` to:

```sh
# bash
MOCK_PORT=3000 pnpm --filter @chapters/client mock
# PowerShell
$env:MOCK_PORT = 3000; pnpm --filter @chapters/client mock
```

then `pnpm --filter @chapters/client dev` and open http://localhost:5173.
