# Debian-based (not Alpine): onnxruntime-node and sharp ship prebuilt
# glibc binaries for this platform — avoids a slow/fragile native
# source build on every image build.
FROM node:24-slim

RUN corepack enable

WORKDIR /app

# Dependency manifests only, for layer caching — source changes don't
# invalidate the (slow) install step.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json ./server/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY server ./server

WORKDIR /app/server

ENV NODE_ENV=production
EXPOSE 3000 3001

# Runs via tsx, same as every other environment this project has ever
# actually run in (dev, tests, every e2e smoke test) — no separate
# tsc-to-JS build pipeline exists or has been exercised.
CMD ["pnpm", "start"]
