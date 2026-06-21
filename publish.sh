#!/usr/bin/env bash
# publish.sh — Push canonical shared modules to GitHub
# Run after editing any file in ~/.openclaw/skills/_shared/
#
# Usage:
#   bash publish.sh
#
# Then redeploy affected Railway services to pick up changes.
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo "=== Publishing zinn-shared to GitHub ==="

# Stage all changes
git add -A

# Check if anything changed
if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi

# Show what's changing
echo "Changes:"
git diff --cached --stat

# Commit
git commit -m "Update shared modules - $(date +%Y-%m-%d_%H:%M)"

# Push to GitHub
git push origin main

echo ""
echo "=== Published ==="
echo "Commit: $(git rev-parse HEAD | head -c 12)"
echo "Repo: https://github.com/hankbinkle/zinn-shared"
echo ""
echo "Next: redeploy affected Railway services to pick up changes."
