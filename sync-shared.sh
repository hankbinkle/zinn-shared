#!/usr/bin/env bash
# =============================================================================
# sync-shared.sh — Sync _shared/ modules into a target skill directory
# Run before Railway deploy to pull in the latest shared infrastructure.
#
# Usage:
#   bash ~/.openclaw/skills/_shared/sync-shared.sh <skill_name> [subdir]
#
# Examples:
#   bash ~/.openclaw/skills/_shared/sync-shared.sh project_automator
#   bash ~/.openclaw/skills/_shared/sync-shared.sh label_manager webhook-server
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_DIR="$SCRIPT_DIR"
SKILLS_DIR="$(dirname "$SHARED_DIR")"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <skill_name> [subdir]"
  echo "Examples:"
  echo "  $0 account_setup"
  echo "  $0 label_manager webhook-server"
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

echo "=== Syncing _shared/ → $(basename $TARGET_DIR) ==="

# Create shared dir inside target if it doesn't exist
mkdir -p "$TARGET_DIR/_shared"

# Copy all .js modules
COUNT=0
for module in "$SHARED_DIR"/*.js; do
  name=$(basename "$module")
  cp "$module" "$TARGET_DIR/_shared/$name"
  COUNT=$((COUNT + 1))
  echo "  Copying $name"
done

# Copy version manifest
if [ -f "$SHARED_DIR/shared_version.json" ]; then
  cp "$SHARED_DIR/shared_version.json" "$TARGET_DIR/_shared/shared_version.json"
  echo "  Copying shared_version.json"
fi

# Copy team data
if [ -f "$SHARED_DIR/team.json" ]; then
  cp "$SHARED_DIR/team.json" "$TARGET_DIR/_shared/team.json"
  echo "  Copying team.json"
fi

echo "=== Done. Synced ${COUNT}.js modules + extras → $TARGET_DIR/_shared/ ==="
echo ""
echo "Next steps:"
echo "  1. Update source files to require('./_shared/...')"
echo "  2. Run: railway up"
