-- ============================================================
-- Add is_admin flag to tool_users
-- Only users with is_admin=true see the Admin Panel in the UI
-- Run this ONCE in Supabase → SQL Editor
-- ============================================================

alter table public.tool_users
  add column if not exists is_admin boolean not null default false;

-- Mark the owner as admin
update public.tool_users
  set is_admin = true
  where username = 'eusuf';

-- Verify:
--   select username, is_admin, expires_at from public.tool_users;
