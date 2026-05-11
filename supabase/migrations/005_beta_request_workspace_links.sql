-- Manual beta request to workspace linkage for Gnomeo.
--
-- Notes:
-- - Service-role/admin code can bypass RLS server-side.
-- - No anon/public policies are created here.
-- - The link is for manual beta workflow bookkeeping only.

begin;

alter table public.workspaces
  add column if not exists beta_request_id uuid,
  add column if not exists website text,
  add column if not exists platforms text[],
  add column if not exists review_goal text,
  add column if not exists is_agency boolean not null default false;

alter table public.beta_requests
  add column if not exists workspace_id uuid references public.workspaces(id) on delete set null;

create unique index if not exists idx_workspaces_beta_request_id on public.workspaces (beta_request_id)
  where beta_request_id is not null;

create unique index if not exists idx_beta_requests_workspace_id on public.beta_requests (workspace_id)
  where workspace_id is not null;

comment on column public.workspaces.beta_request_id is 'Linked beta request for manual workspace onboarding.';
comment on column public.workspaces.website is 'Customer website captured from the beta request.';
comment on column public.workspaces.platforms is 'Ad platforms captured from the beta request.';
comment on column public.workspaces.review_goal is 'What the customer wants reviewed.';
comment on column public.workspaces.is_agency is 'Whether the workspace came from an agency request.';
comment on column public.beta_requests.workspace_id is 'Linked workspace created from this beta request.';

commit;
