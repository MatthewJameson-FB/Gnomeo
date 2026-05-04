# Gnomeo

Pilot landing page for pilot.flangie.co.uk

## Free Analysis submissions

- Set `RESEND_API_KEY` in Vercel with your Resend API key.
- Set `ADMIN_EMAIL` in Vercel to the inbox that should receive new submission alerts.
- The submission endpoint now runs the agent synchronously, generates `output_report.md` + `output_report.html`, emails the report to the user, and keeps the admin notification email.
