-- Manual concierge beta workspace model for Gnomeo.
--
-- Notes:
-- - This migration is migration-ready only; do not apply remotely until reviewed.
-- - Service-role/admin code can bypass RLS server-side.
-- - No anon/public policies are created here.
-- - Future auth policies are included as commented examples only.

begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete set null,
  owner_email text not null,
  workspace_name text not null,
  business_type text,
  primary_goal text,
  risk_appetite text,
  budget_constraint text,
  notes text,
  plan text not null default 'manual_beta',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_plan_check check (plan in ('manual_beta', 'pro', 'agency', 'free')),
  constraint workspaces_status_check check (status in ('active', 'inactive', 'cancelled', 'pending')),
  constraint workspaces_risk_appetite_check check (
    risk_appetite is null or risk_appetite in ('conservative', 'balanced', 'aggressive')
  )
);

create table if not exists public.report_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null,
  source_count integer,
  platforms text[],
  spend_analysed numeric,
  revenue_analysed numeric,
  roas numeric,
  wasted_spend numeric,
  report_url text,
  report_html_path text,
  created_at timestamptz not null default now(),
  constraint report_runs_source_count_check check (source_count is null or source_count >= 0),
  constraint report_runs_spend_check check (spend_analysed is null or spend_analysed >= 0),
  constraint report_runs_revenue_check check (revenue_analysed is null or revenue_analysed >= 0),
  constraint report_runs_roas_check check (roas is null or roas >= 0),
  constraint report_runs_wasted_spend_check check (wasted_spend is null or wasted_spend >= 0)
);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_type text not null,
  plan text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint usage_events_plan_check check (plan is null or plan in ('manual_beta', 'pro', 'agency', 'free'))
);

-- Default-deny posture: do not expose these tables to anon/public by default.
revoke all on table public.profiles from public, anon, authenticated;
revoke all on table public.workspaces from public, anon, authenticated;
revoke all on table public.report_runs from public, anon, authenticated;
revoke all on table public.usage_events from public, anon, authenticated;

-- Service-role/admin access for server-side operations.
grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.workspaces to service_role;
grant select, insert, update, delete on table public.report_runs to service_role;
grant select, insert, update, delete on table public.usage_events to service_role;

create index if not exists idx_profiles_email on public.profiles (email);
create index if not exists idx_workspaces_profile_id on public.workspaces (profile_id);
create index if not exists idx_workspaces_owner_email on public.workspaces (owner_email);
create index if not exists idx_workspaces_status_created_at on public.workspaces (status, created_at desc);
create index if not exists idx_report_runs_workspace_id_created_at on public.report_runs (workspace_id, created_at desc);
create index if not exists idx_report_runs_status_created_at on public.report_runs (status, created_at desc);
create index if not exists idx_usage_events_workspace_id_created_at on public.usage_events (workspace_id, created_at desc);
create index if not exists idx_usage_events_event_type_created_at on public.usage_events (event_type, created_at desc);

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.report_runs enable row level security;
alter table public.usage_events enable row level security;

comment on table public.profiles is 'Service-role/admin only for manual concierge beta until auth is implemented.';
comment on table public.workspaces is 'Service-role/admin only for manual concierge beta until auth is implemented.';
comment on table public.report_runs is 'Service-role/admin only for manual concierge beta until auth is implemented.';
comment on table public.usage_events is 'Service-role/admin only for manual concierge beta until auth is implemented.';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_workspaces_set_updated_at on public.workspaces;
create trigger trg_workspaces_set_updated_at
before update on public.workspaces
for each row
execute function public.set_updated_at();

-- Future auth policies (disabled for now):
--
-- create policy "profiles_select_own" on public.profiles
--   for select using (auth.uid() = id);
--
-- create policy "workspaces_select_own" on public.workspaces
--   for select using (auth.uid() = profile_id);
--
-- create policy "report_runs_select_own" on public.report_runs
--   for select using (
--     exists (
--       select 1
--       from public.workspaces w
--       where w.id = report_runs.workspace_id
--         and w.profile_id = auth.uid()
--     )
--   );
--
-- create policy "usage_events_select_own" on public.usage_events
--   for select using (
--     exists (
--       select 1
--       from public.workspaces w
--       where w.id = usage_events.workspace_id
--         and w.profile_id = auth.uid()
--     )
--   );

commit;
