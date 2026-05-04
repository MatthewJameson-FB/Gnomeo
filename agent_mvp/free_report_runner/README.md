# Gnomeo Free Report Runner

A tiny local UI for free-tier report processing.

## What it does

- uploads a CSV
- saves it into `~/Gnomeo/free_reports/inbox/`
- runs `../run_report.py`
- shows the generated HTML + MD report paths
- gives you an `Open report` link

## Run it

```bash
cd agent_mvp/free_report_runner
python3 -m venv .venv
source .venv/bin/activate
pip install flask
python3 app.py
```

Then open:

```text
http://localhost:6060
```

## Notes

- local only
- no email is sent
- CSV files must be valid and readable
- if macOS permissions get in the way, move the CSV into `~/Gnomeo/free_reports/inbox` first
- after generating the report, upload the HTML to the admin portal and send the customer email there
