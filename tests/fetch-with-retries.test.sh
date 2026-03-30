#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SCRIPT="$REPO_ROOT/scripts/fetch-with-retries.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains() {
  local path="$1"
  local needle="$2"
  grep -Fq "$needle" "$path" || fail "expected $path to contain: $needle"
}

assert_file_not_contains() {
  local path="$1"
  local needle="$2"
  if grep -Fq "$needle" "$path"; then
    fail "expected $path not to contain: $needle"
  fi
}

make_test_root() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/scripts" "$root/bin" "$root/data" "$root/logs"
  cp "$SOURCE_SCRIPT" "$root/scripts/fetch-with-retries.sh"
  chmod +x "$root/scripts/fetch-with-retries.sh"
  cat > "$root/bin/eduvulcan-fetch" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FETCH_STUB_SLEEP:-0}" != "0" ]]; then
  sleep "$FETCH_STUB_SLEEP"
fi
printf 'stub fetch invoked\n' >> "${FETCH_STUB_MARKER:?}"
exit "${FETCH_STUB_EXIT_CODE:-0}"
EOF
  chmod +x "$root/bin/eduvulcan-fetch"
  echo "$root"
}

run_without_flock_should_still_fetch() {
  local root marker log_file
  root="$(make_test_root)"
  marker="$root/marker.log"
  log_file="$root/logs/$(date +%F)-fetch.log"

  (
    cd "$root"
    FETCH_STUB_MARKER="$marker" ./scripts/fetch-with-retries.sh
  )

  [[ -f "$marker" ]] || fail "expected fetch stub to run"
  assert_file_contains "$log_file" "Attempt 1 starting."
  assert_file_contains "$log_file" "Attempt 1 succeeded."
  assert_file_not_contains "$log_file" "Another fetch run is already in progress."
}

run_concurrent_invocation_should_log_lock_and_exit_cleanly() {
  local root marker log_file pid
  root="$(make_test_root)"
  marker="$root/marker.log"
  log_file="$root/logs/$(date +%F)-fetch.log"

  (
    cd "$root"
    FETCH_STUB_MARKER="$marker" FETCH_STUB_SLEEP=2 ./scripts/fetch-with-retries.sh
  ) &
  pid=$!

  sleep 0.5

  (
    cd "$root"
    FETCH_STUB_MARKER="$marker" ./scripts/fetch-with-retries.sh
  )

  wait "$pid"

  local invocations
  invocations="$(wc -l < "$marker" | tr -d ' ')"
  [[ "$invocations" == "1" ]] || fail "expected exactly one fetch invocation, got $invocations"
  assert_file_contains "$log_file" "Another fetch run is already in progress."
  assert_file_contains "$log_file" "Attempt 1 succeeded."
}

run_stale_lock_should_be_recovered() {
  local root marker log_file
  root="$(make_test_root)"
  marker="$root/marker.log"
  log_file="$root/logs/$(date +%F)-fetch.log"

  mkdir "$root/.fetch.lock"
  printf '999999\n' > "$root/.fetch.lock/pid"

  (
    cd "$root"
    FETCH_STUB_MARKER="$marker" ./scripts/fetch-with-retries.sh
  )

  [[ -f "$marker" ]] || fail "expected fetch stub to run after stale lock recovery"
  assert_file_contains "$log_file" "Cleared stale fetch lock for PID 999999."
  assert_file_contains "$log_file" "Attempt 1 succeeded."
}

run_without_flock_should_still_fetch
run_concurrent_invocation_should_log_lock_and_exit_cleanly
run_stale_lock_should_be_recovered

echo "PASS: fetch-with-retries portability tests"
