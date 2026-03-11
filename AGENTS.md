# AGENTS.md

This repository contains a standalone EduVulcan data-fetching CLI.

Purpose
- Log into EduVulcan with Playwright only to establish an authenticated session.
- Fetch data from EduVulcan APIs directly.
- Normalize and store JSON snapshots.
- Remain usable by any agent or automation without requiring an MCP server or an LLM.

Hard rules
- Do not add an always-on server or MCP layer unless explicitly requested.
- The fetch tool itself must stay standalone and deterministic.
- The fetch tool must not call any LLM. It only logs in, fetches, normalizes, and writes JSON.
- Agents may read the JSON and summarize it, but that happens outside the tool.

Primary command
```bash
./bin/eduvulcan-fetch --date today --profile standard --output-dir ./data
```

Profiles
- standard
  - Intended default for automation and conversational queries.
  - Fetches: Context, PlanZajec, SprawdzianyZadaniaDomowe, ZadanieDomoweSzczegoly, DniWolne, recent unread messages.
- comprehensive
  - Use only when standard data is insufficient or user asks for more detail.
  - Adds: OgloszeniaTablica, InformacjeTablica, OcenyTablica.

Common commands
```bash
# Today's snapshot
./bin/eduvulcan-fetch --date today --profile standard --output-dir ./data

# Tomorrow's plan/homework snapshot
./bin/eduvulcan-fetch --date tomorrow --profile standard

# Specific date
./bin/eduvulcan-fetch --date 2026-03-13 --profile standard

# Deeper fetch when extra context is needed
./bin/eduvulcan-fetch --date 2026-03-13 --profile comprehensive
```

Output contract
- The CLI prints normalized JSON to stdout.
- If `--output-dir` is provided, it also writes:
  - `YYYY-MM-DD.json` for standard
  - `YYYY-MM-DD.comprehensive.json` for comprehensive
  - `latest.json` / `latest.comprehensive.json`
- Output is atomic.

Key JSON fields
- `targetDate`: requested logical date in `YYYY-MM-DD`
- `dateRange.from` / `dateRange.to`: ISO boundaries used for EduVulcan API calls
- `profile`: `standard` or `comprehensive`
- `students[].schedule`
- `students[].homework`
- `students[].messages`
- `students[].freeDays`
- `students[].extended` only in comprehensive mode

When an agent should use which mode
- Use `standard` first for almost everything.
- Use `comprehensive` only if:
  - user asks for extra context not present in standard snapshot
  - you need announcements/info cards/grade snapshot
  - standard result is missing something and deeper inspection is warranted

Important endpoints currently relied on
- `/<region>/api/Context`
- `/<region>/api/PlanZajec?key=...&dataOd=...&dataDo=...&zakresDanych=2`
- `/<region>/api/SprawdzianyZadaniaDomowe?key=...&dataOd=...&dataDo=...`
- `/<region>/api/ZadanieDomoweSzczegoly?key=...&id=...`
- `/<region>/api/DniWolne?key=...&dataOd=...&dataDo=...`
- `https://wiadomosci.eduvulcan.pl/<region>/api/Odebrane?...`
- `https://wiadomosci.eduvulcan.pl/<region>/api/WiadomoscSzczegoly?apiGlobalKey=...`

Extended/comprehensive endpoints
- `/<region>/api/OgloszeniaTablica?key=...`
- `/<region>/api/InformacjeTablica?key=...`
- `/<region>/api/OcenyTablica?key=...`

Integration guidance for other agents
- Treat this repo as a data source, not a chat agent.
- Prefer reading saved snapshots first if the relevant date already exists.
- Run a fresh CLI fetch only when you need newer or different-date data.
- Summaries and message condensation should be done by the calling agent, not inside this CLI.

Files of interest
- `src/cli.ts` — CLI argument parsing and output behavior
- `src/fetch.ts` — login, API requests, normalization
- `src/types.ts` — normalized schema
- `scripts/fetch-with-retries.sh` — cron-friendly retry wrapper
- `README.md` — human usage guide
