#!/usr/bin/env bash
# publish.sh — Push canonical shared modules to GitHub
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo "=== Publishing zinn-shared to GitHub ==="

# Stage all files
git add -A

# Check if anything changed
if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi

# Commit and push
git commit -m "Update shared modules - $(date +%Y-%m-%d_%H:%M)"
git push origin main

echo "=== Published ==="
echo "Commit: $(git rev-parse HEAD | head -c 12)"
