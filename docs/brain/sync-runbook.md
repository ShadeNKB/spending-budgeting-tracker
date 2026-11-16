# Sync database runbook: gate C (004) and gate E (005)

For Shade, on the Windows laptop, one sitting per gate. You apply the two database steps that finish the sync overhaul yourself: **004** at gate C, then **005** at gate E, at least 7 days later. Nobody else touches the database.

**Jump to:** [Before you start](#before-you-start) · [How to run a SQL file](#how-to-run-a-sql-file) · [Gate C](#gate-c-apply-004-and-switch-the-app-over) · [Gate E](#gate-e-lock-the-table) · [006, optional](#optional-006-keep-a-moved-sync-moved) · [After the lockdown](#what-youll-see-after-the-lockdown) · [If something goes wrong](#if-something-goes-wrong) · [Rollback](#rollback) · [Later, optional](#later-optional) · [Log](#log)

## What this does

- **Today**, the app's public key (it ships inside the app, so anyone can find it) can list every synced copy, read it, overwrite it, delete it, and run the prune function that removes old rows ([F-006 and F-068](overhaul/FINDINGS.md)).
- **Gate C, migration 004**, takes delete, truncate and prune away from that key, refuses badly formed new writes, and adds three sync functions (`st_sync_head`, `st_sync_pull`, `st_sync_push`) that check every write and do compare-and-set on the server. Every SpendTrack build keeps working. Then two Vercel switches make the app use the functions (`VITE_SYNC_RELAY=auto`) and compare-and-set (`VITE_SYNC_CAS=on`).
- **Gate E, migration 005**, closes the table to the public key. Devices reach their copy only through the three functions, which need your sync code. Live updates carry on over Broadcast.

## What it can't do

- **No step deletes or rewrites your data.** The migrations change permissions, add checks for new writes and add functions. The checks undo their own test rows.
- **Every step can be undone.** See [Rollback](#rollback).
- **Your data lives in full on both devices**, and you download a backup on each first. Even a lost relay row loses nothing.

## Before you start

- **Time:** gate C takes about 30 minutes, gate E about 20. Do each gate in one sitting.
- **You need:**
  - the laptop, signed in to Supabase (the project spending-tracker-omega syncs through) and to Vercel;
  - your phone with SpendTrack;
  - the SpendTrack folder with PR-5 merged. In PowerShell, in that folder, run `git pull`, then `npm ci`. `node --version` must say v20 or later;
  - the lead's go: PR-5 is merged and its migration-safety review passed.
- **STOP** means: change nothing else and paste what you see to the lead. Whatever you did before a STOP is safe to leave as it is.
- **On the phone, the Settings tabs are icons only:** Backup is the third (a cylinder), Sync the last (a cloud). The laptop shows their names.
- Dashboard wording changes now and then. The button names here were right when this was written; if one differs, look for the nearest match.

## How to run a SQL file

Every SQL step works the same way.

1. Supabase → your project → **SQL Editor** → **+** (new query).
2. Open the file from your SpendTrack folder in VS Code or Notepad, press **Ctrl+A**, then **Ctrl+C**. (Or open it on GitHub and press **Copy raw file**.) Click into the empty query and press **Ctrl+V**.
3. Scroll to the bottom of the query: it must end the way the file ends, with nothing cut off.
4. The role selector beside **Run** must say **postgres** (the default).
5. Press **Run** (Ctrl+Enter). If the editor warns about a destructive operation, that comes from the file's own guarded statements: confirm (**Run this query**) for the file this step names, and never for anything else.
6. Read the results pane. The editor shows only the last statement's result, and every file is written so that this is all you need.
7. If you see **ERROR**, copy the error text, open a new query, run this once, then STOP:

   ```sql
   ROLLBACK;
   ```

   It closes anything the error left open. When nothing is open it does nothing (a warning "there is no transaction in progress" is fine).

Running a file twice by mistake is safe: every migration and check is written to be run again.

To log an output, use the results pane's export or copy option (for example **Copy as markdown**), select the rows and copy them, or take a screenshot.

---

## Gate C: apply 004 and switch the app over

About 30 minutes. Do C0 to C9 in one go.

### C0 · Ready? (2 min)

On **both** devices, open SpendTrack, then Settings › Sync. You should see:

- "This device runs SpendTrack 0.11.0" on each;
- the status **Synced**, with nothing waiting;
- both devices in the Devices list, and "All your devices run SpendTrack 0.11.0."

**Not today** if a device shows another version, "update it", a problem in red or "Sync paused". Open that device, reload it, and wait for **Synced**.

### C1 · Back up both devices (4 min)

On each device: Settings › Backup › **Download JSON backup**. Settings › Backup then says "Last backup: today". Keep both files somewhere outside the SpendTrack folder (for example OneDrive › Finance › Backups).

### C2 · Preflight (3 min)

Run [`supabase/checks/000_preflight_readonly.sql`](../../supabase/checks/000_preflight_readonly.sql) ([how](#how-to-run-a-sql-file)). It only reads. Its output never holds a sync code or your data.

Expect one table of 21 rows with the columns `n`, `item`, `value`, `stop` and `note`. Before 004, these are the rows to read:

| n   | item                     | you should see                                                                                           |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| 0   | `verdict`                | **`GO`**                                                                                                 |
| 1   | `stage`                  | `before 004`                                                                                             |
| 2   | `table_owner`            | `postgres (you)`                                                                                         |
| 3   | `rows_total`             | `… of the 500 cap`, below 450                                                                            |
| 5   | `rows_bad_id`            | `… in total, 0 written in the last 30 days`                                                              |
| 6   | `rows_bad_payload`       | `… in total, 0 written in the last 30 days`                                                              |
| 7   | `largest_active_payload` | `… KB of 1,228 KB`, 1,228 or less                                                                        |
| 8   | `newest_write`           | about when your devices last synced (for example `3 min ago`)                                            |
| 10  | `anon_table_privileges`  | `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` (see below), or `SELECT, INSERT, UPDATE` |
| 12  | `anon_can_prune`         | `yes` (004 removes it) or `no`                                                                           |
| 13  | `row_level_security`     | `off`                                                                                                    |
| 14  | `policies`               | `0`                                                                                                      |
| 15  | `realtime_publication`   | `table published`                                                                                        |
| 17  | `sync_functions`         | `none`                                                                                                   |
| 18  | `write_guards`           | `none`                                                                                                   |

In row 10, Postgres 17 or later adds `, MAINTAIN` at the end. 004 removes everything after `SELECT, INSERT, UPDATE`.

The other rows (`rows_created_last_hour`, `writer_classes`, `authenticated_table_privileges`, `replica_identity`, `server_time_zone`, `postgres_version`) are for the log.

If row 7's `note` starts `near the 1,228 KB limit (not a stop)`, a synced copy is over 1,000 KB. That isn't a STOP: go on, and mention it to the lead afterwards.

**STOP if row 0 says `STOP`.** Its `note` names the rows that stopped it, and each of those has `stop` = true:

- `stage` is `mixed`: the database is part-way between two states (something half-applied, or changed by hand).
- `table_owner` is not `(you)`: the editor isn't running as the table's owner. Set the role selector to **postgres** and run again; if it still says so, STOP.
- `rows_total` is 450 or more: the relay is near the 500 rows 004 allows, so new codes would soon be refused. Some rows may not be yours. Never delete rows yourself.
- `rows_bad_id` or `rows_bad_payload` has rows written in the last 30 days (the second number isn't 0): something wrote a row that isn't a SpendTrack sync copy. After 004 that row could no longer be updated.
- `largest_active_payload` is over 1,228 KB (it then says `1,229 KB` or more): a synced copy is bigger than the functions accept, so that device would pause with "too large".
- `row_level_security` is `on, forced`, or `policies` is more than 0: someone changed the table's security by hand.
- `sync_functions` or `write_guards` are only partly there: an earlier attempt left part of 004 behind.

An ERROR instead of a table is also a STOP: `relation "public.sync_buckets" does not exist` means the wrong Supabase project; `column "created_at" does not exist` means the wrong project, or 002 never ran on this one.

Copy the whole output into the [log](#gate-c-log).

### C3 · Apply 004 (2 min)

Run [`supabase/migrations/004_sync_rpc.sql`](../../supabase/migrations/004_sync_rpc.sql).

**Expect:** `Success. No rows returned`

It applies as a whole or not at all. Its own refusals come before anything starts, and each ends "Nothing was changed.":

- `SpendTrack 004: table public.sync_buckets not found. Run 001_sync.sql first. Nothing was changed.` → wrong project. STOP.
- `SpendTrack 004: … Run 002_sync_indexes.sql and 003_harden_prune_search_path.sql first. Nothing was changed.` → STOP. Don't run them on your own.
- `SpendTrack 004: run this as the table owner (…); you are …. Nothing was changed.` → set the role selector to **postgres** and run again. If it still says so, STOP.
- Any other `SpendTrack 004: … Nothing was changed.` (for example `… unexpected sync functions already exist: … Tell the lead.`) → STOP.
- Any other ERROR → `ROLLBACK;` once ([how](#how-to-run-a-sql-file)), then STOP. Nothing was applied.

Your devices carry on syncing exactly as before; they still use the table.

### C4 · Check 004 (3 min)

Run [`supabase/checks/004_verify.sql`](../../supabase/checks/004_verify.sql). It tests the new functions the way the app's public key would, on throwaway rows, then undoes every row it wrote.

**Expect** one table with the columns `n`, `check`, `expected`, `actual` and `pass`:

- row 0: `check` = `RESULT`, `expected` = `all pass`, `actual` = `PASS 34/34`;
- every other row: `pass` = true. The last row is `nothing_left_behind`.

`acting_as_anon` may say `SKIPPED: could not act as anon here; scripts/verify-cas.mjs checks this through the API`. That's fine: the editor can't act as the public key on your project, and step C6 checks the same thing through the API. Row 0 still says PASS.

**STOP if row 0 says `FAIL`** (for example `FAIL 2/34: prune_locked, write_guards_present`), or if a row named `unexpected_error` appears. There is nothing to undo, because the check undid its own rows, and 004 can stay as it is. Paste the whole table to the lead and don't go on to C6.

<details>
<summary>What each check name means</summary>

What 004 set up:

- `functions_present`: the three functions exist.
- `functions_security_definer`: they run with the table owner's rights.
- `functions_search_path_pinned`: they can't be misled by other schemas.
- `functions_owned_by_table_owner`: the table's owner owns them (gate E needs this).
- `functions_execute_anon_authenticated`: the app's key may call them.
- `functions_no_public_execute`: no other role may.
- `anon_cannot_delete_or_truncate`: the public key can't delete rows or empty the table.
- `prune_locked`: the public key can't run the prune function.
- `old_clients_still_work`: the public key can still read and write the table (until gate E).
- `write_guards_present`: the three write checks and the index exist.
- `not_locked_yet`: the table isn't locked yet (row level security off). It also says whether the table is in the Realtime publication; either is fine before gate E.

What the functions do, tried as the public key and undone afterwards:

- `throwaway_ids_free`: no row uses the check's own throwaway ids (if one does, the checks below are skipped: tell the lead).
- `acting_as_anon`: the check could act as the public key (or SKIPPED, see above).
- `head_missing_is_null`, `pull_missing_is_null`: an unknown code reads as "no row".
- `create_ok`, `create_again_is_conflict`: a new row is created once; a second create is a conflict.
- `cas_exact_token_ok`, `cas_token_increases`, `cas_old_token_is_conflict`, `cas_newer_token_is_conflict`, `cas_missing_is_missing`: compare-and-set. Only the exact current token lands; an older or a later one is a conflict.
- `force_existing_ok`, `force_missing_is_missing`: a forced write updates but never creates.
- `pull_matches_head`: a read and a check agree.
- `private_envelope_accepted`, `moved_marker_accepted`: the two other copy shapes are accepted.
- `bad_row_id_refused`, `bad_payload_refused`: junk is refused.
- `size_limit_exact`: a copy of exactly 1,258,291 bytes is accepted, one byte more is refused.
- `hourly_create_cap`: the limit of 20 new codes an hour holds.
- `table_guard_refuses_bad_row`: a direct table write with a bad id is refused.
- `anon_cannot_delete`: delete and prune are refused to the public key.
- `nothing_left_behind`: no test row is left.

</details>

### C5 · Preflight again (2 min)

Run [`000_preflight_readonly.sql`](../../supabase/checks/000_preflight_readonly.sql) again. **Expect:**

- `verdict` **`GO`** and `stage` `004 applied`;
- `anon_table_privileges` `SELECT, INSERT, UPDATE` and `anon_can_prune` `no`;
- `sync_functions` `3 of 3, as 004 made them`, and `write_guards` `all 4 (3 checks and the index)`;
- `row_level_security` `off` and `realtime_publication` `table published` (these change at gate E).

STOP if not. Copy it into the log.

### C6 · The compare-and-set check (5 min)

[`scripts/verify-cas.mjs`](../../scripts/verify-cas.mjs) runs on the laptop and talks to the relay through the same API the app uses. It writes one throwaway row (never your code) and touches no other row.

You need two values, the **Project URL** (`https://<your-project-ref>.supabase.co`) and the **anon public key**. They are the values the app itself uses: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Vercel (spending-tracker-omega → Settings → Environment Variables). Supabase shows them too, under Project Settings (the URL under API or Data API, the key under API or API Keys, where the anon key may sit under "Legacy API keys"). **Never use the `service_role` key or a secret key (`sb_secret_…`):** the script refuses them.

Pick the throwaway row id: `00000000-0000-4000-8000-`, then today's date and a run number, 12 digits in all. On 8 Nov 2026 the first run is `00000000-0000-4000-8000-202611080001` and a second run that day `00000000-0000-4000-8000-202611080002`.

Open PowerShell in your SpendTrack folder and paste these **one line at a time**, pressing Enter after each. (Pasted together, the prompts would swallow the next lines.)

1. Run this, then paste the Project URL when it asks:

   ```powershell
   $env:ST_VERIFY_URL = Read-Host "Project URL"
   ```

2. Run this, then paste the anon public key when it asks:

   ```powershell
   $env:ST_VERIFY_ANON_KEY = Read-Host "anon public key"
   ```

3. Change the date and run number at the end to yours, then run it:

   ```powershell
   node scripts/verify-cas.mjs --row 00000000-0000-4000-8000-202611080001
   ```

4. Clear both values (closing the window does the same):

   ```powershell
   Remove-Item Env:ST_VERIFY_URL, Env:ST_VERIFY_ANON_KEY
   ```

**Expect** (your times, as `<etag>` here, look like `2026-11-08T10:15:30.654829+00:00`):

```text
verify-cas: <your-project-ref>.supabase.co  row 00000000-0000-4000-8000-202611080001
PASS a. insert created the throwaway row; etag <etag>
PASS b. a write based on that exact etag changed 1 row
PASS c. a write based on the old etag changed 0 rows (a conflict)
PASS d. the new etag <etag> is later than the old one
PASS e. st_sync_head returns the current etag
PASS f. st_sync_push based on the current etag landed; etag <etag>
PASS g. st_sync_push based on an old etag is a conflict
PASS h. st_sync_pull returns the payload and the current etag
PASS i. st_sync_push refuses a payload without x5 (22023)
PASS j. a forced write to a missing row returns missing and creates nothing
RESULT: PASS (10/10). Safe to set VITE_SYNC_CAS=on.
```

What matters: every check line starts with `PASS`, and the last line starts with `RESULT: PASS` and ends `Safe to set VITE_SYNC_CAS=on.` One exception is fine: `SKIP j. the second throwaway id … exists` with `RESULT: PASS (9/9). Safe to set VITE_SYNC_CAS=on.` (check j needs a second throwaway id that doesn't exist yet; when it does, j is skipped and that row is left alone).

If not:

- `SKIP e–j. sync functions not found (apply 004 first)` (the last line then says `RESULT: PASS (4/4)`; at gate C that isn't enough): the API hasn't picked up the new functions yet. Wait a minute, then do step 3 again with the next run number. Still SKIP? STOP, and don't set the switches in C7.
- `REFUSED: <why>. Nothing was written.`: the script stopped before writing anything. Fix what it names and run again: a missing value (steps 1 and 2 again), a URL that isn't `https://…`, a `service_role` or secret key (use the anon public key), a row id not in the form above, or a row that already exists (use the next run number).
- `FAIL … could not reach …`: no connection. Check the Wi-Fi and run again with the next run number. An interrupted run can leave its throwaway row behind: harmless.
- `RESULT: FAIL (k of n failed). Do not set VITE_SYNC_CAS. Paste this output to the lead.`: STOP, and don't do C7. 004 can stay as it is.
- `FAIL a. the table is locked (005 applied); use --lockdown`: you are past gate E. This mode belongs to gate C.

The throwaway row stays in the relay (a few hundred bytes); the preflight counts it under `check rows` in `writer_classes`. [Later, optional](#later-optional) says how to remove it.

### C7 · Switch the app over in Vercel (5 min)

Only on the project **spending-tracker-omega**, never on spendtrack-demo.

1. Vercel → spending-tracker-omega → **Settings** → **Environment Variables**.
2. Add the key `VITE_SYNC_RELAY` with the value `auto`, for **Production**. Save.
3. Add the key `VITE_SYNC_CAS` with the value `on`, for **Production**. Save.
   Both values in lower case, with no quotes and no spaces.
4. **Deployments** → the newest **Production** deployment → **⋯** → **Redeploy**. If it offers "Use existing Build Cache", untick it. Confirm, and wait until it says **Ready** (1 to 2 minutes).

The switches are built into the app, so nothing changes until this redeploy is Ready. A typo is harmless: the app keeps using the table, and C8 shows it.

### C8 · Both devices (4 min)

1. Laptop: open spending-tracker-omega in Chrome. When "A new version of SpendTrack is ready." shows, press **Reload**. Nothing after a minute? Close every SpendTrack tab and open it again.
2. Phone: open SpendTrack and do the same. Nothing? Close it in the app switcher and open it again.
3. On each, Settings › Sync. **Expect:** "Live updates on · using the relay's sync functions." For the first few seconds it may say only "Using the relay's sync functions." If it says "Live updates unavailable · syncing on open and every minute · using the relay's sync functions.", the switch worked too: see [After the lockdown](#what-youll-see-after-the-lockdown) for what that line means. "This device runs SpendTrack 0.11.0" doesn't change: the version is the same, the build is new.
4. On the phone, type `runbook test 1` in the quick-add bar ("e.g. coffee 4.50, …") and save it. The last number is read as the amount, so it saves an entry named **runbook test** for S$1.00. Within seconds it shows on the laptop. On the laptop, search for `runbook test` and delete that entry; it disappears from the phone. Both say **Synced**, and no `runbook test` entry is left on either device.

A device that says "Live updates on." without "using the relay's sync functions" is still on the table: see [If something goes wrong](#if-something-goes-wrong). It keeps syncing; nothing is at risk.

### C9 · Log (2 min)

Fill in the [gate C log](#gate-c-log). Gate C is done.

From now on Settings › Sync also has a line about gate E. For the next 7 days it says "Not ready for the database lockdown: This device has used the sync functions since 12 Nov. Ready on 19 Nov." (with your dates, or naming Other device). That is expected.

---

## Gate E: lock the table

About 20 minutes, **at least 7 days after gate C**, and only when Settings › Sync says **"Ready for the database lockdown."** on both devices.

If it says "Not ready for the database lockdown: …", the rest of the line names what's missing. When only time is missing, it ends with the day it's ready ("Ready on 21 Nov."); if more than one wait is running, it names the one that ends last, so that day is the day to come back:

- "… doesn't use the relay's sync functions yet.": open SpendTrack on that device and reload it (C8, steps 1 to 3).
- "… hasn't synced for 14 days.": open SpendTrack on that device so it syncs. A device you no longer use stops counting once it has been unseen for 60 days (the list then greys it out).
- "… has used the sync functions since 12 Nov. Ready on 19 Nov.": wait until that day.
- "… has used the sync functions for less than 7 days." (no dates): that device hasn't said yet when it started; open it once so it syncs, and the dates appear.
- "An older SpendTrack (0.10.0) was last seen in the synced copy on 7 Nov. Ready on 21 Nov." (or 0.9.2, or "0.8.4 or earlier"): a device or an old tab still runs that build. Find it (the Devices list says "update it" or "Older SpendTrack (…)"), open and reload it, then wait until the day it gives. **If the "last seen" day moves to today each time you look, the old build's copy is still the one on the relay**: the line will keep moving until a device writes. Add or edit any entry on an up-to-date device, then check again the next day: the "last seen" day should then stay put. If it still moves, tell the lead (and say whether the Devices list shows one of your own devices as "Older SpendTrack (0.10.0)").

### E0 · Ready? (1 min)

Both devices say "Ready for the database lockdown." and **Synced**.

### E1 · Back up both devices (4 min)

As in [C1](#c1--back-up-both-devices-4-min).

### E2 · Preflight (3 min)

Run [`000_preflight_readonly.sql`](../../supabase/checks/000_preflight_readonly.sql). **Expect** what C5 showed: `verdict` **`GO`** and `stage` `004 applied`. `writer_classes` now counts your CAS-check row under `check rows`. STOP if it doesn't say GO, or the stage differs. Copy it into the [gate E log](#gate-e-log).

### E3 · Apply 005 (2 min)

Run [`supabase/migrations/005_sync_lockdown.sql`](../../supabase/migrations/005_sync_lockdown.sql).

**Expect:** `Success. No rows returned`

Its refusals come before anything starts, and each ends "Nothing was changed.":

- `SpendTrack 005: the sync functions from 004 are missing or not as 004 made them. Apply 004 and run 004_verify.sql first. Nothing was changed.` → STOP: something changed the functions since gate C.
- `SpendTrack 005: run this as the table owner (…); you are …. Nothing was changed.` → set the role selector to **postgres** and run again. If it still says so, STOP.
- `SpendTrack 005: table public.sync_buckets not found; is this the right project? Nothing was changed.` → wrong project. STOP.
- Any other ERROR → `ROLLBACK;` once, then STOP. Nothing was applied.

From the moment it finishes, the table is closed. Your devices carry on through the functions without noticing.

### E4 · Check 005 (3 min)

Run [`supabase/checks/005_verify.sql`](../../supabase/checks/005_verify.sql). It has the same shape as `004_verify.sql`.

**Expect** row 0: `check` = `RESULT`, `expected` = `all pass`, `actual` = `PASS 20/20`, and `pass` = true on every row. The last row is `nothing_left_behind`. `acting_as_anon` may say `SKIPPED: …` as in C4; E5 checks the same through the API.

**STOP if row 0 says `FAIL`.** Paste the whole table to the lead. Your devices keep syncing through the functions either way, so don't roll anything back on your own unless a device can't sync ([Rollback](#rollback)).

<details>
<summary>What each check name means</summary>

- `anon_no_table_access`, `authenticated_no_table_access`: the public key (and signed-in users, which SpendTrack doesn't have) can't read or write the table at all.
- `rls_on_not_forced`: row level security is on, and the functions still work.
- `no_policies`: the table has no policies, so nothing but the functions reaches it.
- `realtime_unpublished`: the database's change feed no longer carries the table.
- `replica_identity_default`: changes are no longer logged with the full row.
- `functions_intact`: the three functions are as 004 made them.
- `prune_locked`: the public key still can't run the prune function.
- `throwaway_ids_free`: no row uses the check's own throwaway ids (if one does, the checks below are skipped: tell the lead).
- `acting_as_anon`: the check could act as the public key (or SKIPPED).
- `anon_select_refused`, `anon_insert_refused`, `anon_update_refused`: direct table access is refused.
- `rpc_create_ok`, `rpc_cas_ok`, `rpc_old_token_is_conflict`, `rpc_newer_token_is_conflict`, `rpc_pull_ok`, `rpc_head_ok`: the functions still create, compare-and-set, refuse an older or a later token, read and check.
- `nothing_left_behind`: no test row is left.

</details>

### E5 · Lockdown check from the laptop (3 min)

In PowerShell in your SpendTrack folder, do steps 1 and 2 of [C6](#c6--the-compare-and-set-check-5-min) (the two prompts), then:

```powershell
node scripts/verify-cas.mjs --lockdown
```

and step 4 to clear the values. This mode only reads.

**Expect** (the text in brackets after `l.` may differ a little):

```text
verify-cas: <your-project-ref>.supabase.co  row 00000000-0000-4000-8000-000000000000
PASS l. the table refuses to list rows (HTTP 401, 42501: permission denied for table sync_buckets)
PASS m. st_sync_head answers (HTTP 200)
RESULT: PASS (2/2). The lockdown holds.
```

`RESULT: FAIL …` → STOP and paste it to the lead.

### E6 · Both devices (4 min)

Open SpendTrack on each. After a few seconds Settings › Sync says "Live updates on · using the relay's sync functions." (or "Live updates unavailable · syncing on open and every minute · using the relay's sync functions.": see the next section). Do the test-entry round trip from C8, step 4: add `runbook test 1` on the phone (it saves as **runbook test**, S$1.00), see it on the laptop, delete it there, and check that no `runbook test` entry is left on either device.

### E7 · Log (1 min)

Fill in the [gate E log](#gate-e-log). Gate E is done: the relay can no longer be listed or written with the public key alone.

---

## Optional: 006, keep a moved sync moved

About 10 minutes. **Optional.** It needs 004 (gate C done), and applies with or without 005, before or after it. Do it with gate E (right after E4, before E5), or on its own any time before you use "Make sync private" in the app. Either way, 005 must be applied before "Make sync private" is used (the app refuses the move until then).

**What it does.** When SpendTrack makes an existing sync private (a later release), it leaves a "moved" note in the old relay row, so your other devices know to ask for the new code instead of carrying on. Two things could wipe that note today: an older SpendTrack that forces its copy over the row, and the prune function, which removes rows nobody touched for 90 days. With 006 the sync functions write nothing but another "moved" note over a "moved" note (any other writer is told "conflict", reads the row again, finds the note and stops). 006 only guards writes that go through the sync functions: until 005 is applied, a device that writes straight to the table can still replace a "moved" note. The prune removes a "moved" note only once nobody has touched it for four times as long as other rows (360 days instead of 90), so the note outlives the devices that still need it, yet junk notes can't fill the relay's 500 rows for good. Nothing else changes: no row is touched, no permission changes, and every other write works exactly as before.

### 6a · Preflight (2 min)

Run [`000_preflight_readonly.sql`](../../supabase/checks/000_preflight_readonly.sql). **Expect** `verdict` **`GO`**, and `stage` `004 applied` (or `005 applied` after gate E). STOP if not.

Expect `moved 0` in the writer classes (row 9, `writer_classes`); if it is not 0, stop and tell the lead. (A "moved" note already in the relay would become impossible to write over through the app the moment 006 is in.)

### 6b · Apply 006 (2 min)

Run [`supabase/migrations/006_sync_sticky_marker.sql`](../../supabase/migrations/006_sync_sticky_marker.sql).

**Expect:** `Success. No rows returned`

Its refusals come before anything starts, and each ends "Nothing was changed.":

- `SpendTrack 006: the sync functions from 004 are missing or not as 004 made them. …` → STOP: 004 isn't in, or something changed the functions.
- `SpendTrack 006: run this as the table owner (…); you are …. Nothing was changed.` → set the role selector to **postgres** and run again. If it still says so, STOP.
- `SpendTrack 006: public.prune_stale_sync_buckets(interval) is missing or not owned by the table owner (…). Tell the lead. …` → STOP.
- Any other ERROR → `ROLLBACK;` once, then STOP. Nothing was applied.

Your devices notice nothing.

### 6c · Check 006 (3 min)

Run [`supabase/checks/006_verify.sql`](../../supabase/checks/006_verify.sql). It has the same shape as the other checks, works on throwaway rows only, and undoes everything it wrote.

**Expect** row 0: `check` = `RESULT`, `actual` = `PASS 12/12`, and `pass` = true on every row. The last row is `nothing_left_behind`. `acting_as_anon` may say `SKIPPED: …`; that's fine, and row 0 still says PASS.

Then run your gate's check again: [`004_verify.sql`](../../supabase/checks/004_verify.sql) (`PASS 34/34`) if 005 isn't applied, or [`005_verify.sql`](../../supabase/checks/005_verify.sql) (`PASS 20/20`) if it is. 006_verify doesn't replace them.

**STOP if a row 0 says `FAIL`.** Paste the whole table to the lead. There is nothing to undo, and 006 can stay as it is. (On a database without 006, 006_verify always FAILs on `marker_kept_on_cas`, `marker_kept_on_force`, `marker_kept_on_forced_envelope` and `prune_keeps_moved`: run it only after 006.)

<details>
<summary>What each check name means</summary>

- `functions_intact`: the three sync functions are still as 004 made them (they run with the table owner's rights, can't be misled by other schemas, belong to the table owner; the app's key may call them, no other role may).
- `prune_intact`: the prune function is still locked: only you may run it.
- `throwaway_ids_free`, `acting_as_anon`: as in C4.
- `marker_kept_on_cas`, `marker_kept_on_force`, `marker_kept_on_forced_envelope`: a "moved" note isn't written over, whether the writer holds the current token, forces, or sends an encrypted copy.
- `marker_replaces_marker`: a newer "moved" note can still replace an older one.
- `plain_still_written`, `marker_replaces_plain`: ordinary copies are written as before, and a "moved" note can still replace one.
- `prune_keeps_moved`: a "moved" note older than the prune's limit but younger than four times it survives the prune; one older than four times it, and an old ordinary copy, don't. The check runs the prune inside its own undo, so nothing of yours is removed.
- `nothing_left_behind`: no test row is left.

</details>

**Later:** if you ever run `004_sync_rpc.sql` again (only when the lead asks), run 006 again straight after it: 004 puts its own `st_sync_push` back. 006_verify tells you which one is in.

**If a "moved" note was written by mistake** (only when the lead says so): in the SQL editor, as **postgres**, put your sync code (Settings › Sync › Show) in place of `YOUR-SYNC-CODE` and look at that one row first:

```sql
SELECT sync_id, updated_at, payload -> 'x5' -> 'moved' AS moved FROM public.sync_buckets WHERE sync_id = 'YOUR-SYNC-CODE' AND payload -> 'expenses' = '"moved"';
```

It must list exactly one row, your code. Then delete that one row:

```sql
DELETE FROM public.sync_buckets WHERE sync_id = 'YOUR-SYNC-CODE' AND payload -> 'expenses' = '"moved"' RETURNING sync_id;
```

It must list the same one code. Your entries are safe on your devices, but they must sync again: a device that already says "Sync was made private on your other device" stays stopped on its own; on it, use Disconnect, then join again with the same code.

Log it in the [006 log](#006-log).

---

## What you'll see after the lockdown

- **Sync works as before**, through the functions.
- **Each time the app opens, live updates can take a few seconds to say "on".** The app first asks for the database's change feed, which the lockdown refuses, then switches to Broadcast. Meanwhile Settings › Sync may say only "Using the relay's sync functions.", or briefly "Live updates unavailable · …".
- **If it keeps saying "Live updates unavailable · syncing on open and every minute · using the relay's sync functions."**, sync still works: changes from your other device arrive when you open the app and every minute while it's open. Live updates need Broadcast on public channels. That's a Supabase setting, and your choice (nobody changes it for you): Supabase → **Realtime** → **Settings**, the switch that allows public access (called "Allow public access" when this was written; if yours says "Private channels only", that must be off).
  - **Allowed:** your other device hears a change within a second. Anyone holding the app's public key can join a public channel if they know its name, but SpendTrack names it from a one-way hash of your sync code, and it carries only a short "something changed" signal (a revision number and a device id), never your entries.
  - **Not allowed:** nothing is lost. The app checks every minute and whenever you open it.
  - If Settings said "Live updates on" before the lockdown, public channels are already allowed and there is nothing to change.
- **Supabase's Security Advisor may list `sync_buckets` under "RLS Enabled No Policy".** That's intended: the table has no policies on purpose, so only the three functions reach it. Its earlier warning that row level security was off on this table goes away.
- **New sync codes are limited** to 20 an hour and 500 rows in all (since gate C). See "The sync relay is full" below.
- **What the lockdown doesn't stop: someone filling the free database.** Supabase's free plan holds 500 MB; a project over it turns read-only, and sync stops until space is freed. Anyone with the app's public key could still fill it on purpose: before gate E with any number of junk rows written straight to the table, and after gate E through the functions, with up to 500 rows of up to 1.2 MB each (about 600 MB, reachable in about a day at 20 new rows an hour). Your entries are safe either way: both devices keep everything, and you have the backups. If Supabase emails you about database size, or the preflight's `rows_total` climbs towards 500 when you added no devices, tell the lead. The lead knows about this limit; a firmer one is a later change.
- **Settings › Sync's gate E line becomes "Database lockdown applied."** From 0.22.2, once a device has seen the database refuse the table, it says so and remembers it (each device learns it for itself, the first time it opens after gate E: its change feed is refused, and it asks the database once to be sure). Until a device has seen it, that device keeps the old line ("Ready for the database lockdown." or "Not ready …"): open it once, wait a minute, and look again. If 005 is ever undone ([R2](#r2--undo-005)), the line goes back to the readiness line by itself.
- **Settings › Backup says what's true after the lockdown**, once the device has seen it: "The relay copy isn't encrypted yet, but the database lockdown is applied: this app's public key alone can no longer list or read it. Make sync private to encrypt it." Before that (and on a device that hasn't seen it yet) it still says "… until the database lockdown (update 005), anyone with this app's public key could read it." The Sync tab's sentence before you link doesn't change: a build that shows it can't sync with a locked database anyway.

## If something goes wrong

What you see, what it means, what to do.

- **"Sync refused"** in the laptop's top bar, or **"The sync server refused access. Your data is safe on this device."** (in Settings › Sync, and as a message on the phone; or "Sync paused: the sync server refused access. …") after gate E: that device runs a build from before C7 (an old tab, or the installed app not reloaded). Open it and reload. If it can't update, undo 005 ([R2](#r2--undo-005)).
- **"The sync relay is full. Your changes are saved on this device."**: the limit on new rows (20 new codes an hour, 500 rows in all). Your data is safe on the device. Tell the lead, and never delete rows yourself.
- **"Sync paused: your data (… KB) is too large for the sync server."**: the functions accept a copy of up to 1.2 MB. Your data stays on the device. Tell the lead.
- **The preflight says `column "created_at" does not exist` or `relation "public.sync_buckets" does not exist`**: the wrong Supabase project, or 002 never ran on it. STOP and tell the lead.
- **A check's row 0 says `FAIL`**: STOP. There is nothing to undo, because the checks undo their own rows. Paste the whole table to the lead.
- **An ERROR part-way through a file**: `ROLLBACK;` once ([how](#how-to-run-a-sql-file)), then STOP.
- **verify-cas says `REFUSED` or `FAIL`**: see [C6](#c6--the-compare-and-set-check-5-min).
- **After C7, a device says "Live updates on." without "using the relay's sync functions"**: it is still on the old build (reload again, or close and reopen it), a variable is misspelt (check C7: `VITE_SYNC_RELAY` with the value `auto`), or the device looked for the functions before they answered and will look again within a day. All harmless: it keeps syncing through the table. Don't start gate E until both devices say "Ready for the database lockdown."

## Rollback

Every undo is safe to run twice. Order matters: switch the app back only while 005 is not applied, and undo 005 and 006 before 004.

### R0 · Undo 006 (optional)

Only when the lead asks. Run [`supabase/migrations/006_sync_sticky_marker.rollback.sql`](../../supabase/migrations/006_sync_sticky_marker.rollback.sql). **Expect:** `Success. No rows returned`. It puts back 004's `st_sync_push` and 003's prune function, exactly, and changes nothing else; on a database where 006 never ran it changes nothing. Your devices notice nothing. Afterwards your gate's check (`004_verify.sql` or `005_verify.sql`) still PASSes, and `006_verify.sql` FAILs on the four rows named in [6c](#6c--check-006-3-min): expected.

Undo it before 004 (R3), not after: once 004 is undone it refuses with `SpendTrack 006 rollback: the sync functions from 004 are missing or not as 004 made them. Tell the lead. Nothing was changed.` Undoing 005 doesn't need it.

### R1 · Switch the app back (only while 005 is not applied)

Vercel → spending-tracker-omega → **Settings** → **Environment Variables**: set `VITE_SYNC_RELAY` to `table`, or delete both `VITE_SYNC_RELAY` and `VITE_SYNC_CAS`. Then redeploy (C7, step 4) and reload both devices (C8, steps 1 and 2). Settings › Sync no longer says "using the relay's sync functions".

After gate E this would cut every device off, because the table is closed: undo 005 first. Deleting `VITE_SYNC_CAS` alone is safe at any time.

### R2 · Undo 005

Only to revive a device that can't update. It opens the table to the public key again (F-006 comes back).

Run [`supabase/migrations/005_sync_lockdown.rollback.sql`](../../supabase/migrations/005_sync_lockdown.rollback.sql). **Expect:** `Success. No rows returned`. The preflight then says `004 applied`. Your devices keep using the functions.

### R3 · Undo 004

Run [`supabase/migrations/004_sync_rpc.rollback.sql`](../../supabase/migrations/004_sync_rpc.rollback.sql).

- While 005 is applied it refuses: `SpendTrack 004 rollback: the lockdown (005) is applied. Roll back 005 first (005_sync_lockdown.rollback.sql), or keep 004. Nothing was changed.`
- Otherwise, **expect** `Success. No rows returned`. The preflight then says `before 004`, with delete, truncate and prune still taken away from the public key (on purpose). Devices on `auto` notice at their next sync and go back to the table on their own: no Vercel change is needed.

## Later, optional

None of this is needed for sync. Ask the lead first.

- **Remove the CAS-check rows.** Count them first; expect the number of C6 runs:

  ```sql
  SELECT count(*) FROM public.sync_buckets WHERE sync_id LIKE '00000000-0000-4000-8000-%' AND payload->>'spendtrack' = 'verify-cas';
  ```

  Then remove them:

  ```sql
  DELETE FROM public.sync_buckets WHERE sync_id LIKE '00000000-0000-4000-8000-%' AND payload->>'spendtrack' = 'verify-cas' RETURNING sync_id;
  ```

  It lists only the throwaway ids it removed, each starting `00000000-0000-4000-8000-`. Both conditions must hold, so it can't touch a real sync code.

- **Old rows** that no current SpendTrack wrote (the preflight's `writer_classes` counts them as `other`): the lead reviews them with you before anything is removed.
- **Automatic pruning** of rows untouched for a year, scheduled with `pg_cron` and run as `postgres`, never through the public key. The lead gives you the exact SQL. Apply 006 first: it makes the prune keep "moved" notes four times as long.

## Log

These outputs hold no sync code and none of your data, so they're safe to paste here, or to the lead. Leave out the first line of the verify-cas output: it names your project's address.

### Gate C log

| Step                            | Date and time | What it said | Notes |
| ------------------------------- | ------------- | ------------ | ----- |
| C0 both devices 0.11.0, Synced  |               |              |       |
| C1 backups, phone and laptop    |               |              |       |
| C2 preflight (verdict, stage)   |               |              |       |
| C3 apply 004                    |               |              |       |
| C4 004_verify (RESULT)          |               |              |       |
| C5 preflight (verdict, stage)   |               |              |       |
| C6 verify-cas (RESULT line)     |               |              |       |
| C7 Vercel switches, redeploy    |               |              |       |
| C8 phone and laptop, test entry |               |              |       |

### Gate E log

| Step                                           | Date and time | What it said | Notes |
| ---------------------------------------------- | ------------- | ------------ | ----- |
| E0 both say "Ready for the database lockdown." |               |              |       |
| E1 backups, phone and laptop                   |               |              |       |
| E2 preflight (verdict, stage)                  |               |              |       |
| E3 apply 005                                   |               |              |       |
| E4 005_verify (RESULT)                         |               |              |       |
| E5 verify-cas --lockdown (RESULT)              |               |              |       |
| E6 phone and laptop, test entry                |               |              |       |

### 006 log

| Step                                       | Date and time | What it said | Notes |
| ------------------------------------------ | ------------- | ------------ | ----- |
| 6a preflight (verdict, stage)              |               |              |       |
| 6b apply 006                               |               |              |       |
| 6c 006_verify (RESULT)                     |               |              |       |
| 6c 004_verify or 005_verify again (RESULT) |               |              |       |

Paste full outputs below each table if you like, each in its own block.
