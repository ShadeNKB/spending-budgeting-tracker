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

> **Sync is optional.** Skip this section if you only use one device. You'll never need an account or a password — your data stays local until you opt in.
>
> If you do want phone ↔ laptop sync, **plan for ~5 minutes of one-time Supabase setup.** After that, every additional device is just a paste-the-code step.

There are no accounts and no passwords — a UUID sync code acts as the shared secret between your devices.

**One-time setup (per Supabase project):**

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase SQL Editor, run `supabase/migrations/001_sync.sql` (and optionally `002_sync_indexes.sql` for retention helpers).
3. Copy your project URL and anon public key into `.env.local` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Open Settings → **Sync** in the app and tap **Generate sync code**. Paste the same code into Settings → Sync on every other device.

**About the sync code:**

- Treat it like a password — anyone with it can read and write your synced data. Don't share it in chats or screenshots.
- Pair as many devices as you like with the same code (phone + laptop + tablet + work browser, etc.). All merge via per-expense last-write-wins.
- If you ever lose the code, just generate a new one. The old bucket stays in Supabase for 90 days then auto-prunes if `prune_stale_sync_buckets()` is scheduled.

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

## Operational limits

| | |
|---|---|
| **localStorage cap** | ~5–10 MB per browser (varies by device). SpendTrack alerts you with a toast if storage is full and stops silently — never silent data loss. |
| **Sync device count** | Unbounded — pair any number of devices with the same code; all merge via last-write-wins. |
| **Sync payload size** | Soft warning at 800 KB, hard reject at 1 MB (Supabase row limit). Tombstone array auto-caps at 1000 entries. |
| **Tested expense count** | Up to ~5000 entries renders smoothly. Beyond that, Ledger may benefit from virtualised scrolling — not yet implemented. |
| **Time zones** | Dates are stored at noon UTC for the display date, which keeps grouping stable across most timezones but may shift by a day for users in extreme zones with DST transitions. |

## What SpendTrack doesn't do

It is intentionally focused. The following are **not** supported:

- Bank/card imports — manual entry only
- Shared / household budgets — single-user
- Investment portfolio tracking
- Account-based recovery (use sync or JSON export instead)
- Multiple currencies in one ledger — all expenses in one base currency

These are valid future directions; the current product is optimised for fast, private personal tracking.
