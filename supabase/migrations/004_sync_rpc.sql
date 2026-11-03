-- SpendTrack sync — migration 004: the relay's own sync functions, and the F-068 fixes.
--
-- Gate C of docs/brain/sync-runbook.md. Run 000_preflight_readonly.sql first; run
-- checks/004_verify.sql after. Undo: 004_sync_rpc.rollback.sql.
--
-- How: Supabase → SQL Editor → New query → paste this whole file → Run, as the table owner
-- (postgres). Expected: "Success. No rows returned". Safe to run again: a second run changes
-- nothing.
--
-- What it does. Additive: no row is read for change, rewritten or deleted.
--   1. Takes away what the public anon key never needed (F-068): DELETE, TRUNCATE, REFERENCES,
--      TRIGGER (and MAINTAIN on Postgres 17+) on public.sync_buckets, and running
--      prune_stale_sync_buckets. SELECT, INSERT and UPDATE stay, so every app version up to
--      0.11.0 keeps syncing over the table until 005.
--   2. Guards new writes with three NOT VALID checks: existing rows are never scanned, so junk
--      written before cannot make this fail. A NOT VALID check still applies to an UPDATE of an
--      old row: an old row with a non-UUID id can no longer be updated (the preflight stops
--      when such a row was written in the last 30 days).
--   3. An index on created_at, for the creation caps. Plain (not CONCURRENTLY: that cannot run
--      in a transaction); the relay holds a few hundred rows at most (the 500-row cap).
--   4. Three functions the app calls instead of the table once VITE_SYNC_RELAY=auto is set:
--      st_sync_head, st_sync_pull and st_sync_push (compare-and-set, size and shape checks,
--      creation caps). SECURITY DEFINER with an empty search_path, owned by the table owner,
--      executable by anon and authenticated only.
--
-- If it stops with an ERROR: nothing was applied. Run `ROLLBACK;` once in a new query (harmless
-- when nothing is open), then read the message: each SpendTrack 004 message says what to do.

-- Preconditions, before BEGIN: a refusal here leaves no transaction open.
DO $pre$
DECLARE
  v_table regclass := to_regclass('public.sync_buckets');
  v_owner oid;
  v_me oid := (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user);
  v_prune regprocedure := to_regprocedure('public.prune_stale_sync_buckets(interval)');
  v_odd text;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 004: table public.sync_buckets not found. Run 001_sync.sql first. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = v_table AND a.attname = 'created_at' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'SpendTrack 004: column public.sync_buckets.created_at not found. Run 002_sync_indexes.sql and 003_harden_prune_search_path.sql first. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  IF to_regrole('anon') IS NULL OR to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'SpendTrack 004: roles anon and authenticated not found; run this in the Supabase project that holds the relay. Nothing was changed.'
      USING ERRCODE = '55000';
  END IF;
  SELECT c.relowner INTO v_owner FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;
  -- SECURITY DEFINER functions belong to whoever creates them; they must belong to the table
  -- owner, so they keep working under 005's row level security.
  IF v_owner IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'SpendTrack 004: run this as the table owner (%); you are %. Nothing was changed.',
      v_owner::regrole, current_user
      USING ERRCODE = '55000';
  END IF;
  IF v_prune IS NOT NULL
     AND (SELECT p.proowner FROM pg_catalog.pg_proc AS p WHERE p.oid = v_prune) IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'SpendTrack 004: public.prune_stale_sync_buckets(interval) is not owned by the table owner (%). Tell the lead. Nothing was changed.',
      v_owner::regrole
      USING ERRCODE = '55000';
  END IF;
  -- Another st_sync_* function (an older draft, another owner) would be an overload PostgREST
  -- cannot choose between, or one this file may not replace.
  SELECT string_agg(f.sig || ' owned by ' || f.owner, ', ' ORDER BY f.sig)
    INTO v_odd
    FROM (SELECT p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS sig,
                 p.proowner::regrole::text AS owner, p.proowner
            FROM pg_catalog.pg_proc AS p
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('st_sync_head', 'st_sync_pull', 'st_sync_push')) AS f
   WHERE f.proowner <> v_owner
      OR f.sig NOT IN ('st_sync_head(text)', 'st_sync_pull(text)',
                       'st_sync_push(text, jsonb, timestamp with time zone, boolean)');
  IF v_odd IS NOT NULL THEN
    RAISE EXCEPTION 'SpendTrack 004: unexpected sync functions already exist: %. Tell the lead. Nothing was changed.', v_odd
      USING ERRCODE = '55000';
  END IF;
END
$pre$;

BEGIN;

