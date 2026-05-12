-- Schema reconciliation for the Gnomeo beta portal and admin readiness check.
-- Additive only: no drops, no deletes, no RLS weakening.

begin;

create extension if not exists pgcrypto;

alter table public.workspaces
  add column if not exists portal_token_hash text,
  add column if not exists portal_token_created_at timestamptz,
  add column if not exists portal_token_last_used_at timestamptz,
  add column if not exists portal_token_revoked_at timestamptz,
  add column if not exists memory_summary jsonb not null default '{}'::jsonb,
  add column if not exists recurring_issues jsonb not null default '[]'::jsonb,
  add column if not exists open_recommendations jsonb not null default '[]'::jsonb,
  add column if not exists trend_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists next_review_focus jsonb not null default '[]'::jsonb,
  add column if not exists last_handover_at timestamptz,
  add column if not exists beta_request_id uuid,
  add column if not exists website text,
  add column if not exists platforms text[],
  add column if not exists review_goal text,
  add column if not exists is_agency boolean not null default false;

alter table public.report_runs
  add column if not exists report_title text,
  add column if not exists report_content text,
  add column if not exists report_markdown text,
  add column if not exists source_platforms text[],
  add column if not exists source_filenames text[],
  add column if not exists row_count integer,
  add column if not exists input_bytes bigint,
  add column if not exists summary jsonb not null default '{}'::jsonb,
  add column if not exists top_recommendations jsonb not null default '[]'::jsonb,
  add column if not exists trend_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists sources jsonb not null default '[]'::jsonb,
  add column if not exists top_priorities jsonb not null default '[]'::jsonb,
  add column if not exists recommendations jsonb not null default '[]'::jsonb,
  add column if not exists trend_notes text,
  add column if not exists completed_at timestamptz,
  add column if not exists error_message text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.beta_requests
  add column if not exists workspace_id uuid references public.workspaces(id) on delete set null,
  add column if not exists workspace_created_at timestamptz,
  add column if not exists portal_link_created_at timestamptz;

create table if not exists public.portal_review_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null default 'received',
  filenames text[] not null default '{}'::text[],
  platforms text[] not null default '{}'::text[],
  file_count integer not null default 0,
  report_run_id uuid references public.report_runs(id) on delete set null,
  completed_at timestamptz,
  notes text
);

revoke all on table public.portal_review_submissions from public, anon, authenticated;
grant select, insert, update, delete on table public.portal_review_submissions to service_role;

create index if not exists idx_workspaces_portal_token_hash on public.workspaces (portal_token_hash)
  where portal_token_hash is not null;
create index if not exists idx_workspaces_portal_token_revoked_at on public.workspaces (portal_token_revoked_at);
create index if not exists idx_workspaces_last_handover_at on public.workspaces (last_handover_at desc nulls last);
create unique index if not exists idx_workspaces_beta_request_id on public.workspaces (beta_request_id)
  where beta_request_id is not null;
create unique index if not exists idx_beta_requests_workspace_id on public.beta_requests (workspace_id)
  where workspace_id is not null;
create index if not exists idx_report_runs_workspace_id_created_at on public.report_runs (workspace_id, created_at desc);
create index if not exists idx_report_runs_status_created_at on public.report_runs (status, created_at desc);
create index if not exists idx_portal_review_submissions_workspace_id_created_at on public.portal_review_submissions (workspace_id, created_at desc);
create index if not exists idx_portal_review_submissions_status_created_at on public.portal_review_submissions (status, created_at desc);
create index if not exists idx_portal_review_submissions_report_run_id on public.portal_review_submissions (report_run_id);

alter table public.portal_review_submissions enable row level security;
comment on table public.portal_review_submissions is 'Service-role/admin only queue for portal review submissions.';
comment on column public.portal_review_submissions.status is 'Queue status for portal review processing.';
comment on column public.portal_review_submissions.filenames is 'Uploaded CSV filenames only; no raw content is stored.';
comment on column public.portal_review_submissions.platforms is 'Detected source platforms for the upload.';
comment on column public.portal_review_submissions.report_run_id is 'Linked report run when generation completes.';
comment on column public.portal_review_submissions.notes is 'Safe non-sensitive processing note.';

notify pgrst, 'reload schema';

commit;
