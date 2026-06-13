-- SpendTrack sync — harden the retention helper
--
-- Run after 002_sync_indexes.sql. Idempotent: safe to re-run.
--
-- Pins an empty search_path on prune_stale_sync_buckets() to clear the Supabase
-- advisor warning 0011_function_search_path_mutable. The function already uses a
-- fully-qualified table reference (public.sync_buckets), so an empty search_path
-- is safe — this is pure hardening with no behavioural change.

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
