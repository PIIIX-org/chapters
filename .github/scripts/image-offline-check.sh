#!/usr/bin/env bash
# The operator commands are `pnpm <script>` inside the app container
# (`docker compose exec app pnpm check-notes`, docs/self-hosting). They must
# start at once with no network: before #872, pnpm's pre-run dependency
# check reinstalled the whole workspace from the registry first, and hung
# offline. Run by .github/actions/image-offline-check (image-check.yml on
# PRs, publish.yml before it pushes); runs locally the same way.
#
# Usage: .github/scripts/image-offline-check.sh <image>
set -uo pipefail

image=${1:?usage: image-offline-check.sh <image>}
failed=0

# <label> <shell command, run in the image with no network>
check() {
  local out
  out=$(docker run --rm --network none --entrypoint sh "$image" -c "$2" 2>&1)
  echo "--- $1"
  printf '%s\n' "$out" | tail -n 15
  if grep -q '^usage: check-notes' <<<"$out"; then
    echo "ok: $1"
  else
    echo "::error::$1: 'pnpm check-notes --help' did not print its usage with no network (output above; 120 s limit) (#872)."
    failed=1
  fi
}

# As shipped: the image turns the pre-run check off.
check 'pnpm script, as shipped' \
  'timeout 120 pnpm check-notes --help'

# Without that setting: every manifest newer than the install (what a cached
# install layer under a fresh `COPY server` gives) and the check set to fail
# instead of install. Passes only if pnpm finds the manifests and the
# lockfile in agreement on its own (a direct dependency whose range differs
# from its override in pnpm-workspace.yaml fails here).
check 'pnpm dependency check on its own' \
  'touch /app/package.json /app/client/package.json /app/server/package.json &&
   pnpm_config_verify_deps_before_run=error timeout 120 pnpm check-notes --help'

exit "$failed"
