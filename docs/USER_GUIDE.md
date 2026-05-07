# SpendTrack User Guide

SpendTrack is built for quick, private spending logs. The goal is to make daily tracking easy enough that it becomes a habit.

## Quick Entry

Use the top input to add expenses in natural language:

```text
coffee 4.50
grab 12 yesterday
netflix 15 monthly
lunch 8.90 2026-05-01
```

The parser detects:

- item name
- amount
- date hints such as `yesterday`
- recurring hints such as `monthly`
- category suggestions learned from previous entries

## Daily Workflow

1. Add expenses as they happen.
2. Use Pulse to check current month pace.
3. Use Ledger to search, filter, edit, or delete entries.
4. Use Insights to spot recurring charges and spending changes.
5. Export a JSON backup regularly if the data matters to you.

## Cross-device sync

Sync is **opt-in** and runs against your own Supabase project. There are no accounts and no passwords — a UUID sync code acts as the shared secret between your devices.

To set it up once:

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase SQL Editor, run `supabase/migrations/001_sync.sql` (and optionally `002_sync_indexes.sql` for retention helpers).
3. Copy your project URL and anon public key into `.env.local` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Open Settings → **Sync** in the app and tap **Generate sync code**. Paste the same code into Settings → Sync on every other device.

How it works:

- localStorage stays the source of truth — the cloud is a stateless relay.
- Each expense merges by **last-write-wins** using its `updatedAt` (or `createdAt`) timestamp.
- A tombstone set propagates deletions across devices, so a deleted expense never resurrects on another device.
- Local edits push 3 seconds after your last change. Remote edits arrive instantly via Supabase Realtime.
- If a push fails, retries back off exponentially (1.5 s × 2ⁿ, capped at 2 minutes) until you're online again.

If you'd rather not run a Supabase project, JSON export/import works the same way it always did.

## Backups

SpendTrack stores data in browser `localStorage`. This keeps the app private and fast, but browser storage is still local storage.

Export a JSON backup before:

- clearing browser data
- switching browsers
- changing devices (if you don't have sync configured)
- reinstalling the app
- testing with real spending records

Use CSV export when you want to analyse records in Excel, Google Sheets, or another finance tool.

If browser storage is full, SpendTrack will surface a toast prompting you to export and clear data before continuing — it never silently fails to persist.

## Privacy Model

SpendTrack has no built-in backend and no account system. Your spending data stays in your browser by default. If you opt into cross-device sync, the only place data leaves your device is your own Supabase project — which you own and control.

That means:

- no third-party analytics, no telemetry
- no cloud recovery unless you set up sync (or export your own backups)
- the UUID sync code is your only credential — treat it like a password

## Current Limits

SpendTrack is intentionally focused. It does not currently support:

- bank imports
- shared budgets
- investment tracking
- account-based recovery (use sync or JSON exports instead)

Those are valid future directions, but the current product is optimised for fast personal tracking.
