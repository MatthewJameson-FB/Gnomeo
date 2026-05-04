# Gnomeo CRM Database Schema

## customers
- id
- email
- company
- status
- notes
- created_at

## submissions
- id
- customer_id
- original_filename
- csv_file_url
- status
- created_at
- notes

## reports
- id
- submission_id
- report_file_url
- summary
- created_at
- sent_at

## email_events
- id
- customer_id
- submission_id
- type
- status
- sent_at

See `supabase_schema.sql` for DDL.
