create extension if not exists pgcrypto;

create type customer_status as enum ('lead', 'qualified', 'active_trial', 'paid', 'lost');
create type submission_status as enum ('received', 'processing', 'report_ready', 'report_sent', 'follow_up', 'converted', 'lost');
create type email_event_status as enum ('sent', 'failed');

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  company text,
  status customer_status not null default 'lead',
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  original_filename text not null,
  csv_file_url text not null,
  status submission_status not null default 'received',
  created_at timestamptz not null default now(),
  notes text
);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions(id) on delete cascade,
  report_file_url text not null,
  summary text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists email_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  submission_id uuid references submissions(id) on delete cascade,
  type text not null,
  status email_event_status not null,
  sent_at timestamptz not null default now()
);

create index if not exists submissions_customer_id_idx on submissions(customer_id);
create index if not exists reports_submission_id_idx on reports(submission_id);
create index if not exists email_events_customer_id_idx on email_events(customer_id);
create index if not exists email_events_submission_id_idx on email_events(submission_id);
