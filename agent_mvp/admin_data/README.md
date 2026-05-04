# Gnomeo Supabase CRM Schema

Private buckets:

- `submissions` — uploaded CSV files
- `reports` — uploaded report HTML/PDF files

The schema below supports:

- customers
- submissions
- reports
- email_events

`csv_file_url` and `report_file_url` should be treated as Supabase Storage object paths (resolved server-side), not public browser URLs.
