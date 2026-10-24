# Debian-based (not Alpine): onnxruntime-node and sharp ship prebuilt
# glibc binaries for this platform — avoids a slow/fragile native
# source build on every image build.
#
# Two stages, two disjoint installs. The client stage needs vite and the
# React toolchain; the runtime stage needs the server's (large) native
# dependencies. Filtering each install to one workspace package means
# neither stage pays for the other's node_modules.

# ---------------------------------------------------------------- client
FROM node:24-slim AS client-build

RUN corepack enable
WORKDIR /app

# Every workspace manifest, not just the client's: pnpm validates the
# lockfile against the importers it finds on disk, and a missing
# workspace directory makes --frozen-lockfile fail before it installs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/

RUN pnpm install --frozen-lockfile --filter @elara/client

COPY tsconfig.base.json ./
COPY client ./client

RUN pnpm --filter @elara/client build

# --------------------------------------------------------------- runtime
FROM node:24-slim AS runtime

RUN corepack enable

# node:24-slim ships NEITHER git NOR a CA bundle, and
# repositories/git-sync.ts shells out to git through simple-git for every
# clone and fetch. Without both, the image builds, boots, serves the UI
# and passes its healthcheck, and every repository connection fails at
# runtime — git without ca-certificates dies on `server certificate
# verification failed. CAfile: none` for any https remote, which is all
# of them. (Node's own fetch/TLS uses a bundle compiled into node and is
# unaffected, which is exactly why this is easy to miss.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# node:24-slim ships an unprivileged `node` user (uid 1000). Installing
# AND running as that user means /app is owned by it with no `chown -R`
# layer duplicating the (very large) node_modules tree — and the
# Transformers.js model cache, which lives under node_modules, stays
# writable at runtime.
RUN mkdir -p /app /data/elara \
 && ln -s /data/elara /data/chapters \
 && chown -R node:node /app /data
WORKDIR /app
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node client/package.json ./client/
COPY --chown=node:node server/package.json ./server/

# The tree-sitter grammar packages (server/package.json) also ship their
# generated C sources and native prebuilds, most of their ~300 MB; the server
# loads only each package's .wasm (repositories/extraction.ts), and no native
# build runs (`allowBuilds: false`). Deleted in the install layer, so the
# image never carries them (#464).
RUN pnpm install --frozen-lockfile --filter @elara/server \
 && find node_modules/.pnpm -mindepth 4 -maxdepth 5 -type d \( -name src -o -name prebuilds \) \
      -path 'node_modules/.pnpm/*tree-sitter-*/node_modules/*tree-sitter-*/*' -prune -exec rm -rf {} +

COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node server ./server

# The tool manuals the MCP server serves as resources (#429), where
# server/src/mcp/manuals.ts reads them (`../../../skills/...` from
# server/src/mcp): the agent reference is their one source.
COPY --chown=node:node skills/elara/references/mcp-tools.md ./skills/elara/references/mcp-tools.md

# Where server/src/config.ts resolves CLIENT_DIST to by default
# (`../../client/dist` from server/src). Last, so a server-only change
# does not invalidate it.
COPY --from=client-build --chown=node:node /app/client/dist ./client/dist

WORKDIR /app/server

ENV NODE_ENV=production
# Notes are files on disk. The defaults in config.ts are relative paths
# under the working directory, i.e. inside the container's writable
# layer — set here so the data lands under /data, which a deployment can
# actually mount a volume on. Losing /data loses the notes.
ENV DATA_DIR=/data/elara
ENV LOCAL_REPOS_ROOT=/data/elara/local-repos

# Operator commands are `pnpm <script>` (`docker compose exec app pnpm
# check-notes`, `pnpm migrate-store`, `pnpm restore-backup`, ...). pnpm 11
# checks the dependencies before every script and, by default, runs a full
# workspace install first when it thinks they are stale — from the
# registry, so offline it hangs (#872). It looks closer whenever a
# package.json is newer than the last install, which `COPY server` makes
# true whenever the install layer comes from cache. That closer look
# failed on the `adm-zip` override until server/package.json said the same
# `>=0.6.1` as the override; any other mismatch would do the same. This
# image's dependencies are fixed when it is built, so nothing may install
# at run time. `false` is also what pnpm sets for the scripts it runs itself.
ENV pnpm_config_verify_deps_before_run=false

# The commit this image was built from, reported by `/health` as `version`
# (#583). publish.yml passes it; a plain `docker compose build` leaves it
# empty and `/health` says null. Declared after every install and copy so a
# new commit does not invalidate any cached layer.
ARG ELARA_VERSION
ENV ELARA_VERSION=${ELARA_VERSION}

# One process, one port: the Yjs collaboration relay is attached to
# Fastify's own HTTP server (server/src/index.ts) and answers websocket
# upgrades on /collab. There is no second port to expose.
EXPOSE 3000

# `node -e` rather than curl: node:*-slim has no curl or wget, and this
# needs no package at all. `/health` is registered on the root instance
# with no auth hook (server/src/app.ts), so it answers unauthenticated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx, same as every other environment this project has ever actually run
# in (dev, tests, every e2e smoke test) — no separate tsc-to-JS build
# pipeline exists or has been exercised.
#
# `node --import tsx` rather than `pnpm start` deliberately: this way the
# server is PID 1 and receives SIGTERM directly. index.ts installs
# SIGINT/SIGTERM handlers that flush note edits still inside the collab
# store debounce — behind a package-manager wrapper those edits are lost
# on every redeploy.
CMD ["node", "--import", "tsx", "src/index.ts"]
