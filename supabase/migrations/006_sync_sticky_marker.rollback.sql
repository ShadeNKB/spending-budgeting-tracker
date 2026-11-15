-- SpendTrack sync — ROLLBACK of migration 006 (a moved marker stays moved).
--
-- docs/brain/sync-runbook.md, "Rollback". Not a migration: run it by hand only when the lead
-- asks. Safe to run again, and harmless where 006 was never applied.
--
-- Effect: st_sync_push is 004's again, its comment too, and prune_stale_sync_buckets is 003's
-- again. Owners, grants and settings stay as they are. No row is touched. A row that holds a
-- moved marker can then be written over by a forced write, and is pruned like any other row
-- (after 90 days untouched, at the default).
--
-- Run it before the 004 rollback, never after: it refuses once 004's functions are gone.

DO $pre$
DECLARE
  v_table regclass := to_regclass('public.sync_buckets');
  v_owner oid;
  v_ok int;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 006 rollback: table public.sync_buckets not found; is this the right project? Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 006 rollback: roles anon and authenticated not found; run this in the Supabase project that holds the relay. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  SELECT c.relowner INTO v_owner FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;
  IF v_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'SpendTrack 006 rollback: run this as the table owner (%); you are %. Nothing was changed.',
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
    RAISE EXCEPTION 'SpendTrack 006 rollback: the sync functions from 004 are missing or not as 004 made them. Tell the lead. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT p.proowner FROM pg_catalog.pg_proc AS p
       WHERE p.oid = to_regprocedure('public.prune_stale_sync_buckets(interval)')) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'SpendTrack 006 rollback: public.prune_stale_sync_buckets(interval) is missing or not owned by the table owner (%). Tell the lead. Nothing was changed.',
      v_owner::regrole
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

BEGIN;

SET LOCAL lock_timeout = '10s';

-- The preconditions again, inside the transaction (see 006): never create a function here.
DO $guard$
DECLARE
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
  IF v_owner IS NULL OR v_ok <> 3
     OR v_owner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user)
     OR (SELECT p.proowner FROM pg_catalog.pg_proc AS p
          WHERE p.oid = to_regprocedure('public.prune_stale_sync_buckets(interval)')) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'SpendTrack 006 rollback: the preconditions failed (see the first error). Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

