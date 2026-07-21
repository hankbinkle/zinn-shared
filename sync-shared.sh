#!/usr/bin/env bash
# sync-shared.sh -- Legacy sync (kept for local dev)
#
# Shared modules are now served from git at build time.
# To update shared modules:
#   1. Edit files in ~/.openclaw/skills/_shared/
#   2. Run: bash publish.sh
#   3. Redeploy affected Railway services
#
# This script still works for local development copies:
#   bash sync-shared.sh <skill_name> [subdir]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_DIR="$SCRIPT_DIR"
SKILLS_DIR="$(dirname "$SHARED_DIR")"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <skill_name> [subdir]"
  echo ""
  echo "NOTE: Shared modules are now served from git at build time."
  echo "Run ./publish.sh to push changes to GitHub, then redeploy."
  echo ""
  echo "Available skills:"
  for d in "$SKILLS_DIR"/*/; do
    name=$(basename "$d")
    [ "$name" != "_shared" ] && [ -f "$d/SKILL.md" ] && echo "  - $name"
  done
  exit 1
fi

SKILL_NAME="$1"
SUBDIR="${2:-}"
TARGET_DIR="$SKILLS_DIR/$SKILL_NAME${SUBDIR:+/}$SUBDIR"

if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Target not found at $TARGET_DIR"
  exit 1
fi

echo "=== Syncing _shared/ to $(basename $TARGET_DIR) (local copy) ==="

mkdir -p "$TARGET_DIR/_shared"

COUNT=0
for module in "$SHARED_DIR"/*.js; do
  name=$(basename "$module")
  cp "$module" "$TARGET_DIR/_shared/$name"
  COUNT=$((COUNT + 1))
  echo "  $name"
done

if [ -f "$SHARED_DIR/shared_version.json" ]; then
  cp "$SHARED_DIR/shared_version.json" "$TARGET_DIR/_shared/shared_version.json"
fi
if [ -f "$SHARED_DIR/team.json" ]; then
  cp "$SHARED_DIR/team.json" "$TARGET_DIR/_shared/team.json"
fi

# --- Sync Python pipeline scripts for project_template_manager ---
if [ "$SKILL_NAME" = "project_automator" ]; then
  echo ""
  echo "=== Syncing pipeline scripts (_scripts/) ==="
  PY_SCRIPTS='process_project.py generate_keynote_table.py'
  for script in $PY_SCRIPTS; do
    src="$SHARED_DIR/../$SKILL_NAME/_scripts/$script"
    if [ -f "$src" ]; then
      echo "  $script (already present)"
    else
      echo "  $script (not found at $src)"
    fi
  done
fi

echo "=== Done. ${COUNT} modules synced to $TARGET_DIR/_shared/ ==="
echo ""
echo "NOTE: This is a local copy. For Railway deployment, push to git instead:"
echo "  bash $SHARED_DIR/publish.sh"
