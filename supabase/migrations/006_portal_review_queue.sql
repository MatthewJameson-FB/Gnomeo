-- Portal review queue for Gnomeo customer uploads.
--
-- Notes:
-- - Service-role/admin code can bypass RLS server-side.
-- - No anon/public policies are created here.
-- - Raw CSV contents are never stored in this queue.

begin;

create extension if not exists pgcrypto;

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

commit;
