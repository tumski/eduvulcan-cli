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

Fetch and print to stdout:

```bash
pnpm fetch
```

Fetch and store dated snapshots:

```bash
./bin/eduvulcan-fetch --output-dir ./data
```

Fetch to an explicit file:

```bash
./bin/eduvulcan-fetch --output ./data/2026-03-11.json
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
  "students": [],
  "meta": {
    "region": "wroclaw",
    "durationMs": 12345,
    "version": "0.1.0",
    "warnings": []
  }
}
```

If `--output-dir` is used, the CLI writes:
- `YYYY-MM-DD.json`
- `latest.json`

Writes are atomic.

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
