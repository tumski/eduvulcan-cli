# eduvulcan-cli

Standalone CLI for logging into EduVulcan with Playwright and then fetching school data directly from EduVulcan APIs.

Why this exists:
- browser automation is used only for login/session establishment
- data fetching happens via API calls after login
- output is normalized JSON suitable for cron, storage, and downstream agents
- the CLI itself does not use any LLM; it only fetches and stores data

## Requirements

- Node.js 22+
- pnpm 10+
- Playwright Chromium

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

Fill in the account that can already sign in at <https://eduvulcan.pl/logowanie>:

```bash
EDUVULCAN_USERNAME=you@example.com
EDUVULCAN_PASSWORD=super-secret
BROWSER_HEADLESS=true
TZ=Europe/Warsaw
```

`SITE_EDUVULCAN_USERNAME` and `SITE_EDUVULCAN_PASSWORD` are still accepted. The process reads `.env.local` and then `.env`, and it does not override variables that are already set in the environment.

## Live fetch

From a machine that has those credentials and can reach EduVulcan:

```bash
pnpm fetch
# or, after pnpm build:
./bin/eduvulcan-fetch --date today --profile standard --output-dir ./data
```

A successful run prints the normalized snapshot and exits `0`. `meta.region` is the tenant slug (for example `zyrardow`) and `students` comes from `GET /<tenant>/api/Context`.

This repository does not ship credentials. Without `EDUVULCAN_USERNAME` / `EDUVULCAN_PASSWORD` the CLI exits `10` before it opens a browser.

## Offline check

The cloud agent and CI do not need a live Vulcan account. The WS-Fed handoff is covered by unit tests, including the raw `>` case that used to truncate `wresult`:

```bash
pnpm test
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
    "version": "0.3.0",
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

It writes logs to `./logs/YYYY-MM-DD-fetch.log`, stores snapshots in `./data/`, retries with backoff, and explicitly runs the standalone standard day fetch (`--date today --profile standard`). The wrapper uses a portable lock directory (`.fetch.lock`) with stale-lock recovery, so it works on macOS and Linux without requiring `flock`.

Run the automated tests with:

```bash
pnpm test
```

That covers:
- browser-context API fetch unit tests
- wrapper portability/locking shell tests

If you want a classic system cron entry on a machine that allows `crontab`, run:

```bash
./scripts/install-cron.sh
```

## Login handoff

Playwright is still used only to sign in at `eduvulcan.pl` (the proof-of-work captcha, when shown, runs in that page). After login the CLI opens `https://eduvulcan.pl/dostep-do-dziennika/`, reads the `/dziennik?` links, and finishes WS-Federation itself with the browser cookie jar.

That second step is deliberate. The parent portal still returns to `https://uczen.eduvulcan.pl/<tenant>/Start?profil=...`, and that route now responds with "Strona nie została odnaleziona". Driving Chromium onto it does not leave a session that can call `/api/Context` (the call comes back 404, exit `13`). Posting the `wresult` form over HTTP does. The SAML token is a quoted attribute that contains raw `>` characters, so the parser has to be quote-aware; a `<input[^>]*>` scan truncates the token and the federation POST is rejected.

Diary calls (`Context`, `PlanZajec`, `SprawdzianyZadaniaDomowe`, and the comprehensive tablica endpoints) then go out through that same cookie jar. They do not depend on the dead Start page.

The messages host (`wiadomosci.eduvulcan.pl`) is a separate WS-Fed chain. If that inbox session still fails, the snapshot stays partial: schedule, homework, and free days are kept, and the failure is listed in `meta.warnings`.

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
