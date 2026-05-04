# Gnomeo

Pilot landing page for pilot.flangie.co.uk

## Free Analysis submissions

- Set `RESEND_API_KEY` in Vercel with your Resend API key.
- Set `ADMIN_EMAIL` in Vercel to the inbox that should receive new submission alerts.
- Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the CRM/storage backend.

## Report Ops CRM

The admin portal uses Supabase for customers, submissions, reports, and email events.
Production submissions are tracked in the CRM, while the CSV is still delivered by admin email attachment.

## Manual Report Workflow

1. User submits CSV via site
2. Submission appears in dashboard
3. Admin receives notification email with CSV attachment
4. Download or access the CSV from the admin email attachment
5. Run:

```bash
python3 agent_mvp/agent_test.py --graph <file.csv> --output-html report.html
```

6. Review output
7. Upload the generated report in the admin CRM
8. Send the report email from the admin CRM
9. Mark follow-up or converted as needed

Live Vercel function does not run Python. Reports are generated manually/local for now.
Real file access currently happens via the admin email attachment.

## Storage Notes

- Vercel filesystem is read-only in production.
- Production workflow = email notification + CSV attachment.
- `data/submissions.json` is local/dev only.
- The CRM currently uses Supabase storage/database; future swaps still need persistent storage.

## Local Report Tool

Use `agent_mvp/admin_report_tool` locally to upload a CSV, generate a report, preview it, and send it.
