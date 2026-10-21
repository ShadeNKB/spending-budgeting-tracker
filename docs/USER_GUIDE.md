# SpendTrack User Guide

SpendTrack is built for quick, private spending logs. The goal is to make daily tracking easy enough that it becomes a habit.

## Quick Entry

Type an expense into the quick-add bar and press Enter (or tap **Add**). The command palette (Ctrl+K) takes the same text.

```text
coffee 4.50
chicken rice S$5
grab 12 yesterday
junction 8 dinner 15
mala 2 pax 18
lunch 8.5 food
bubble tea 6.5 sat
nye dinner 31 dec 85
haircut 15 3/10
netflix 15.98 monthly
```

Pills under the bar show what will be saved (name, amount, category, date) before you add it.

**Amount**

- `4.50`, `.80`, `$4.50`, `S$5`, `5 sgd`, `1,200`, `12,500.50`, and `12,50` (decimal comma). At most two decimals: `12.555` is not an amount.
- `$`, `S$` and `SGD` only mark the amount. It is recorded in the currency chosen in Settings. A separate mark belongs to one number: `$`/`S$` to the number after it, `SGD` to the number before it (or after it when it comes first), so `dinner 45 sgd 2 pax` is 45 and `lunch 12.50 sgd 3 oct` is 12.50 on 3 October.
- With several numbers, the one marked with `$`/`S$`/`SGD` wins, then the one with decimals, then the last one: `2 kopi 3.40` is 3.40, `grab 18 junction 8` is 18.
- Counts are never the amount: `2 pax`, `2 pc`, `2 sets`, `x2`, `2 x`.
- Numbers that belong to a place stay in the name: `blk 123`, `bus 190`, `level 3`, `gate 5`, `stall 12`, `ave 3`, `Junction 8`, `Junction 10`, `Tampines 1`. A number with decimals is still an amount (`bus 190 1.80` is 1.80).
- A count or a place number is never guessed to be the amount, even when it is the only number: `bus 2` and `kopi 2 cups` wait for an amount (the pill says so). For a S$2 fare type `bus $2` or `bus 2.00`.
- An amount far above your usual spending (roughly ten times a typical entry, judged from your last 200; 10,000 or more until you have 10 entries) asks for a second, separate press: the amount pill turns amber and **Add** becomes **Confirm**. Amounts over 10,000,000 cannot be added.

**Date** (optional; without one the entry is for today)

- `today`, `yesterday` or `yday`, `3 days ago`, `last week` (7 days ago).
- A weekday: `saturday` or `sat` means the latest one on or before today; `last fri` means the latest one before today. A weekday counts after `on` (`lunch on monday 12`) or as the last word (a category word or `monthly` after it is fine), and never as the only word, so `sun plaza dinner 12` and `Sunday Folks 8` stay names.
- A day and month: `31 dec`, `Dec 31`, `1st oct`, `Oct. 2`. It resolves to the latest such day on or before today, looking back at most a year, so `31 dec` typed on 2 January is last year. A day in the coming month (`oct 20` typed on 18 October) is a plan or a typo, not last year: it stays in the name and the entry is for today, as does `29 feb` when the last year had none. When the entry is not for today, the date pill is highlighted, and it shows the year when that is not this year.
- With the year: `18 oct 2026`, `Oct 18, 2026`, `2026-05-01`, or day first: `3/10`, `3/10/26`, `3/10/2026`, `25/12 2026`. A year after a month is never the amount: `taxi 15 18 oct 2026` is 15, and `spotify dec 2025` has no amount.
- A date is never in the future: a future `2026-12-01`, `25/12/2027` or `18 oct 2027` stays in the name.
- A date never uses up your only number: `dec 25` is "dec" for 25, and `march 12` is "march" for 12. Month and weekday names only count as whole words, so Marina, Novena, Marine Parade, Decathlon, Sephora and Maybank are names.

**Category**

- A category word after the amount sets the category: one of your category names (`shopping`, `gaming`), the first word of one (`food` for Food & Dining, `social` for Social & Leisure), or `transport`, `health`, `subs`, `invest`, `groceries`. The name must keep at least one other word (`food 8` is an item called "food").
- Otherwise SpendTrack suggests the category learned from earlier entries with the same or a similar name.

**Name**

- Everything else, as typed. `monthly`, `weekly` and `yearly` at the end are dropped from the name; they do not set up a recurring charge yet.

Quick adds are stored at midday of their day, the same as the full entry form.

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
2. In the Supabase SQL Editor, run `supabase/migrations/001_sync.sql` (and optionally `002_sync_indexes.sql` for retention helpers). The helper only creates a manual pruning function; schedule it yourself if you want automatic 90-day cleanup.
3. Copy your project URL and anon public key into `.env.local` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Open Settings → **Sync** in the app and tap **Generate sync code**. Paste the same code into Settings → Sync on every other device.

**About the sync code:**

- Treat it like a password — anyone with it can read and write your synced data. Don't share it in chats or screenshots.
- Pair as many devices as you like with the same code (phone + laptop + tablet + work browser, etc.). Expenses and budgets merge with last-write-wins metadata.
- If you ever lose the code, just generate a new one. The old bucket stays in Supabase for 90 days then auto-prunes if `prune_stale_sync_buckets()` is scheduled.
- This no-account relay is designed for a personal Supabase project. It uses broad anon table access, so it is not a hardened multi-user SaaS security model.

How it works:

- localStorage stays the source of truth — the cloud is a stateless relay.
- Each expense merges by **last-write-wins** using its `updatedAt` (or `createdAt`) timestamp.
- Each budget category merges by set/delete timestamps, so stale tabs cannot revert newer budget changes.
- Tombstone sets propagate deletions across devices, so deleted expenses and removed budgets do not resurrect.
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

|                          |                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **localStorage cap**     | ~5–10 MB per browser (varies by device). SpendTrack alerts you with a toast if storage is full and stops silently — never silent data loss.                                  |
| **Sync device count**    | Unbounded — pair any number of devices with the same code; expenses and budgets merge via last-write-wins metadata.                                                          |
| **Sync payload size**    | Soft warning at 800 KB, hard reject at 1 MB (Supabase row limit). Tombstone array auto-caps at 1000 entries.                                                                 |
| **Tested expense count** | Up to ~5000 entries renders smoothly. Beyond that, Ledger may benefit from virtualised scrolling — not yet implemented.                                                      |
| **Time zones**           | Entries are kept at midday local time; every screen groups by the device's calendar day. A device set over 12 hours away from where an entry was made can show it a day off. |

## What SpendTrack doesn't do

It is intentionally focused. The following are **not** supported:

- Bank/card imports — manual entry only
- Shared / household budgets — single-user
- Investment portfolio tracking
- Account-based recovery (use sync or JSON export instead)
- Multiple currencies in one ledger — all expenses in one base currency

These are valid future directions; the current product is optimised for fast, private personal tracking.
