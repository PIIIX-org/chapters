#!/usr/bin/env bash
set -euo pipefail

# Chapters Always-Active Mode Installer
# Installs persistent rules so AI agents keep Chapters permanently active.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULE_SRC="${SCRIPT_DIR}/../rules/chapters.md"

if [[ ! -f "${RULE_SRC}" ]]; then
  echo "Error: Rule file not found at ${RULE_SRC}" >&2
  exit 1
fi

TARGET="${1:-all}"

echo "Installing Chapters Always-Active Mode (Target: ${TARGET})..."

install_antigravity() {
  local dir="${HOME}/.gemini/config/rules"
  mkdir -p "${dir}"
  cp "${RULE_SRC}" "${dir}/chapters.md"
  echo "  ✓ Installed for Google Gemini / Antigravity: ${dir}/chapters.md"
}

install_claude() {
  local dir="${HOME}/.claude"
  mkdir -p "${dir}"
  if [[ -f "${dir}/CLAUDE.md" ]]; then
    if ! grep -q "Chapters — Always-Active Agent Protocol" "${dir}/CLAUDE.md"; then
      echo "" >> "${dir}/CLAUDE.md"
      cat "${RULE_SRC}" >> "${dir}/CLAUDE.md"
    fi
  else
    cp "${RULE_SRC}" "${dir}/CLAUDE.md"
  fi
  echo "  ✓ Installed for Anthropic Claude: ${dir}/CLAUDE.md"
}

install_cursor() {
  local dir=".cursor/rules"
  mkdir -p "${dir}"
  cat << 'EOF' > "${dir}/chapters.mdc"
---
description: Chapters Always-Active Rule
globs: *
alwaysApply: true
---

EOF
  cat "${RULE_SRC}" >> "${dir}/chapters.mdc"
  echo "  ✓ Installed for Cursor: ${dir}/chapters.mdc"
}

install_windsurf() {
  local file=".windsurfrules"
  if [[ -f "${file}" ]]; then
    if ! grep -q "Chapters — Always-Active Agent Protocol" "${file}"; then
      echo "" >> "${file}"
      cat "${RULE_SRC}" >> "${file}"
    fi
  else
    cp "${RULE_SRC}" "${file}"
  fi
  echo "  ✓ Installed for Windsurf: ${file}"
}

case "${TARGET}" in
  antigravity|gemini)
    install_antigravity
    ;;
  claude)
    install_claude
    ;;
  cursor)
    install_cursor
    ;;
  windsurf)
    install_windsurf
    ;;
  all)
    install_antigravity
    install_claude
    install_cursor
    install_windsurf
    ;;
  *)
    echo "Unknown target: ${TARGET}. Use: all | antigravity | claude | cursor | windsurf" >&2
    exit 1
    ;;
esac

echo "Done! Chapters is now configured to remain always active in your AI agent."
