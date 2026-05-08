# Supabase Security and Workspace Beta Plan

## Current findings

From the code inspected:

- `api/_supabase.js` is the Supabase helper layer.
  - Uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
  - Exposes REST helpers: `restSelect`, `restSingle`, `restInsert`, `restUpsert`, `restUpdate`.
  - Exposes storage helpers: `storageUpload`, `storageDownload`.
- `api/submit.js` uses Supabase for the public intake flow.
  - Reads/writes `customers`.
  - Inserts `submissions`.
  - Inserts `email_events`.
  - Uploads CSVs into storage bucket `submissions`.
  - Falls back to local JSON logging when Supabase is unavailable.
- `api/_multipart.js` parses multipart uploads into a single file object.
- No auth flow is wired yet in the inspected code.
- No Stripe or billing integration is present in the inspected code.

## Secret / key risk

- I did not see hardcoded secrets in the inspected source.
- The code depends on env vars for Supabase and email credentials.
- The service-role key must stay server-side only.
- The bucket/object paths should never be exposed directly to anon clients unless intentionally public.

## Security risks

- Service-role access is powerful; keep it confined to API routes.
- Public uploads should not be readable by anon users unless you explicitly want that.
- Raw CSV uploads should have a clear retention rule and cleanup path.
- The current intake flow stores customer/submission metadata; that should stay restricted.
- Any future workspace history should not be public by default.

## Minimal paid beta schema

### `profiles`
- `id` uuid primary key
- `email` text unique not null
- `created_at` timestamptz default now()

### `workspaces`
- `id` uuid primary key
- `profile_id` uuid nullable
- `owner_email` text nullable
- `workspace_name` text not null
- `business_type` text
- `primary_goal` text
- `risk_appetite` text
- `budget_constraint` text
- `notes` text
- `plan` text not null default 'manual_beta'
- `status` text not null default 'pending'
- `created_at` timestamptz default now()
- `updated_at` timestamptz default now()

### `report_runs`
- `id` uuid primary key
- `workspace_id` uuid not null
- `status` text not null
- `source_count` integer
- `platforms` text[]
- `spend_analysed` numeric
- `revenue_analysed` numeric
- `roas` numeric
- `wasted_spend` numeric
- `report_url` text
- `report_html_path` text
- `created_at` timestamptz default now()

### `usage_events`
- `id` uuid primary key
- `workspace_id` uuid not null
- `event_type` text not null
- `plan` text
- `metadata` jsonb default '{}'::jsonb
- `created_at` timestamptz default now()

## Proposed RLS approach

### Default stance
- Enable RLS on all new tables.
- Default to no public access.
- Use service-role for admin/internal writes.
- Keep auth policies future-ready, but do not assume auth is live.

### Suggested policy shape
- `profiles`: no anon access; future user policy can allow `auth.uid()`-matched row only.
- `workspaces`: no anon access; future user policy can allow owner access only.
- `report_runs`: no anon access; future user policy can allow workspace owner read-only.
- `usage_events`: no anon access; service-role only.

### SQL draft

```sql
-- Profiles
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  created_at timestamptz not null default now()
);

-- Workspaces
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid null references public.profiles(id) on delete set null,
  owner_email text not null,
  workspace_name text not null,
  business_type text,
  primary_goal text,
  risk_appetite text,
  budget_constraint text,
  notes text,
  plan text not null default 'manual_beta',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Report runs
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
  created_at timestamptz not null default now()
);

-- Usage events
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_type text not null,
  plan text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.report_runs enable row level security;
alter table public.usage_events enable row level security;

-- Future-ready user policies (keep commented until auth exists)
-- create policy "profiles_select_own" on public.profiles
--   for select using (auth.uid() = id);
--
-- create policy "workspaces_select_own" on public.workspaces
--   for select using (auth.uid() = profile_id);
--
-- create policy "report_runs_select_own" on public.report_runs
--   for select using (
--     exists (
--       select 1 from public.workspaces w
--       where w.id = report_runs.workspace_id
--         and w.profile_id = auth.uid()
--     )
--   );
```

## Storage review

Current code uses bucket name `submissions`.

Recommended stance:
- Keep intake CSV storage private.
- Only service-role or backend jobs should upload/read raw CSVs.
- If report HTML exports are stored later, keep them private too.
- If manual beta users need download links, generate short-lived signed URLs.

## Manual concierge beta workflow

1. User requests beta.
2. Admin manually creates a workspace row.
3. Admin links the user to the workspace by email.
4. Report runs attach to the workspace later.
5. User receives the report by email.
6. Report history and usage events are managed manually until portal auth exists.

## Manual Supabase dashboard checklist

- Confirm RLS is enabled on all new tables.
- Confirm `submissions` bucket is private.
- Confirm service-role key is only stored in server env vars.
- Confirm anon key cannot read workspace history or raw uploads.
- Confirm any future public bucket contains no raw CSVs or private reports.
- Confirm backup/retention policy for raw uploads.
- Confirm audit logs for admin/manual changes.

## Next implementation steps

- Create the new tables in Supabase.
- Decide whether `profiles.id` should mirror auth user ids later.
- Decide whether `owner_email` stays permanent or is only an onboarding bridge.
- Add a backend layer for workspace creation and report attachment.
- Add a cleanup policy for raw CSV uploads.
- Add signed-download handling if users need report access before auth exists.

## Migration file created

- `supabase/migrations/001_paid_beta_workspaces.sql`

## Manual application steps

1. Review the SQL locally.
2. Apply it in a Supabase SQL editor only after approval.
3. Confirm the tables exist.
4. Confirm RLS is enabled on all four tables.
5. Confirm grants/policies are default-deny for anon/public.
6. Confirm service-role/server-side operations can still write.

## Rollback considerations

- Roll back by dropping the new tables in reverse dependency order:
  - `usage_events`
  - `report_runs`
  - `workspaces`
  - `profiles`
- If you need a softer rollback, leave the tables in place and remove any app code that depends on them.
- Keep in mind that dropping `workspaces` will cascade to `report_runs` and `usage_events` if the current foreign keys are used.

## Dashboard checklist

- Verify `pgcrypto` is available.
- Verify `submissions` bucket privacy.
- Verify `service_role` is limited to server usage only.
- Verify no anon/authenticated policies were accidentally added.
- Verify no raw CSV or report object is public.
- Verify manual beta rows can be created and queried from the admin path.
