-- SpendTrack sync — ROLLBACK of migration 005 (the lockdown).
--
-- docs/brain/sync-runbook.md, "Rollback". Not a migration: run it by hand only when the lead
-- asks. Safe to run again.
--
-- WARNING: this REOPENS F-006. Anyone holding the public anon key can list, read and write rows
-- through the table again. Only for reviving a device that cannot update; every device on
-- 0.11.0 keeps syncing through the 004 functions either way. No row is touched.
--
-- Afterwards the database is exactly as it was after 004: SELECT, INSERT and UPDATE for anon
-- and authenticated, row level security off, the table in supabase_realtime again, replica
-- identity full.

DO $pre$
DECLARE
  v_table regclass := to_regclass('public.sync_buckets');
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 005 rollback: table public.sync_buckets not found; is this the right project? Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 005 rollback: roles anon and authenticated not found; run this in the Supabase project that holds the relay. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = v_table)
     IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'SpendTrack 005 rollback: run this as the table owner (%); you are %. Nothing was changed.',
      (SELECT c.relowner::regrole FROM pg_catalog.pg_class AS c WHERE c.oid = v_table), current_user
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

BEGIN;

SET LOCAL lock_timeout = '10s';

GRANT SELECT, INSERT, UPDATE ON TABLE public.sync_buckets TO anon, authenticated;

ALTER TABLE public.sync_buckets DISABLE ROW LEVEL SECURITY;

ALTER TABLE public.sync_buckets REPLICA IDENTITY FULL;

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication AS p WHERE p.pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication_tables AS pt
                      WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public'
                        AND pt.tablename = 'sync_buckets') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sync_buckets;
  END IF;
END
$pub$;

NOTIFY pgrst, 'reload schema';

COMMIT;
