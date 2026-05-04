# Gnomeo

Pilot landing page for pilot.flangie.co.uk

## Free Analysis submissions

- Set `RESEND_API_KEY` in Vercel with your Resend API key.
- Set `ADMIN_EMAIL` in Vercel to the inbox that should receive new submission alerts.

## Manual Report Workflow

1. User submits CSV via site
2. Submission appears in dashboard
3. Admin receives notification email with file path
4. Download or access the CSV from the admin email attachment
5. Run:

```bash
python3 agent_mvp/agent_test.py --graph <file.csv> --output-html report.html
```

6. Review output
7. Email report back to user
8. Update status manually for now

Live Vercel function does not run Python. Reports are generated manually/local for now.
Real file access currently happens via the admin email attachment.
