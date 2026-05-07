-- SpendTrack sync — operational indexes & retention helpers
--
-- Run this in the Supabase SQL Editor *after* 001_sync.sql.
-- Idempotent: safe to re-run.
--
-- What this adds:
--   1. Index on `updated_at` for fast retention queries.
--   2. A `created_at` column for telemetry / debugging.
--   3. An optional retention helper that prunes rows untouched for 90 days.

BEGIN;

-- 1. Add `created_at` (stamps when the sync bucket was first created).
ALTER TABLE public.sync_buckets
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2. Index `updated_at` so retention sweeps and admin queries don't full-scan.
CREATE INDEX IF NOT EXISTS sync_buckets_updated_at_idx
  ON public.sync_buckets (updated_at DESC);

-- 3. Retention helper.
--    Sync codes that haven't been touched in 90 days are almost certainly
--    abandoned (lost device, regenerated code, etc.). Prune them so the
--    relay table stays cheap.
--
--    Run manually when desired:
--      SELECT public.prune_stale_sync_buckets(INTERVAL '90 days');
CREATE OR REPLACE FUNCTION public.prune_stale_sync_buckets(stale_after INTERVAL DEFAULT INTERVAL '90 days')
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  removed BIGINT;
BEGIN
  DELETE FROM public.sync_buckets
   WHERE updated_at < NOW() - stale_after
  RETURNING 1 INTO removed;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

COMMIT;
