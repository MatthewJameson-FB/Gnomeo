-- Manual beta request intake for Gnomeo.
--
-- Notes:
-- - Service-role/admin code can bypass RLS server-side.
-- - No anon/public policies are created here.
-- - Beta request records are onboarding data only, separate from raw CSV uploads.

begin;

create extension if not exists pgcrypto;

create table if not exists public.beta_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  company text not null,
  website text not null,
  platforms text[] not null default '{}'::text[],
  monthly_spend_range text not null,
  is_agency boolean not null default false,
  review_goal text not null,
  notes text,
  status text not null default 'new',
  source text not null default 'workspace_beta',
  consent_at timestamptz not null default now(),
  constraint beta_requests_status_check check (status in ('new', 'contacted', 'workspace_created', 'declined')),
  constraint beta_requests_source_check check (source in ('workspace_beta')),
  constraint beta_requests_platforms_check check (array_length(platforms, 1) is not null and array_length(platforms, 1) >= 1)
);

revoke all on table public.beta_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.beta_requests to service_role;

create index if not exists idx_beta_requests_created_at on public.beta_requests (created_at desc);
create index if not exists idx_beta_requests_status_created_at on public.beta_requests (status, created_at desc);
create index if not exists idx_beta_requests_email on public.beta_requests (email);

alter table public.beta_requests enable row level security;

comment on table public.beta_requests is 'Service-role/admin only onboarding requests for the manual workspace beta.';
comment on column public.beta_requests.status is 'Lifecycle for manual onboarding review.';
comment on column public.beta_requests.source is 'Request source label for onboarding review.';
comment on column public.beta_requests.consent_at is 'When the consent checkbox was confirmed.';

commit;
