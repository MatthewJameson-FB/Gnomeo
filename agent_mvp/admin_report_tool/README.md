# Gnomeo Local Report Tool

Local-only Flask tool for generating and emailing Gnomeo reports.

## Run

```bash
cd agent_mvp/admin_report_tool
python3 -m venv .venv
source .venv/bin/activate
pip install flask resend
export RESEND_API_KEY=your_key
python3 app.py
```

Then open:

```bash
http://localhost:5050
```

## Workflow

1. Download CSV from admin email attachment
2. Open local report tool
3. Upload CSV
4. Enter recipient email
5. Generate + send report
6. Review preview link

## Notes

- This tool is local-only.
- If `RESEND_API_KEY` is missing, email sending stops with a clear error.
- Report generation uses `../agent_test.py`.
