#!/bin/sh
# Points this clone's `core.hooksPath` at .githooks (the attribution hook,
# .githooks/commit-msg). Run by the root `prepare` script on `pnpm install`.
# A no-op outside a git checkout (the Docker build, a tarball). A clone that
# already uses another hooks directory is left alone, with a warning, so an
# existing hook setup is not replaced behind the user's back.

git rev-parse --is-inside-work-tree > /dev/null 2>&1 || exit 0

current=$(git config --get core.hooksPath || true)
case "$current" in
  '' | .githooks)
    git config core.hooksPath .githooks
    ;;
  *)
    echo "warning: core.hooksPath is '$current', not .githooks; the attribution hook (.githooks/commit-msg) is not installed. To use it: git config core.hooksPath .githooks" >&2
    ;;
esac
