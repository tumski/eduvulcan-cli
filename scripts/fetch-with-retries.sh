#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
LOG_DIR="$ROOT_DIR/logs"
LOCK_DIR="$ROOT_DIR/.fetch.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
export TZ="${TZ:-Europe/Warsaw}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

log_line() {
  echo "[$(timestamp)] $1" >> "$LOG_FILE"
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_PID_FILE"
    return 0
  fi

  if [[ -f "$LOCK_PID_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"

    if [[ -n "$existing_pid" ]] && ! kill -0 "$existing_pid" 2>/dev/null; then
      rm -f "$LOCK_PID_FILE"
      rmdir "$LOCK_DIR" 2>/dev/null || true

      if mkdir "$LOCK_DIR" 2>/dev/null; then
        printf '%s\n' "$$" > "$LOCK_PID_FILE"
        log_line "Cleared stale fetch lock for PID ${existing_pid}."
        return 0
      fi
    fi
  fi

  return 1
}

release_lock() {
  rm -f "$LOCK_PID_FILE"
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

mkdir -p "$DATA_DIR" "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%F)-fetch.log"

if ! acquire_lock; then
  log_line "Another fetch run is already in progress."
  exit 0
fi
trap release_lock EXIT

attempt_delays=(0 300 600 900)
attempt=1

for delay in "${attempt_delays[@]}"; do
  if [[ "$delay" -gt 0 ]]; then
    log_line "Waiting ${delay}s before retry ${attempt}."
    sleep "$delay"
  fi

  log_line "Attempt ${attempt} starting."
  set +e
  "$ROOT_DIR/bin/eduvulcan-fetch" --date today --profile standard --output-dir "$DATA_DIR" --debug-dir "$LOG_DIR" >> "$LOG_FILE" 2>&1
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