-- Fail fast instead of making every device's request queue behind this file's brief locks.
SET LOCAL lock_timeout = '10s';

-- 1. F-068: what anon and authenticated never needed. service_role is left as it is.
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.sync_buckets FROM PUBLIC, anon, authenticated;

DO $revoke$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE public.sync_buckets FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.prune_stale_sync_buckets(interval)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.prune_stale_sync_buckets(interval) FROM PUBLIC, anon, authenticated;
  END IF;
END
$revoke$;

-- 2. Guards on new writes (NOT VALID: no existing row is read or rejected). Each is added only
--    when absent, so a second run is a no-op.
DO $guards$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k
                  WHERE k.conrelid = 'public.sync_buckets'::regclass AND k.conname = 'sync_buckets_id_uuid') THEN
    ALTER TABLE public.sync_buckets ADD CONSTRAINT sync_buckets_id_uuid
      CHECK (sync_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k
                  WHERE k.conrelid = 'public.sync_buckets'::regclass AND k.conname = 'sync_buckets_payload_bounded') THEN
    ALTER TABLE public.sync_buckets ADD CONSTRAINT sync_buckets_payload_bounded
      CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 2097152) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k
                  WHERE k.conrelid = 'public.sync_buckets'::regclass AND k.conname = 'sync_buckets_updated_at_finite') THEN
    ALTER TABLE public.sync_buckets ADD CONSTRAINT sync_buckets_updated_at_finite
      CHECK (isfinite(updated_at)) NOT VALID;
  END IF;
END
$guards$;

COMMENT ON CONSTRAINT sync_buckets_id_uuid ON public.sync_buckets IS
  'SpendTrack 004: a sync code is a lower-case UUID. NOT VALID: checks new writes only.';
COMMENT ON CONSTRAINT sync_buckets_payload_bounded ON public.sync_buckets IS
  'SpendTrack 004: a payload is a JSON object of at most 2 MiB of jsonb text. NOT VALID: checks new writes only.';
COMMENT ON CONSTRAINT sync_buckets_updated_at_finite ON public.sync_buckets IS
  'SpendTrack 004: the concurrency token is a real time, never infinity. NOT VALID: checks new writes only.';

-- 3. For the creation caps (rows created in the last hour). Small table: plain, in this transaction.
CREATE INDEX IF NOT EXISTS sync_buckets_created_at_idx ON public.sync_buckets (created_at DESC);

-- 4. The sync functions. Every name is schema-qualified (search_path is empty); an id that is
--    not a lower-case UUID is never a row, so head and pull answer NULL for it.

-- head: the row's concurrency token (its updated_at), or NULL when there is no such row.
CREATE OR REPLACE FUNCTION public.st_sync_head(p_row text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT b.updated_at
    FROM public.sync_buckets AS b
   WHERE p_row ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND b.sync_id = p_row
$fn$;

-- pull: {payload, updated_at, now}, or NULL when there is no such row.
CREATE OR REPLACE FUNCTION public.st_sync_pull(p_row text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT pg_catalog.jsonb_build_object('payload', b.payload, 'updated_at', b.updated_at, 'now', pg_catalog.now())
    FROM public.sync_buckets AS b
   WHERE p_row ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND b.sync_id = p_row
$fn$;

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
    IF (SELECT pg_catalog.count(*) FROM public.sync_buckets AS b
         WHERE b.created_at > pg_catalog.now() - interval '1 hour') >= 20
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

COMMENT ON FUNCTION public.st_sync_head(text) IS
  'SpendTrack 004: the row''s concurrency token, or NULL. Called by the app (VITE_SYNC_RELAY=auto).';
COMMENT ON FUNCTION public.st_sync_pull(text) IS
  'SpendTrack 004: {payload, updated_at, now} of the row, or NULL. Called by the app.';
COMMENT ON FUNCTION public.st_sync_push(text, jsonb, timestamptz, boolean) IS
  'SpendTrack 004: create, compare-and-set or force one row; validates id, size and shape; caps creation at 20 an hour and 500 rows.';

-- Only the app's roles may call them (re-asserted on every run; service_role keeps the grant
-- Supabase's default privileges gave it).
REVOKE ALL ON FUNCTION public.st_sync_head(text), public.st_sync_pull(text),
                       public.st_sync_push(text, jsonb, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.st_sync_head(text), public.st_sync_pull(text),
                          public.st_sync_push(text, jsonb, timestamptz, boolean)
  TO anon, authenticated;

-- Tell the API about the new functions now (PostgREST would otherwise see them within minutes).
NOTIFY pgrst, 'reload schema';

COMMIT;
