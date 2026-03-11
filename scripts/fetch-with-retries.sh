#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
LOG_DIR="$ROOT_DIR/logs"
LOCK_DIR="$ROOT_DIR/.fetch.lock"
export TZ="${TZ:-Europe/Warsaw}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

mkdir -p "$DATA_DIR" "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%F)-fetch.log"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(timestamp)] Another fetch run is already in progress." >> "$LOG_FILE"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT

attempt_delays=(0 300 600 900)
attempt=1

for delay in "${attempt_delays[@]}"; do
  if [[ "$delay" -gt 0 ]]; then
    echo "[$(timestamp)] Waiting ${delay}s before retry ${attempt}." >> "$LOG_FILE"
    sleep "$delay"
  fi

  echo "[$(timestamp)] Attempt ${attempt} starting." >> "$LOG_FILE"
  set +e
  "$ROOT_DIR/bin/eduvulcan-fetch" --output-dir "$DATA_DIR" --debug-dir "$LOG_DIR" >> "$LOG_FILE" 2>&1
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    echo "[$(timestamp)] Attempt ${attempt} succeeded." >> "$LOG_FILE"
    exit 0
  fi

  echo "[$(timestamp)] Attempt ${attempt} failed with exit code ${status}." >> "$LOG_FILE"
  attempt=$((attempt + 1))
done

echo "[$(timestamp)] All attempts failed." >> "$LOG_FILE"
exit 1
