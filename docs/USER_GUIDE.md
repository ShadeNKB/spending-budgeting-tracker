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

Every entry is stored with the calendar day it is for (and that day at midday local time), the same from quick add and the full entry form, so it stays on that day in every time zone.

## Daily Workflow

1. Add expenses as they happen.
2. Use Pulse to check current month pace.
3. Use Ledger to search, filter, edit, or delete entries.
4. Use Insights to spot recurring charges and spending changes.
5. Download a JSON backup regularly if the data matters to you (Settings → **Backup** shows when you last did).

## Categories and budgets

Settings → **Categories**: add a category, rename one by typing over its name, or delete one. Deleting a category moves its entries to **Other** and removes its budget; **Undo** on the toast brings both back. Other is where those entries go, so it can't be renamed or deleted. A name SpendTrack can't use (longer than 60 characters, or reserved such as `constructor`) is refused with the reason, and nothing changes.

Settings → **Budgets**: a monthly cap per category, more than 0 and at most 10,000,000. Empty the field to remove a budget.

## Cross-device sync

> **Sync is optional.** Skip this section if you only use one device. There's no account and no password, and nothing leaves the device until you link one.
>
> If you do want phone ↔ laptop sync, **plan for ~5 minutes of one-time Supabase setup.** After that, every additional device is a join-the-code step.

A sync code links your devices: there's no account. The synced copy on the relay isn't encrypted yet, so anyone with this app's public key could read it; the code itself is what lets a device change it. Share it only with your own devices.

**One-time setup (per Supabase project):**

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase SQL Editor, run `supabase/migrations/001_sync.sql` (and optionally `002_sync_indexes.sql` for retention helpers). The helper only creates a manual pruning function; schedule it yourself if you want automatic 90-day cleanup.
3. Copy your project URL and anon public key into `.env.local` as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Open Settings → **Sync** in the app and tap **Generate sync code for this device**. On every other device, paste the code under **or join an existing one** and tap **Join**.

**Linking a device:**

- **Generate** makes a new code here. Use it once, on the first device.
- **Join** checks the code before anything goes on the network (a typo or a private code says so at once), then reads the synced copy and shows what joining does: "This device: 12 entries · Synced: 641 entries · After joining: about 653 entries." Nothing is saved until you tap **Join** again; **Cancel** changes nothing. A code with no synced copy says "No synced data found for this code" and creates nothing, so a mistyped code can never start a second, empty sync.
- In the demo, both first ask whether to remove the sample data; sample entries never sync either way.
- **Disconnect** stops syncing on this device only. Your data stays here, on your other devices and in the relay. For 30 days the device remembers the code and offers **Reconnect**; **Generate** then asks "Start a separate sync?" first, because your other devices would stay on the old code.

**The sync code:**

- It's masked (`••••-…-1a2b`). **Show** reveals it until you tap **Hide**, for 30 seconds at most, and it hides again when you leave the app or close Settings. **Copy** always copies the full code, to paste on your other device.
- Pair as many devices as you like with the same code (phone + laptop + tablet + work browser, etc.). Changes from every device are merged; nothing is overwritten wholesale.
- If you ever lose the code, copy it from another linked device (Settings → Sync). Generating a new one starts a separate sync; the old bucket stays in Supabase until `prune_stale_sync_buckets()` removes it (90 days, if you scheduled it).
- This no-account relay is designed for a personal Supabase project. It uses broad anon table access, so it is not a hardened multi-user SaaS security model.

**What Settings → Sync shows:**

