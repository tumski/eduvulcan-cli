# eduvulcan-cli

Standalone CLI for logging into EduVulcan with Playwright and then fetching school data directly from EduVulcan APIs.

Why this exists:
- browser automation is used only for login/session establishment
- data fetching happens via API calls after login
- output is normalized JSON suitable for cron, storage, and downstream agents

## Requirements

- Node.js 22+
- pnpm 10+
- Playwright Chromium

## Setup

```bash
cd ../eduvulcan-cli
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
# then fill in EDUVULCAN_USERNAME / EDUVULCAN_PASSWORD
```

## Usage

After building, you can use the standalone wrapper directly:

```bash
./bin/eduvulcan-fetch
```

Fetch and print today's day snapshot to stdout:

```bash
pnpm fetch
```

Fetch tomorrow's schedule/homework context:

```bash
./bin/eduvulcan-fetch --date tomorrow
```

Fetch a specific day with the extended/comprehensive endpoint set:

```bash
./bin/eduvulcan-fetch --date 2026-03-13 --profile comprehensive
```

Fetch and store dated snapshots:

```bash
./bin/eduvulcan-fetch --output-dir ./data
```

Fetch to an explicit file:

```bash
./bin/eduvulcan-fetch --date 2026-03-13 --output ./data/2026-03-13.json
```

Show help:

```bash
pnpm dev --help
```

## Output

Successful fetch returns normalized JSON like:

```json
{
  "fetchedAt": "2026-03-11T06:00:12.000Z",
  "source": "eduvulcan",
  "status": "ok",
  "targetDate": "2026-03-12",
  "dateRange": {
    "from": "2026-03-11T23:00:00.000Z",
    "to": "2026-03-12T22:59:59.999Z",
    "timezone": "Europe/Warsaw"
  },
  "profile": "standard",
  "students": [],
  "meta": {
    "region": "wroclaw",
    "durationMs": 12345,
    "version": "0.2.0",
    "warnings": []
  }
}
```

If `--output-dir` is used, the CLI writes:
- `YYYY-MM-DD.json` for the standard profile
- `YYYY-MM-DD.comprehensive.json` for the comprehensive profile
- `latest.json` / `latest.comprehensive.json`

Writes are atomic.

## Cron-friendly wrapper

A retrying wrapper is included:

```bash
./scripts/fetch-with-retries.sh
```

It writes logs to `./logs/YYYY-MM-DD-fetch.log`, stores snapshots in `./data/`, and retries with backoff.

If you want a classic system cron entry on a machine that allows `crontab`, run:

```bash
./scripts/install-cron.sh
```

## Exit codes

- `0` success
- `10` missing credentials
- `11` browser initialization failure
- `12` login or navigation failure
- `13` API fetch failure
- `14` output write failure
- `15` unexpected runtime failure

## Credential names

Preferred:
- `EDUVULCAN_USERNAME`
- `EDUVULCAN_PASSWORD`

Backward-compatible aliases:
- `SITE_EDUVULCAN_USERNAME`
- `SITE_EDUVULCAN_PASSWORD`
