# Outreach MVP

Simple CSV → message draft → admin review flow.

## Files

- `candidates.csv` — source of truth
- `outreach_agent.py` — loads candidates, classifies them, and fills `suggested_message`
- `admin.html` / `admin.js` / `admin.css` — read-only review UI

## Run message generation

```bash
cd /Users/matthewjameson/.openclaw/workspace/Gnomeo/agent_mvp/outreach_mvp
python3 outreach_agent.py
```

That updates `candidates.csv` in place with `suggested_message` values.

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
- CSV stays the source of truth
