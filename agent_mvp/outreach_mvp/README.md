# Outreach MVP

Manual CSV → message draft → admin review flow.

## Files

- `candidates.csv` — manually curated source of truth
- `discovery_agent.py` — public-search candidate discovery into the CSV
- `outreach_agent.py` — loads candidates, classifies them, and fills `suggested_message`
- `admin.html` / `admin.js` / `admin.css` — read-only review UI

## Discover candidates from public search

Set:

- `SEARCH_API_KEY`
- `SEARCH_ENGINE_ID`

Then run:

```bash
python3 discovery_agent.py --category report_validator --limit 20
python3 discovery_agent.py --category data_partner --limit 20
python3 discovery_agent.py --all --limit 40
```

If the env vars are missing, the script prints the exact public search queries to run manually.

## Run message generation

```bash
cd /Users/matthewjameson/.openclaw/workspace/Gnomeo/agent_mvp/outreach_mvp
python3 outreach_agent.py
```

That updates `candidates.csv` in place with `suggested_message` values for valid, manually sourced candidates only.

## Open the admin UI

Open `admin.html` in a browser.

If the browser blocks local CSV loading, use the **Load candidates.csv** button and pick the CSV file manually.

## Workflow

1. Review candidates in the admin UI.
2. Filter by category, priority, or approval status.
3. Expand a card to read the drafted message.
4. Copy the message.
5. Approve manually and send manually.

## Rules

- No sending from the script
- No backend
- No external APIs
- No sample/fake candidates
- Discovery only uses public search results
- CSV stays the source of truth