-- 1. 004's st_sync_push, as 004 wrote it.
-- push: one write, decided here.
--   p_force true     overwrite an existing row; never creates     → ok | missing
--   p_base NULL      create; an existing row is a conflict         → ok | conflict | 53400 full
--   p_base a token   compare-and-set on the row's current token     → ok | conflict | missing
-- Answers {ok:true, updated_at} or {ok:false, reason:'conflict'|'missing', updated_at}. Refuses
-- (22023) a bad id, a non-object payload, more than 1,258,291 bytes of jsonb text (the app's
-- RPC_PAYLOAD_MAX), or a shape other than v5 plaintext, a private envelope or a moved marker.
-- A new token is later than both the clock and the row's current token, so tokens never repeat
-- or go back, whatever a device's clock wrote before; a token that is not a usable time
-- (infinity, past year 9999) is replaced by the clock.
CREATE OR REPLACE FUNCTION public.st_sync_push(
  p_row text,
  p_payload jsonb,
  p_base timestamptz DEFAULT NULL,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_cur timestamptz;
  v_new timestamptz;
BEGIN
  IF p_row IS NULL OR p_row !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid row id' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid payload' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.octet_length(p_payload::text) > 1258291 THEN
    RAISE EXCEPTION 'payload too large' USING ERRCODE = '22023';
  END IF;
  -- IS NOT TRUE, never NOT: a missing key makes a test NULL, and NOT NULL would let it through.
  IF (
       -- v5 plaintext
       (pg_catalog.jsonb_typeof(p_payload -> 'expenses') = 'array'
        AND pg_catalog.jsonb_typeof(p_payload -> 'x5') = 'object')
       -- private envelope
    OR ((p_payload -> 'st') = '5'::jsonb
        AND pg_catalog.jsonb_typeof(p_payload -> 'iv') = 'string'
        AND pg_catalog.jsonb_typeof(p_payload -> 'ct') = 'string')
       -- moved marker
    OR ((p_payload -> 'expenses') = '"moved"'::jsonb
        AND pg_catalog.jsonb_typeof(p_payload -> 'x5') = 'object')
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid payload shape' USING ERRCODE = '22023';
  END IF;

  IF p_base IS NULL AND NOT coalesce(p_force, false) THEN
    -- Create. An existing row is a conflict, even when the relay is full.
    SELECT b.updated_at INTO v_cur FROM public.sync_buckets AS b WHERE b.sync_id = p_row;
    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur);
    END IF;
    -- One create at a time (a fixed key used only here), so a burst cannot overrun the caps.
    PERFORM pg_catalog.pg_advisory_xact_lock(7300400401);
    -- A created_at in the future (anon can write the column until 005) never counts, so it
    -- cannot hold the hourly cap full.
    IF (SELECT pg_catalog.count(*) FROM public.sync_buckets AS b
         WHERE b.created_at > pg_catalog.now() - interval '1 hour'
           AND b.created_at <= pg_catalog.clock_timestamp()) >= 20
       OR (SELECT pg_catalog.count(*) FROM public.sync_buckets) >= 500 THEN
      -- The same row may have been created while this call waited for the lock.
      SELECT b.updated_at INTO v_cur FROM public.sync_buckets AS b WHERE b.sync_id = p_row;
      IF FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur);
      END IF;
      RAISE EXCEPTION 'relay is full' USING ERRCODE = '53400';
    END IF;
    INSERT INTO public.sync_buckets AS b (sync_id, payload, updated_at)
    VALUES (p_row, p_payload, pg_catalog.clock_timestamp())
    ON CONFLICT (sync_id) DO NOTHING
    RETURNING b.updated_at INTO v_new;
    IF NOT FOUND THEN
      SELECT b.updated_at INTO v_cur FROM public.sync_buckets AS b WHERE b.sync_id = p_row;
      RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur);
    END IF;
    RETURN pg_catalog.jsonb_build_object('ok', true, 'updated_at', v_new);
  END IF;

  -- Force or compare-and-set: lock the row, so the token is read and moved on in one step.
  SELECT b.updated_at INTO v_cur FROM public.sync_buckets AS b WHERE b.sync_id = p_row FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'missing', 'updated_at', NULL::timestamptz);
  END IF;
  -- Any other token is a conflict, a later one too: an older build's upsert can move it back.
  IF NOT coalesce(p_force, false) AND v_cur IS DISTINCT FROM p_base THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur);
  END IF;
  -- The token read above is matched again: without the row lock, this alone would still keep two
  -- crossing writes from both landing (READ COMMITTED re-checks it on the newest row).
  UPDATE public.sync_buckets AS b
     SET payload = p_payload,
         updated_at = GREATEST(
           pg_catalog.clock_timestamp(),
           CASE WHEN pg_catalog.isfinite(v_cur) AND v_cur < '9999-12-31 00:00:00+00'::timestamptz
                THEN v_cur + interval '1 microsecond' END)
   WHERE b.sync_id = p_row
     AND b.updated_at IS NOT DISTINCT FROM v_cur
  RETURNING b.updated_at INTO v_new;
  IF NOT FOUND THEN
    SELECT b.updated_at INTO v_cur FROM public.sync_buckets AS b WHERE b.sync_id = p_row;
    RETURN pg_catalog.jsonb_build_object('ok', false, 'reason', 'conflict', 'updated_at', v_cur);
  END IF;
  RETURN pg_catalog.jsonb_build_object('ok', true, 'updated_at', v_new);
END
$fn$;

COMMENT ON FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) IS
  'SpendTrack 004: create, compare-and-set or force one row; validates id, size and shape; caps creation at 20 an hour and 500 rows.';

-- 2. 003's prune, as 003 wrote it.
CREATE OR REPLACE FUNCTION public.prune_stale_sync_buckets(stale_after INTERVAL DEFAULT INTERVAL '90 days')
RETURNS BIGINT
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  removed BIGINT;
BEGIN
  DELETE FROM public.sync_buckets
   WHERE updated_at < NOW() - stale_after;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
