-- Portal tokens and richer workspace report history for the beta workspace portal.
--
-- Notes:
-- - Service-role/admin code can bypass RLS server-side.
-- - No anon/public policies are created here.
-- - This keeps portal access separate from ADMIN_SECRET.

begin;

alter table public.workspaces
  add column if not exists portal_token_hash text,
  add column if not exists portal_token_created_at timestamptz,
  add column if not exists portal_token_last_used_at timestamptz,
  add column if not exists portal_token_revoked_at timestamptz;

alter table public.report_runs
  add column if not exists report_title text,
  add column if not exists report_content text,
  add column if not exists source_platforms text[],
  add column if not exists source_filenames text[],
  add column if not exists row_count integer,
  add column if not exists input_bytes bigint,
  add column if not exists summary jsonb not null default '{}'::jsonb,
  add column if not exists top_recommendations jsonb not null default '[]'::jsonb,
  add column if not exists trend_snapshot jsonb not null default '[]'::jsonb;

create unique index if not exists idx_workspaces_portal_token_hash on public.workspaces (portal_token_hash)
  where portal_token_hash is not null;

create index if not exists idx_workspaces_portal_token_revoked_at on public.workspaces (portal_token_revoked_at);
create index if not exists idx_report_runs_workspace_id_report_title on public.report_runs (workspace_id, created_at desc);

comment on column public.workspaces.portal_token_hash is 'SHA-256 hash of the customer portal token.';
comment on column public.workspaces.portal_token_created_at is 'When the current portal token was issued.';
comment on column public.workspaces.portal_token_last_used_at is 'Last time the portal token was used.';
comment on column public.workspaces.portal_token_revoked_at is 'When the current portal token was revoked, if applicable.';
comment on column public.report_runs.report_title is 'Human-readable report title for the portal.';
comment on column public.report_runs.report_content is 'Markdown report content for the portal.';
comment on column public.report_runs.source_platforms is 'Detected platforms analyzed for the report.';
comment on column public.report_runs.source_filenames is 'Uploaded CSV filenames used for the report.';
comment on column public.report_runs.row_count is 'Total CSV row count for the report input.';
comment on column public.report_runs.input_bytes is 'Total CSV byte size for the report input.';
comment on column public.report_runs.summary is 'Compact report summary for the portal.';
comment on column public.report_runs.top_recommendations is 'Top recommendations extracted from the report.';
comment on column public.report_runs.trend_snapshot is 'Compact trend snapshot for recurring review context.';

commit;
