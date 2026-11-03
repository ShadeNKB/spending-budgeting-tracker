-- SpendTrack sync — migration 005: the lockdown (F-006, the database half).
--
-- Gate E of docs/brain/sync-runbook.md: apply only when Settings › Sync says "Ready for the
-- database lockdown." on a device, at least 7 days after 004, with checks/004_verify.sql
-- passed. Run 000_preflight_readonly.sql first (stage "004 applied", GO); run
-- checks/005_verify.sql after. Undo: 005_sync_lockdown.rollback.sql.
--
-- How: Supabase → SQL Editor → New query → paste this whole file → Run, as the table owner
-- (postgres). Expected: "Success. No rows returned". Safe to run again.
--
-- What it does. No row is touched.
--   1. anon and authenticated lose every privilege on public.sync_buckets: nobody holding the
--      public anon key can list, read or write rows through the table any more.
--   2. Row level security on, with NO policies, on purpose: deny-all for the API roles. (The
--      Supabase advisor will say "RLS enabled, no policy" for this table: expected.) Not
--      FORCEd, so the 004 functions, owned by the table owner, keep reading and writing: every
--      device syncs through them.
--   3. The table leaves the supabase_realtime publication (no row changes are broadcast; the app
--      tells its other devices over Broadcast and checks every minute) and its replica identity
--      goes back to the default.
--
-- Not in this file (see the runbook's "Later, optional"): reviewing or deleting old rows, and a
-- pg_cron prune at 365 days run as postgres.
--
-- If it stops with an ERROR: nothing was applied. Run `ROLLBACK;` once in a new query, then
-- read the message.

-- Preconditions, before BEGIN. A lockdown without working functions would stop every device.
DO $pre$
DECLARE
  v_table regclass := to_regclass('public.sync_buckets');
  v_owner oid;
  v_ok int;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 005: table public.sync_buckets not found; is this the right project? Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 005: roles anon and authenticated not found; run this in the Supabase project that holds the relay. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  SELECT c.relowner INTO v_owner FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;
  IF v_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'SpendTrack 005: run this as the table owner (%); you are %. Nothing was changed.',
      v_owner::regrole, current_user
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_ok
    FROM unnest(ARRAY[to_regprocedure('public.st_sync_head(text)'),
                      to_regprocedure('public.st_sync_pull(text)'),
                      to_regprocedure('public.st_sync_push(text, jsonb, timestamptz, boolean)')]) AS f(fn)
    JOIN pg_catalog.pg_proc AS p ON p.oid = f.fn
   WHERE p.prosecdef
     AND p.proconfig @> ARRAY['search_path=""']
     AND p.proowner = v_owner
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_ok <> 3 THEN
    RAISE EXCEPTION 'SpendTrack 005: the sync functions from 004 are missing or not as 004 made them. Apply 004 and run 004_verify.sql first. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  -- FORCEd row level security would hide the rows from the functions too (their owner has no
  -- BYPASSRLS on Supabase): every device would be locked out.
  IF (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class AS c WHERE c.oid = v_table) THEN
    RAISE EXCEPTION 'SpendTrack 005: row level security on public.sync_buckets is FORCEd, which would lock the sync functions out too. Tell the lead. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  -- Step 3 must be able to take the table out of the publication.
  IF EXISTS (SELECT 1
               FROM pg_catalog.pg_publication AS p
               JOIN pg_catalog.pg_publication_tables AS pt ON pt.pubname = p.pubname
              WHERE p.pubname = 'supabase_realtime'
                AND pt.schemaname = 'public' AND pt.tablename = 'sync_buckets'
                AND (p.puballtables OR NOT pg_has_role(p.pubowner, 'USAGE'))) THEN
    RAISE EXCEPTION 'SpendTrack 005: the supabase_realtime publication lists the table, but this role cannot change it (it is FOR ALL TABLES, or another role owns it). Tell the lead. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

BEGIN;

SET LOCAL lock_timeout = '10s';

-- The lockout checks again, inside the transaction: a client that runs on after the first error
-- (psql without ON_ERROR_STOP, some script runners) must not close the table without working
-- functions. A refusal here aborts the transaction in any client.
DO $guard$
DECLARE
  v_table regclass := to_regclass('public.sync_buckets');
  v_owner oid := (SELECT c.relowner FROM pg_catalog.pg_class AS c
                   WHERE c.oid = to_regclass('public.sync_buckets'));
  v_ok int;
BEGIN
  SELECT count(*) INTO v_ok
    FROM unnest(ARRAY[to_regprocedure('public.st_sync_head(text)'),
                      to_regprocedure('public.st_sync_pull(text)'),
                      to_regprocedure('public.st_sync_push(text, jsonb, timestamptz, boolean)')]) AS f(fn)
    JOIN pg_catalog.pg_proc AS p ON p.oid = f.fn
   WHERE p.prosecdef
     AND p.proconfig @> ARRAY['search_path=""']
     AND p.proowner = v_owner
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_table IS NULL OR v_ok <> 3
     OR (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class AS c WHERE c.oid = v_table) THEN
    RAISE EXCEPTION 'SpendTrack 005: the preconditions failed (see the first error). Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

-- 1. No direct table access for the API roles (column privileges go with it).
REVOKE ALL ON TABLE public.sync_buckets FROM PUBLIC, anon, authenticated;

-- 2. Deny-all for the API roles; the owner (and so the 004 functions) is not affected.
ALTER TABLE public.sync_buckets ENABLE ROW LEVEL SECURITY;

-- 3. No more row-change broadcasts.
DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication_tables AS pt
              WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public'
                AND pt.tablename = 'sync_buckets') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.sync_buckets;
  END IF;
END
$pub$;

ALTER TABLE public.sync_buckets REPLICA IDENTITY DEFAULT;

NOTIFY pgrst, 'reload schema';

COMMIT;
