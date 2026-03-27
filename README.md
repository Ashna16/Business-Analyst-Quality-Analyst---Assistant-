# BA-QA Assistant — Automated Meeting-to-Jira Pipeline

Turn meeting transcripts into structured bug artifacts: deduplicated memory, Jira issues (REST), QA markdown, and Word test-case tables—so BA/QA and engineering stay aligned without manual copy-paste.

## Architecture

```
Meeting Transcript (auto-updated every 2 min)
        ↓
Contextual AI — extracts bugs from conversation
        ↓
Redis — deduplication (prevents repeat bugs)
        ↓
    ┌───┴───────────┐
    ↓               ↓
Jira (SCRUM)    Word Doc (QA_Report.docx)
Bug ticket      Test case document
    └───────────────┘
        ↓
Claude — final review & QA validation
        ↓
Developer picks up ticket in Cursor
```

_(Word output is written as `QA_Report_<bugId>_<YYYYMMDD_HHmmss>.docx` under your configured output directory, e.g. `~/Desktop/BA_QA_DEMO_OUTPUT`—one file per bug, no overwrites.)_

## Tech stack

Contextual AI, Redis, Jira Atlassian REST API, Claude (Anthropic), Cursor, Node.js/TypeScript, `docx`, `composio-core`.

## Environment variables

Copy `.env.example` to `.env` and fill in values. Do not commit `.env`.

| Variable                             | Description                                                             |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `OPENCLAW_GATEWAY_URL`               | OpenClaw gateway HTTP URL (optional health ping).                       |
| `OPENCLAW_GATEWAY_TOKEN`             | Bearer token for the gateway, if required.                              |
| `CONTEXTUAL_AI_API_KEY`              | Contextual AI API key (preferred parser for bug extraction).            |
| `CONTEXTUAL_AI_MODEL`                | Contextual AI model id (default `v2`).                                  |
| `OPENAI_API_KEY`                     | OpenAI-compatible API key (fallback parser).                            |
| `OPENAI_PASSWORD`                    | Reserved / optional; not used for Bearer calls by default.              |
| `OPENAI_BASE_URL`                    | OpenAI-compatible base URL.                                             |
| `OPENAI_MODEL`                       | Model name for fallback parsing.                                        |
| `CIVIC_NEXUS_API_URL`                | Optional PII redaction API base URL.                                    |
| `CIVIC_NEXUS_API_KEY`                | Optional Civic Nexus API key.                                           |
| `REDIS_URL`                          | Optional Redis connection URL for similar-bug / dedup memory.           |
| `REDIS_MEMORY_PREFIX`                | Key prefix for Redis keys (default `baqa:bugs`).                        |
| `APIFY_API_TOKEN`                    | Optional Apify token for UI automation paths.                           |
| `APIFY_ACTOR_ID`                     | Optional Apify actor id.                                                |
| `JIRA_API_TOKEN`                     | Atlassian API token for Jira REST (Basic auth with email).              |
| `JIRA_USER_EMAIL`                    | Atlassian account email (same user as the API token).                   |
| `JIRA_ATLASSIAN_DOMAIN`              | Cloud host (`your-domain.atlassian.net`) or bare subdomain.             |
| `JIRA_PROJECT_KEY`                   | Jira project key (e.g. `SCRUM`).                                        |
| `JIRA_ISSUE_TYPE_NAME`               | Issue type name (e.g. `Bug`).                                           |
| `JIRA_PROJECT_ID`                    | Numeric project id for “Create Issue” deep links (`pid=`).              |
| `JIRA_ISSUE_TYPE_ID`                 | Numeric issue type id for those links.                                  |
| `COMPOSIO_API_KEY`                   | Optional Composio key (alternate Jira path).                            |
| `COMPOSIO_ENTITY_ID`                 | Composio entity id (default `default`).                                 |
| `COMPOSIO_JIRA_CONNECTED_ACCOUNT_ID` | Composio connected Jira account id.                                     |
| `OUTPUT_DIR`                         | Directory for Jira/QA markdown (default `~/Desktop/BA_QA_DEMO_OUTPUT`). |
| `MEMORY_FILE`                        | Local JSON bug memory file path.                                        |
| `BAQA_ECHO_ARTIFACTS`                | `1`/`0` — print generated markdown to the console.                      |
| `BAQA_MOCK`                          | `1` forces mock-friendly mode; unset infers from missing keys.          |

## How to run

From this folder (`ba-qa-assistant/`):

```bash
cp .env.example .env
# Edit .env with your keys and Jira domain.

pnpm install
# If this package lives inside a pnpm workspace and install fails, use:
# pnpm install --ignore-workspace

# One-shot: process a single transcript
pnpm run start -- samples/meeting.md

# Watch for new .md segments (expects ../google-meet-replica/generated relative to this package)
pnpm run start -- --watch
```

Show CLI help:

```bash
pnpm run start -- --help
```

## How it works

1. **Ingest** — Accepts a meeting transcript file (one-shot) or watches a `generated/` folder for new `.md` segments (demo integration with `google-meet-replica`).
2. **Parse** — Uses Contextual AI when configured, otherwise an OpenAI-compatible model or heuristic path, to pull structured bugs (title, steps, expected/actual, acceptance criteria).
3. **Redact & remember** — Optionally calls Civic Nexus for PII redaction; fingerprints bugs in Redis (when `REDIS_URL` is set) or local memory to avoid filing duplicates.
4. **Ship artifacts** — Creates Jira bugs via Atlassian REST, writes Jira stub markdown and QA markdown under `OUTPUT_DIR`, and generates a Word QA table with one row per real reproduction step and unique `TC-YYYYMMDD-STYn` ids.
5. **Integrate** — Pings the OpenClaw gateway if configured; downstream you can review in Claude, track in Jira (e.g. SCRUM), and implement in Cursor.
