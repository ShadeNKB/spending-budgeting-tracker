-- SpendTrack cross-device sync relay
--
-- Run this once in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- No auth, no RLS. The sync_id UUID acts as the shared secret between devices.
-- A 122-bit UUID has enough entropy to be safely treated as a secret.

CREATE TABLE IF NOT EXISTS public.sync_buckets (
  sync_id  TEXT        PRIMARY KEY,
  payload  JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Allow the realtime extension to track changes on this table.
ALTER TABLE public.sync_buckets REPLICA IDENTITY FULL;

-- Grant anon access (required for the Supabase anon key to read/write).
GRANT SELECT, INSERT, UPDATE ON public.sync_buckets TO anon;
GRANT SELECT, INSERT, UPDATE ON public.sync_buckets TO authenticated;
