-- Soft-delete portal reviews during beta.
-- Additive only: no drops, no hard deletes, no RLS weakening.

begin;

alter table public.report_runs
  add column if not exists deleted_at timestamptz;

alter table public.portal_review_submissions
  add column if not exists deleted_at timestamptz;

create index if not exists report_runs_workspace_deleted_created_idx
  on public.report_runs (workspace_id, deleted_at, created_at desc);

create index if not exists portal_review_submissions_workspace_deleted_created_idx
  on public.portal_review_submissions (workspace_id, deleted_at, created_at desc);

comment on column public.report_runs.deleted_at is 'Soft delete timestamp for portal review removal.';
comment on column public.portal_review_submissions.deleted_at is 'Soft delete timestamp for portal review removal.';

notify pgrst, 'reload schema';

commit;
