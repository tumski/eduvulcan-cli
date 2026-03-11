#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_LINE="0 6 * * 1-5 cd $ROOT_DIR && $ROOT_DIR/scripts/fetch-with-retries.sh"
EXISTING="$(crontab -l 2>/dev/null || true)"

if grep -Fq "$ROOT_DIR/scripts/fetch-with-retries.sh" <<<"$EXISTING"; then
  echo "Cron entry already present."
  exit 0
fi

{
  printf '%s\n' "$EXISTING"
  printf '%s\n' "$CRON_LINE"
} | crontab -

echo "Installed cron entry: $CRON_LINE"