- the status (**Synced · 2m ago**, **Saved here · 3 to sync**, **Can't reach the sync server · retry in 30 s**, **Sync paused**) with **Sync now**;
- **Devices**: every device on this sync, **This device** first, then each **Other device**, with its SpendTrack version and when it last synced. A device on an older SpendTrack says "update it" (0.10.0 and 0.9.2 don't report themselves, so they show as "Older SpendTrack (0.10.0)"); one not seen for 60 days is greyed. When every other device runs this version it says so ("All your devices run SpendTrack 0.11.0."), which is the sign it's safe to rely on the newest sync features;
- in one line, whether live updates are on, or unavailable (then it syncs when you open the app and every minute);
- a banner when a device on SpendTrack 0.10.0, 0.9.2 or 0.8.4 wrote the synced copy in the last day, and how full the relay row is from 70 % ("Sync uses 82 % of the relay limit"). At 100 % sync pauses; your data stays on this device and merges keep coming in.

On a laptop (1280 px and wider) the pill in the top bar says the same in short: **Synced · 2m ago**, **3 to sync**, **Offline · 3 to sync**, **Sync retrying · 30 s**, **Sync paused · code not found**. When it reports a problem, it is a button that opens Settings → Sync.

How it works:

- Each device keeps its own full copy — the cloud is a relay between them.
- Each field of an entry (name, amount, category, date, notes) merges on its own, newest change wins, so an amount edited on the phone and a category changed on the laptop both survive.
- Budgets, item categories, category renames and the currency merge the same way, so a stale device cannot revert a newer change. The currency you pick applies on every synced device.
- Deletions travel as dated markers, so a deleted entry never comes back, and an Undo (or a restore from a backup) brings it back everywhere.
- Your changes go out 1.5 seconds after you stop (5 seconds at most while you keep typing), and at once when you leave the app. Other devices' changes arrive within seconds through Supabase Realtime while the app is open; if live updates are blocked, the app checks every minute and whenever you come back to it (a check that finds nothing new downloads nothing). Changes made offline are kept and sent when you are back.
- If a push fails, retries back off (2, 4, 8, 16, 32, then 60 seconds, a little randomised), pause while the app is in the background or offline, and start again at once when you come back. The pill says **Synced** only when every change has reached the relay.
- If your other device removes a lot of entries at once (10 or more, and 50 or more or a tenth of everything), this device keeps a copy first and says "Your other device removed N entries" with **Undo** for 30 seconds.
- Devices still on 0.10.0 or 0.9.2 keep syncing with this version. Update every device when you can: the devices list tells you which one is behind.
- A sync set up by a newer SpendTrack (after going back to an older version) is left untouched: Settings → Sync asks you to reload, and offers only **Disconnect**.

If you'd rather not run a Supabase project, a JSON backup moves your data between devices: download it on one, import it on the other.

## Backups

SpendTrack keeps your data in this browser's storage, in one safety-checked copy written the moment you add or change anything (nothing waits to be saved when you switch apps). Before every big change (delete all, an import, a large removal from another device) it keeps a snapshot on the device, and it keeps a second copy in the format of 0.9.x, so going back to an older version keeps everything too. Anything it ever finds damaged is set aside, never deleted.

Settings → **Backup** shows:

- where your data lives: only on this device, or synced through your relay (every linked device has a full copy; the relay copy isn't encrypted yet, so anyone with this app's public key could read it);
- whether the browser protects the storage from automatic cleanup, and when you last downloaded a backup;
- **Download JSON backup** and **Export to CSV** (for Excel, Google Sheets or another finance tool).

Download a JSON backup before you clear browser data, switch browsers or devices (without sync), or reinstall the app.

**Import JSON backup** shows what the file would do before anything changes: how many entries are in it, new, restored (they had been deleted), updated, already here, and any it can't read. **Restore** (the default) only adds and brings back; nothing on this device or your other devices is removed, and the next sync keeps it. **Replace instead…** makes the file the whole truth and deletes the entries that aren't in it, on every linked device; you type REPLACE to confirm. Both can be undone for 30 seconds. A backup from a newer SpendTrack is refused.

**Needs attention** appears when entries couldn't be read (from storage, a file or the relay). They're kept on the device, untouched; **Download them** saves them as they are.

Deleting:

- Without sync, **Delete all entries** removes every entry on this device. A copy is kept and you can undo for 30 seconds.
- With sync, the two actions do different things. **Delete all N entries everywhere** removes them on every linked device (type DELETE to confirm; a copy is kept here and you can undo for 30 seconds). **Remove SpendTrack from this device only** forgets this device's data and its sync code and starts fresh, while your other devices and the relay keep everything. The backup comes first, as its own tap (untick it to skip it); while changes on this device haven't synced yet, the backup is required, since nothing else keeps them.
- In the demo, **Clear sample data** removes the sample entries for good.

If storage is full, SpendTrack says "Not saved: storage is full" and keeps trying; it never claims a change was saved when it wasn't. Download a backup and free some space.

## Privacy Model

SpendTrack has no built-in backend and no account system. Your spending data stays in your browser by default. If you opt into cross-device sync, the only place data leaves your device is your own Supabase project — which you own and control.

That means:

- no third-party analytics, no telemetry
- no recovery from the relay unless you set up sync (or download your own backups)
- the synced copy isn't encrypted yet: anyone with this app's public key could read it, and anyone with your sync code can change it. Share the code only with your own devices

## Operational limits

|                          |                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **localStorage cap**     | ~5–10 MB per browser (varies by device). When it is full SpendTrack says "Not saved: storage is full" and retries — never silent data loss. |
| **Sync device count**    | Unbounded — pair any number of devices with the same code; expenses and budgets merge via last-write-wins metadata.                         |
| **Sync payload size**    | Sync pauses before a push would pass the relay's row limit (about 1 MB) and says so; your data stays saved on the device.                   |
| **Tested expense count** | Up to ~5000 entries renders smoothly; the Ledger list is virtualised.                                                                       |
| **Time zones**           | Each entry keeps the calendar day it was logged for; every screen, the CSV and backups use that day, in any time zone.                      |

## What SpendTrack doesn't do

It is intentionally focused. The following are **not** supported:

- Bank/card imports — manual entry only
- Shared / household budgets — single-user
- Investment portfolio tracking
- Account-based recovery (use sync or JSON backups instead)
- Multiple currencies in one ledger — all expenses in one base currency

These are valid future directions; the current product is optimised for fast, private personal tracking.
