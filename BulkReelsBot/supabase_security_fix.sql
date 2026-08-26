-- ============================================================
-- Bulk Reels Upload Pro — SECURITY FIX (C1–C5)
-- Run this ONCE in Supabase → SQL Editor → New query → Run
-- Safe to re-run: everything uses IF EXISTS / OR REPLACE.
--
-- What this fixes (matches the security audit):
--   C1  tool_users SELECT was `using (true)`  → anyone with the anon key
--       could read ALL users' activation_key / expires_at / machine_id.
--       → ALL direct SELECT is now blocked; reads happen only through the
--         SECURITY DEFINER RPCs below (which return only safe fields —
--         activation_key is NEVER returned).
--   C2  tool_users UPDATE was `using (true) with check (true)` → anyone
--       could self-unlock expiry, unblock themselves, clear machine_id,
--       or edit OTHER users' rows.  → ALL direct UPDATE is now blocked;
--       last_seen/machine binding happens only inside the RPCs.
--   C4  admin_config (password hash) was anon-readable. → policy dropped;
--       the app reads it with the admin (service) client instead.
--   C5  app_versions had a live PLACEHOLDER row (fake Google Drive link).
--       → placeholder rows are deactivated by this script. Publishing a
--       new version from the Admin Panel also auto-deactivates old rows.
--   C3  (service key shipped inside the app) — the RLS fixes above are the
--       immediate stopgap: the anon key can no longer touch tool_users /
--       admin_config at all. The permanent fix is to move admin operations
--       into a Supabase Edge Function so the service key never ships with
--       the exe. Plan this as the next migration.
--
-- ⚠️ MIGRATION NOTE: after running this script, OLD builds (that read/
--    patch tool_users directly) will fail to authenticate — users must
--    update to the fixed build (1.5.0). Publish the new version right
--    after applying this script.
-- ============================================================

-- ---------- C1: block ALL direct SELECT on tool_users ----------
drop policy if exists "read own row"  on public.tool_users;
drop policy if exists "read anon"     on public.tool_users;
-- (no select policy left → anon can read NOTHING from tool_users)

-- ---------- C2: block ALL direct UPDATE on tool_users ----------
drop policy if exists "update last_seen" on public.tool_users;
drop policy if exists "update own row"   on public.tool_users;
-- (no update policy left → anon can change NOTHING in tool_users)

-- ---------- Activation / verify via SECURITY DEFINER RPC ----------
-- SECURITY DEFINER = runs with the function owner's rights (bypasses RLS),
-- but ONLY exposes these exact operations and ONLY returns safe fields.

-- Activate: verify username + key, refresh last_seen, bind machine_id
-- (binds ONLY when the row has no machine_id yet — device lock preserved).
create or replace function public.activate_license(
  p_username text, p_key text, p_machine_id text)
returns table (id uuid, username text, full_name text, is_admin boolean,
               expires_at timestamptz, is_blocked boolean, machine_id text)
language sql security definer volatile
set search_path = public
as $$
  update public.tool_users t
     set last_seen_at = now(),
         machine_id   = case when t.machine_id = '' or t.machine_id is null
                             then p_machine_id else t.machine_id end
   where lower(t.username) = lower(p_username) and t.activation_key = p_key
  returning t.id, t.username, t.full_name, t.is_admin, t.expires_at,
            t.is_blocked, t.machine_id;
$$;

-- Verify (by id): refresh last_seen, return the safe fields the app needs
-- for its live background re-check (expiry / blocked / device lock).
create or replace function public.verify_license(p_id uuid)
returns table (id uuid, username text, full_name text, is_admin boolean,
               expires_at timestamptz, is_blocked boolean, machine_id text)
language sql security definer volatile
set search_path = public
as $$
  update public.tool_users t
     set last_seen_at = now()
   where t.id = p_id
  returning t.id, t.username, t.full_name, t.is_admin, t.expires_at,
            t.is_blocked, t.machine_id;
$$;

-- Lightweight heartbeat (kept for future use / parity with the audit).
create or replace function public.refresh_license_seen(p_id uuid)
returns void
language sql security definer volatile
set search_path = public
as $$ update public.tool_users set last_seen_at = now() where id = p_id; $$;

grant execute on function public.activate_license(text, text, text) to anon;
grant execute on function public.verify_license(uuid)              to anon;
grant execute on function public.refresh_license_seen(uuid)        to anon;

-- ---------- C4: admin_config no longer anon-readable ----------
drop policy if exists "read admin config" on public.admin_config;
-- (the app's adminLogin() now reads the hash with the admin client)

-- ---------- C5: deactivate placeholder update rows ----------
update public.app_versions
   set is_active = false
 where download_url ilike '%placeholder%'
    or download_url ilike '%your-installer-link-here%';

-- ============================================================
-- VERIFY (run these as a sanity check):
--   -- these must now return ZERO rows for the anon role simulation:
--   select username, activation_key from public.tool_users limit 1;  -- via app anon key → 0 rows
--   select * from public.admin_config;                               -- via app anon key → 0 rows
--   -- these must still work:
--   select * from public.activate_license('someuser','SOME-KEY','machinelocalhash');
--   select version, is_active from public.app_versions order by published_at desc;
-- ============================================================
