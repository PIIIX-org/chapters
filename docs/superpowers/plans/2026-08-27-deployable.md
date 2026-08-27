# Phase: Deployable

The UI phase shipped seven units and 855 tests. None of it can be run by
anyone. This phase closes that, and it is also step one of the hosted product —
the artifact the control plane will stamp out per customer does not exist yet.

## Where this phase came from

Two decisions were taken on 2026-08-27, both recorded here because the code
does not show them:

1. **Chapters will also run as a hosted service, one instance per customer** —
   a container and its own Postgres per customer, completely separated.
2. **The app is not forked to do that.** `2026-07-17-hosted-ui-structure-design.md`
   already states the editions are identical except the Yildizim sky and
   achievements, and those live in their own private repo. So: one repo, one
   branch line, hosted-only layers stay separate, and the **control plane**
   (provisioning, billing, routing, fleet updates) becomes its own private
   repo that the app never imports or calls.

The direction of that last arrow is load-bearing. Yildizim is a layer *inside*
the app; the control plane sits *above* it. If the app ever depends on the
control plane, self-hosting is dead and there are two products again.

## What is missing today

| Gap | Evidence |
|---|---|
| Nothing serves the client | `Dockerfile` copies only `server/`; no static plugin anywhere in `server/src` |
| No app service at all | `docker-compose.yml` defines Postgres and nothing else |
| Collaboration cannot work | the relay binds its own port; nothing routes `/collab` |
| Sign-up is unreachable | not one `<Link>` between the six auth pages |

## Decisions for this phase

**One port, no proxy.** The relay currently calls `new Server({ port })` and
listens separately. Hocuspocus can instead take a socket from an existing HTTP
server, so Fastify's server handles the `upgrade` event on `/collab` and hands
it over. The client already asks for the same-origin path `/collab` — that
half is done and needs no change. One port per container means the compose file
is app + Postgres, the nginx block in the README goes away, and a customer's
container has exactly one thing to expose.

*Fallback if attaching proves fiddly:* keep two ports and ship the proxy. Do
not ship two ports with no proxy, which is what exists now and works nowhere.

**The client is served by the API**, from `client/dist`, rather than by a
separate web server. Same reason: one process, one port, one container.

**No edition flag yet.** It would branch on nothing: the only hosted-only
surfaces are the Sky and achievements, which are not in this repo. Adding it
now is a config value with no reader. When something actually differs, add it.

**Not in this phase:** the control-plane repo, billing, fleet migration
versioning. All real, all after there is an artifact to provision.

## Tasks

1. **The sign-in path** — see `2026-08-27-auth-path.md`, already planned and
   approved. Independent of everything below.
2. **Serve the client from the API.** `@fastify/static` over `client/dist`,
   with an SPA fallback that does not swallow `/api` or `/collab`.
3. **Attach the relay to the HTTP server** on `/collab`, retiring
   `COLLAB_PORT` as a listening port. Every collab test must still pass, and
   two browsers must still co-edit.
4. **A real image.** Multi-stage: build the client, install server deps, one
   runtime stage. Health check. Non-root.
5. **A compose file that runs the product** — app + Postgres, one exposed
   port, env documented (`SMTP_*`, `CREDENTIALS_ENCRYPTION_KEY`).
6. **Prove it.** Bring the stack up from nothing and walk the whole product:
   setup → sign up → verify → approve → sign in → vault → note → share →
   co-edit in two windows → connect a repository. This is the end-to-end pass
   the UI-phase spec asked for and never got.
7. README + STATE.md + `implementation.md`.

## Testing

Existing suites stay green — the relay change in particular is a rewrite of a
shipped, tested path. Every new behaviour gets a test that fails without it,
mutation-verified. The final gate is task 6: the product running from a cold
`docker compose up`, driven in a browser.
