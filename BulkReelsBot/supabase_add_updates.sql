-- ============================================================
-- Update / Version Management for Bulk Reels Upload Pro
-- Run this ONCE in Supabase → SQL Editor → New query → Run
-- ============================================================

create table if not exists public.app_versions (
  id            uuid primary key default gen_random_uuid(),
  version       text not null,                    -- e.g. "1.5.0" (semver)
  download_url  text not null,                    -- Google Drive / Mega direct link
  release_notes text default '',                  -- what's new
  is_force      boolean not null default false,   -- force user to update?
  min_version   text default '',                  -- if current < this, force
  published_at  timestamptz not null default now(),
  is_active     boolean not null default true     -- only active row is served
);

create index if not exists app_versions_active_idx
  on public.app_versions (is_active, published_at desc);

alter table public.app_versions enable row level security;

-- Anyone with anon key can READ the latest active version (public info)
drop policy if exists "read active version" on public.app_versions;
create policy "read active version"
  on public.app_versions for select
  using (true);

-- Seed the CURRENT version so no "update available" shows up right away
-- Change this whenever you release a new version — or use Admin Panel UI.
insert into public.app_versions (version, download_url, release_notes, is_force, is_active)
values (
  '1.4.0',
  'https://drive.google.com/your-installer-link-here',
  'Initial release with user/admin panel, activation system, and auto-comments.',
  false,
  true
)
on conflict do nothing;

-- ============================================================
-- VERIFY:
--   select version, is_active, is_force, published_at
--   from public.app_versions order by published_at desc;
-- ============================================================
