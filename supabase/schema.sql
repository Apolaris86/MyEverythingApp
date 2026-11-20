-- MyEverythingApp: cloud storage for to-dos, training, portfolio and settings.
-- Run once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.

-- One row per user per document ("todos", "training", "pf", "settings").
create table if not exists public.app_docs (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  key        text        not null check (key in ('todos', 'training', 'pf', 'settings')),
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Row Level Security: each signed-in user can only see and change their own rows.
alter table public.app_docs enable row level security;

drop policy if exists "own docs: select" on public.app_docs;
drop policy if exists "own docs: insert" on public.app_docs;
drop policy if exists "own docs: update" on public.app_docs;
drop policy if exists "own docs: delete" on public.app_docs;

create policy "own docs: select" on public.app_docs for select to authenticated using (user_id = (select auth.uid()));
create policy "own docs: insert" on public.app_docs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own docs: update" on public.app_docs for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own docs: delete" on public.app_docs for delete to authenticated using (user_id = (select auth.uid()));

-- Signed-out visitors get nothing.
revoke all on public.app_docs from anon;
grant select, insert, update, delete on public.app_docs to authenticated;
