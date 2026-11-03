-- SpendTrack sync — ROLLBACK of migration 004 (the sync functions and the write guards).
--
-- docs/brain/sync-runbook.md, "Rollback". Not a migration: run it by hand only when the lead
-- asks. Safe to run again.
--
-- Effect: the app on VITE_SYNC_RELAY=auto gets PGRST202 (function not found) on its next sync,
-- checks again and goes back to the table in the same cycle. Builds without the flag never
-- used the functions. No row is touched.
--
-- Refused while 005 (the lockdown) is applied: with table access gone AND the functions gone,
-- no device could sync. Roll back 005 first.
--
-- Deliberately NOT restored: DELETE, TRUNCATE, REFERENCES, TRIGGER and prune for anon and
-- authenticated. No app version ever needed them; granting them again would reopen F-068.

DO $pre$
DECLARE
  v_table regclass := to_regclass('public.sync_buckets');
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 004 rollback: table public.sync_buckets not found; is this the right project? Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF to_regrole('anon') IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 004 rollback: role anon not found; run this in the Supabase project that holds the relay. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT c.relrowsecurity FROM pg_catalog.pg_class AS c WHERE c.oid = v_table)
     OR NOT has_table_privilege('anon', v_table, 'SELECT') THEN
    RAISE EXCEPTION 'SpendTrack 004 rollback: the lockdown (005) is applied. Roll back 005 first (005_sync_lockdown.rollback.sql), or keep 004. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = v_table)
     IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'SpendTrack 004 rollback: run this as the table owner (%); you are %. Nothing was changed.',
      (SELECT c.relowner::regrole FROM pg_catalog.pg_class AS c WHERE c.oid = v_table), current_user
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

BEGIN;

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.st_sync_push(text, jsonb, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.st_sync_pull(text);
DROP FUNCTION IF EXISTS public.st_sync_head(text);

ALTER TABLE public.sync_buckets DROP CONSTRAINT IF EXISTS sync_buckets_id_uuid;
ALTER TABLE public.sync_buckets DROP CONSTRAINT IF EXISTS sync_buckets_payload_bounded;
ALTER TABLE public.sync_buckets DROP CONSTRAINT IF EXISTS sync_buckets_updated_at_finite;

DROP INDEX IF EXISTS public.sync_buckets_created_at_idx;

NOTIFY pgrst, 'reload schema';

COMMIT;
