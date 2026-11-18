# Run your own SpendTrack

This guide is for running your own copy of SpendTrack: on your computer, on any static host, and, if you want it, with sync between your devices through your own free Supabase project. You don't need to know databases: every database step is a file you paste and run, and each one tells you what you should see.

**Jump to:** [Without a server](#1-without-a-server) · [Sync on your own Supabase project](#2-sync-on-your-own-supabase-project) · [What you get](#3-what-you-get-and-what-you-dont) · [Pruning old rows](#4-optional-prune-old-rows) · [Troubleshooting](#5-troubleshooting)

## 1. Without a server

SpendTrack is local-first. Everything except sync works with no server and no settings at all: entries, budgets, insights, themes, backups (Settings › Backup exports and imports a JSON file), and installing it as an app. Your data stays in that browser on that device.

You need Node.js 20 or later and npm.

```bash
git clone https://github.com/ShadeNKB/spending-budgeting-tracker.git
cd spending-budgeting-tracker
npm ci
npm run dev        # http://localhost:5173
```

To put it online, build it and upload the `dist/` folder to any static host:

```bash
npm run build      # writes dist/
npm run preview    # optional: serves dist/ locally, with the same security headers as production
```

Vercel is one option and needs no configuration: import the repository, and it reads `vercel.json` (the build command, the security headers, and the rewrite that sends every page to `index.html`). On another static host (Netlify, Cloudflare Pages, GitHub Pages, your own server), set the same two things yourself:

- **Every path that isn't a file serves `index.html`** (a single-page app fallback), or reloading a page such as `/ledger` shows the host's 404.
- **The headers in `vercel.json`**, at least the `Content-Security-Policy`. It allows connections to `*.supabase.co` only; if your Supabase project uses a custom domain, add that domain to `connect-src`. Serve `sw.js` with `Cache-Control: no-cache` so updates arrive.

## 2. Sync on your own Supabase project

Sync is optional. It links your devices with one code (no account, no password) through a single table in a Supabase project that you own. Plan about 20 minutes, once.

These steps are for a **new, empty** project. If you already run a relay that SpendTrack devices sync through and it was set up before migration 004, don't use this list: upgrade it step by step with [`docs/brain/sync-runbook.md`](brain/sync-runbook.md), which waits between steps so older devices aren't cut off. A new project has no older devices, so you apply everything in one sitting.

### Step 1 · Create the project

1. Sign up at [supabase.com](https://supabase.com) and create a new project (the free plan is enough). Pick any name and region, and keep the database password somewhere safe: SpendTrack never needs it.
2. Wait until the dashboard says the project is ready.

### Step 2 · Run the SQL files

Each step below is one file from this repository's `supabase/` folder, run by hand in the **SQL Editor**:

1. Supabase → your project → **SQL Editor** → **+** (new query).
2. Open the file, select all of it, copy, and paste it into the empty query. Check that the end of the query is the end of the file.
3. The role beside **Run** must be **postgres** (the default).
4. Press **Run**. If the editor warns about a destructive operation, that comes from the file's own guarded statements: confirm it for the file the step names, never for anything else.
5. Compare the results pane with the **Expect** column. The editor shows only the last statement's result; every file is written so that this is all you need.

Never point `supabase db push` or another migration runner at the folder: the `*.rollback.sql` files carry the same numbers and would run too. You won't need the rollback files on a new project.

<!-- The test src/__tests__/sql/selfhost.test.ts replays this table, in this order, on an empty database. -->

| Step | Run                                                                                           | Expect                                      |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1    | [`001_sync.sql`](../supabase/migrations/001_sync.sql)                                         | Success. No rows returned                   |
| 2    | [`002_sync_indexes.sql`](../supabase/migrations/002_sync_indexes.sql)                         | Success. No rows returned                   |
| 3    | [`003_harden_prune_search_path.sql`](../supabase/migrations/003_harden_prune_search_path.sql) | Success. No rows returned                   |
| 4    | [`000_preflight_readonly.sql`](../supabase/checks/000_preflight_readonly.sql)                 | `verdict` is `GO`, `stage` is `before 004`  |
| 5    | [`004_sync_rpc.sql`](../supabase/migrations/004_sync_rpc.sql)                                 | Success. No rows returned                   |
| 6    | [`004_verify.sql`](../supabase/checks/004_verify.sql)                                         | row 0 says `PASS 34/34`                     |
| 7    | [`000_preflight_readonly.sql`](../supabase/checks/000_preflight_readonly.sql)                 | `verdict` is `GO`, `stage` is `004 applied` |
| 8    | [`005_sync_lockdown.sql`](../supabase/migrations/005_sync_lockdown.sql)                       | Success. No rows returned                   |
| 9    | [`005_verify.sql`](../supabase/checks/005_verify.sql)                                         | row 0 says `PASS 20/20`                     |
| 10   | [`006_sync_sticky_marker.sql`](../supabase/migrations/006_sync_sticky_marker.sql)             | Success. No rows returned                   |
| 11   | [`006_verify.sql`](../supabase/checks/006_verify.sql)                                         | row 0 says `PASS 12/12`                     |
| 12   | [`005_verify.sql`](../supabase/checks/005_verify.sql)                                         | row 0 says `PASS 20/20`                     |
| 13   | [`000_preflight_readonly.sql`](../supabase/checks/000_preflight_readonly.sql)                 | `verdict` is `GO`, `stage` is `005 applied` |

What the files do, in short:

- **001 to 003** create the table `sync_buckets` (one row per sync), an index, and a prune function only you can run.
- **004** adds the three functions the app syncs through (`st_sync_head`, `st_sync_pull`, `st_sync_push`). They check every write (a valid id, the shape of a SpendTrack copy, at most about 1.2 MB) and do compare-and-set, so two devices writing at once never overwrite each other. It also caps new rows (see [the limits](#the-limits)).
- **005** is the lockdown: the app's public key can no longer list, read or write the table at all, only call the three functions, and those need a row id.
- **006** (recommended) keeps a "this sync moved" note from being written over. A new project doesn't need it on day one (it matters when a plain sync is made private), but it costs nothing and the order above includes it.

Notes on the checks:

- The **preflight** (`000_preflight_readonly.sql`) only reads, and is one table of 21 rows. Run it after 003, not before: on an empty project it stops with `relation "public.sync_buckets" does not exist`, which only means 001 hasn't run yet.
- **`004_verify.sql` belongs right after 004.** Once 005 is in, it FAILs on purpose (it checks that the public key can still use the table, which 005 takes away). After 005, the check for your project is `005_verify.sql`.
- In a check, the row `acting_as_anon` may say `SKIPPED: …` when the editor can't act as the public key. That's fine: row 0 still says PASS.
- The checks write throwaway rows (ids starting `00000000-0000-4000-8000-`) and undo every one before they answer; the last row, `nothing_left_behind`, proves it. Run any check as often as you like.
- `006_verify.sql` doesn't replace `005_verify.sql`, so step 12 runs that one again.
- **Stop** if a step shows an ERROR or a check FAILs. Copy the message, open a new query, run `ROLLBACK;` once (a warning "there is no transaction in progress" is fine), then look the message up in [Troubleshooting](#5-troubleshooting). Every file can be run again safely.

### Step 3 · Find the project URL and the public key

- **Project URL**: Supabase → **Project Settings** → **Data API** (or **API**): `https://<your-project-ref>.supabase.co`.
- **Public key**: Supabase → **Project Settings** → **API Keys**. Use the **anon public** key (it may sit under "Legacy API keys") or the **publishable** key (`sb_publishable_…`).
- **Never** use the `service_role` key or a secret key (`sb_secret_…`). Everything you put in these settings is built into the app and anyone who opens it can read it; the public key is made for that, and the lockdown is what keeps it harmless.

Dashboard wording changes now and then; if a name differs, look for the nearest match.

### Step 4 · Set the build settings

Settings are read when the app is **built**, so set them before you build or deploy, and rebuild after any change. For a new project, set exactly these:

```dotenv
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key
VITE_SYNC_RELAY=rpc
```

- **`VITE_SYNC_RELAY=rpc`** makes the app sync only through the three functions. It is the right value for a new project: after 005 the table refuses the public key, and there are no older devices that need it. (`auto` also works: it asks the database first and falls back to the table where the functions are missing, which only matters for a relay that is being upgraded.) Lower case, no quotes, no spaces.
- **`VITE_SYNC_CAS`**: leave it unset. It turns on compare-and-set for writes **to the table**; with `rpc` the app never writes to the table, and the functions always do compare-and-set.
- **`VITE_DEMO_MODE`**: leave it unset for your own copy. `true` fills a first visit with sample entries, for a public demo.

Where to put them:

- **On your computer:** `cp .env.example .env.local`, fill in the values, then `npm run dev` (or `npm run build`). `.env.local` is never committed.
- **On Vercel:** your project → **Settings** → **Environment Variables**: add the three for **Production**, then **Deployments** → the newest deployment → **⋯** → **Redeploy** (untick "Use existing Build Cache" if offered).
- **On another host:** set them as build-time environment variables in its build settings, then rebuild.

### Step 5 · Link your devices

1. Open your copy of SpendTrack on the first device (reload it once after the redeploy; an installed app shows "A new version of SpendTrack is ready." with a Reload button). Settings › **Sync** now says a sync started here is private.
2. Tap **Generate sync code for this device**. The code starts with `ST5-`. Tap **Copy** (or **Show** to read it).
3. On your second device, open the same site, Settings › **Sync**, paste the code under **or join an existing one**, and tap **Join**. It shows what joining does ("This device: 0 entries · Synced: 12 entries · After joining: about 12 entries"); tap **Join** again.
4. Add an entry on one device: it shows on the other within seconds (or within a minute: see [live updates](#live-updates)). Settings › Sync says **Synced** on both, and "using the relay's sync functions".

Add more devices the same way, with the same code. Share the code only with your own devices: it is the key to your synced copy.

## 3. What you get, and what you don't

### Private from the first code

With the settings above, every sync started with **Generate** is private. Each device encrypts what it sends before it leaves the device (AES-GCM-256, with a key derived from the code using HKDF-SHA256, both built into the browser), and the database holds one row of ciphertext under an id worked out from the code, never the code itself. Only a device with the code can read the synced copy; a change made in the database by anyone without the code is detected and never merged.

A code of 36 characters with dashes (no `ST5-`) is an older, plain sync: its copy is not encrypted. You only get one if a device runs a build without `VITE_SYNC_RELAY`, or if you join a code from somewhere else.

### The lockdown

After 005, the public key that ships inside the app can't list, read or write the table. A device reaches its row only through the three functions, and only with that row's id, which for a private sync is derived from the code.

### The limits

- **New rows:** at most 20 new sync codes an hour and 500 rows in all, for the whole project. Past either, a new code is refused ("The sync relay is full."); existing codes keep syncing.
- **Size:** one synced copy can be up to 1,258,291 bytes as the database stores it (about 1.2 MB). The app pauses before that and says so; your data stays on the device.
- **Database size:** Supabase's free plan holds 500 MB. Anyone who has your site's public key can still create rows through the functions, up to the caps: 500 rows of about 1.2 MB is about 600 MB, more than the free plan holds, reachable in about a day at 20 rows an hour. Over the limit Supabase makes the project read-only and sync stops; nothing is lost, because every device keeps its full copy. If Supabase emails you about database size, or the preflight's `rows_total` climbs while you added no devices, remove the rows you don't recognise (or start a new project). A firmer bound is not built.
- **Free projects can be paused** by Supabase when they see no activity for a while (check their current terms). While paused, sync can't reach the server; restore the project from the dashboard and devices catch up.

### What the operator of the project can and cannot see

You are the operator, and so is Supabase, which runs the database. For a private sync:

- **Can see:** that a row exists, how big it is and how its size changes, when it is written, the IP addresses and browsers devices connect from (in the API logs), and the random device ids in live-update messages.
- **Cannot see:** your entries, categories, budgets or the code. The row holds only ciphertext.
- **Cannot stop:** someone who can write the row (the operator, or anyone with the code) replacing it with garbage or an older copy. A device detects a copy it can't read and repairs it from its own; an older copy changes nothing on a device that already holds newer entries.
- **Out of scope:** a device that is compromised (the code and the data live in its storage), and whoever serves the app's JavaScript (your hosting account, the build).

A plain sync (a code without `ST5-`) is not encrypted: the operator can read it, and so can anyone who has its code.

### Other things to know

- **There is no account and no recovery.** Lose the code and every device, and nobody can read the synced copy. Keep a backup (Settings › Backup).
- **There is no way to lock one device out.** Start a new sync on the devices you keep.
- **Settings › Sync says "Database lockdown applied."** once a device has synced after 005 is in (from 0.22.3: the device asks the server once after it opens). Before 005, the line says whether every device is ready for it; that matters only when upgrading an older relay. The preflight's `stage` is the database's own answer.

### Live updates

A private sync hears changes over Supabase Realtime **Broadcast** on a channel named from a one-way hash of the code; the message carries a revision number and a device id, never your entries. That needs Broadcast on public channels: Supabase → **Realtime** → **Settings** → allow public access (if your project says "Private channels only", that must be off). It is your choice:

- **Allowed:** the other device hears a change within a second, and Settings › Sync says "Live updates on · using the relay's sync functions."
- **Not allowed:** nothing is lost. Settings › Sync says "Live updates unavailable · syncing on open and every minute · using the relay's sync functions.", and changes arrive when the app opens and every minute while it's open.

## 4. Optional: prune old rows

Nothing removes old rows by itself. A row is one sync code; a code you stopped using keeps its row, and rows count toward the 500-row cap. The prune function removes rows nobody has written to for a given time; with 006 it keeps a "moved" note four times as long. Only you (the `postgres` role) can run it; after 004 the public key can't.

Run it by hand in the SQL Editor whenever you like:

```sql
SELECT public.prune_stale_sync_buckets(interval '365 days');
```

It answers the number of rows it removed. Pick a time longer than any of your devices ever goes without syncing: a sync whose row was pruned has to be started again (Generate on one device, Join on the others; each device keeps its entries and a join merges them).

To run it every week, enable the **pg_cron** extension (Supabase → **Database** → **Extensions**, or **Integrations** → **Cron**), then run this once in the SQL Editor as **postgres**:

```sql
SELECT cron.schedule('spendtrack-prune', '30 3 * * 0', $$SELECT public.prune_stale_sync_buckets(interval '365 days')$$);
```

That runs every Sunday at 03:30 (the database's time zone, normally UTC). To stop it: `SELECT cron.unschedule('spendtrack-prune');`.

## 5. Troubleshooting

### In the app

- **Settings › Sync says "Cloud sync not configured"**: the build has no `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY`. Set both (step 4) and rebuild or redeploy; a setting added after the build does nothing until then. (The short setup list on that screen predates this guide: follow this guide.)
- **"Couldn't reach the sync server. Your changes are saved on this device."**: the device is offline, the URL is wrong (it must be `https://<ref>.supabase.co`, no path), the project is paused, or the page's security policy blocks the address (a custom Supabase domain must be added to `connect-src`; see [section 1](#1-without-a-server)).
- **"The sync server refused access. Your data is safe on this device."** (or "Sync paused: the sync server refused access. …"): the key is wrong (a typo, the wrong project, or a key that was rotated), or this build has no `VITE_SYNC_RELAY=rpc` and is trying the table, which 005 closed. Check step 4 and rebuild.
- **"The sync server had a problem. Your changes are saved on this device."** and it doesn't go away: with `VITE_SYNC_RELAY=rpc`, the sync functions are missing. Run the preflight: `sync_functions` must say `3 of 3, as 004 made them`; if not, run 004 again, then 004_verify (or, after 005, 005_verify).
- **"The sync relay is full. Your changes are saved on this device."**: the 20-an-hour or 500-row cap. Within the hour it clears by itself; for 500 rows, see [the limits](#the-limits) and [pruning](#4-optional-prune-old-rows). Existing codes keep syncing.
- **"Sync paused: your data (… KB) is too large for the sync server."**: the copy is over the size limit. Your data stays on the device; export a backup.
- **"Sync paused: this sync server cannot keep a private sync safe yet."**: a private code on a build without `VITE_SYNC_RELAY=rpc`. Every device must use a build with the setting.
- **"No synced data found for this code. Check it on your other device."**: a mistyped code, or the first device hasn't synced yet (wait until it says **Synced**). Joining never creates anything.
- **Generate made a code without `ST5-`**: the build has no `VITE_SYNC_RELAY`. Disconnect, fix step 4, rebuild, and Generate again.

### In the SQL Editor

- **`SpendTrack 004: table public.sync_buckets not found. Run 001_sync.sql first.`** (or `column … created_at not found`): run the files in the order of [step 2](#step-2--run-the-sql-files).
- **`SpendTrack 004: roles anon and authenticated not found …`**: this isn't a Supabase project's database.
- **`… run this as the table owner (…); you are ….`**: set the role beside **Run** to **postgres** and run again.
- **`SpendTrack 005: the sync functions from 004 are missing or not as 004 made them.`** (or the same from 006): run 004 and `004_verify.sql` first.
- **The preflight says `relation "public.sync_buckets" does not exist`**: 001 hasn't run in this project (or this is the wrong project).
- **A check's row 0 says `FAIL k/n: …`**: the names after the colon say which checks failed. `004_verify.sql` FAILs after 005 on purpose; run `005_verify.sql` instead. Otherwise, run the preflight: its `stage` row says which files are in (`before 004`, `004 applied`, `005 applied`, or `mixed`), and its notes say what stopped it.
- **Any other ERROR**: run `ROLLBACK;` once in a new query; nothing from that file was applied. Each file can be run again.

More on each file and its known limits: [`supabase/README.md`](../supabase/README.md).
