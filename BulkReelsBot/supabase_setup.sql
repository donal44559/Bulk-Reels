-- ============================================================
-- Bulk Reels Upload Pro — Supabase schema (v2)
-- Run this ONCE in Supabase → SQL Editor → New query → Run
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT
-- ============================================================

-- ---------- USERS TABLE ----------
create table if not exists public.tool_users (
  id                uuid primary key default gen_random_uuid(),
  username          text unique not null,
  activation_key    text unique not null,
  full_name         text default '',
  expires_at        timestamptz not null,
  is_blocked        boolean not null default false,
  notes             text default '',
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  last_seen_ip      text default '',
  machine_id        text default ''
);

create index if not exists tool_users_username_idx on public.tool_users (lower(username));
create index if not exists tool_users_key_idx      on public.tool_users (activation_key);

-- ---------- ROW LEVEL SECURITY ----------
alter table public.tool_users enable row level security;

drop policy if exists "read own row"     on public.tool_users;
drop policy if exists "update last_seen"  on public.tool_users;

create policy "read own row"
  on public.tool_users for select
  using (true);

create policy "update last_seen"
  on public.tool_users for update
  using (true)
  with check (true);

-- ---------- SEED: OWNER ADMIN USER ----------
insert into public.tool_users (username, activation_key, full_name, expires_at, notes)
values (
  'eusuf',
  'EUSUF-OWNER-9K7X-MASTER-2026',
  'Eusuf Hasan (Owner)',
  now() + interval '10 years',
  'Owner account — do not delete'
)
on conflict (username) do update set
  activation_key = excluded.activation_key,
  expires_at     = excluded.expires_at,
  is_blocked     = false,
  notes          = excluded.notes;

-- ---------- ADMIN CONFIG TABLE ----------
create table if not exists public.admin_config (
  key   text primary key,
  value text not null
);

alter table public.admin_config enable row level security;

drop policy if exists "read admin config" on public.admin_config;
create policy "read admin config"
  on public.admin_config for select
  using (true);

-- Admin password: Abc123@#$Eusuf2026 (bcrypt hashed)
insert into public.admin_config (key, value)
values ('admin_password_hash', '$2b$10$PIYHxVGenfUWb4GoobVOJu76FNtuYY9Pi/67kNkmrIfJlYfOFzLu.')
on conflict (key) do update set value = excluded.value;

-- ============================================================
-- VERIFY:
--   select username, activation_key, expires_at, is_blocked from public.tool_users;
--   select * from public.admin_config;
-- ============================================================
