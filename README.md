# Gnomeo

Pilot landing page for pilot.flangie.co.uk

## Free Analysis submissions

- Set `RESEND_API_KEY` in Vercel with your Resend API key.
- Set `ADMIN_EMAIL` in Vercel to the inbox that should receive new submission alerts.

## Manual Report Workflow

1. User submits CSV via site
2. Admin receives notification email with file path
3. Download or access file
4. Run:

```bash
python3 agent_mvp/agent_test.py --graph <file.csv> --output-html report.html
```

5. Review output
6. Email report back to user

Live Vercel function does not run Python. Reports are generated manually/local for now.
