# Private sync (PR-6): spec

Status: version 3, 15 Nov 2026. Release 1 is built and shipped (0.21.0) as written except where section 10 ("As built") says otherwise. Release 2 (section 4) is not built: its text was failed by its second review and is rewritten here (section 10, "Second review of release 2"). Version 1 was failed by two independent reviews (security; sync correctness) before any code was written: section 10 records what they found. This version splits the track into two releases and replaces the move's protocol.

Track T2's last piece ("end-to-end encryption with hashed row ids"). Written from the code as it stands at v0.20.0: the data-engine spec the source cites (`DATA-ENGINE-SPEC §10, §11, §13`) is not in this repository, so this document restates what the code froze and specifies what is still to build.

## 1. What this is for, and what it is not

Today a synced bucket is one row of `public.sync_buckets`, in plaintext, under a row id that is the sync code itself. Whoever can read the table can read every entry, and whoever can read a row id holds the code that writes it. Migration 005 (gate E) closes the table to the public key; it does not change what the database, its operator, its backups or a leaked service key can read.

A private bucket's row holds only ciphertext, under a row id that is not the code. **From the moment a bucket is private, what a device sends is encrypted on that device first**, and a change made on the relay by anyone without the code is detected and never merged. One exception, once: when an existing plain bucket is made private (section 4), the device merges what its old plain row holds one last time. That content was writable by anyone who could write the plain row, exactly as it was at every sync before the move.

What it does not do, said here so no screen overclaims:

- **It does not un-publish the past.** Everything a plain bucket held before it was made private sat readable on the relay. Private sync protects what is written afterwards.
- **Remnants of old plaintext outlive the switch**: dead rows and write-ahead log in the database (before 005 the table's replica identity is FULL, so the update that retires a row logs the whole old row), the provider's own backups, API logs that hold `sync_id=eq.<code>` for table-transport requests, the 7 Nov backup copy (in a private schema with no API grants; dropped after gate E), and unreadable-copy quarantine keys (`st5:q:relay:*`) on a device.
- **A compromised device is out of scope**: the code and the data are in its storage. So is whoever serves the JavaScript (the hosting account, the build, a dependency), and the clipboard a code is copied through.
- **Metadata is visible to the relay**: row sizes and their change per write, write times, IP addresses and user agents, the device ids in Broadcast messages, the revision and the compression flag of each envelope, the device id in a moved marker (`by`), and the link between a plain row and the private row that replaced it (creation time, same devices, and the mover's later checks of the old row, 4.4).
- **Availability is not protected.** Anyone who can write a row can replace it with garbage. A device detects that and repairs the row from its own copy; where it cannot tell damage from a newer format, the owner is offered the repair (3.9).
- **No freshness guarantee from the relay.** The relay can serve an older valid copy. Merging an older copy changes nothing on a device that already holds a newer one (tombstones are never pruned and the merge is a join); a device joining for the first time can be handed stale state, which the next write from the other device corrects.

## 2. What already exists (frozen; do not change)

| Piece                                                                                                                   | Where                                                       | State                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codec: `deriveKeys`, `seal`, `open`, `aadOf`                                                                            | `src/data/core/e2e.ts`                                      | Built, known-answer vectors in `e2e.test.ts`. Unused by sync.                                                                                                                               |
| Private code `ST5-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX` (128-bit secret, Crockford base32, 2 check symbols)                  | `src/data/core/codes.ts`                                    | Built and tested. Unused by the UI.                                                                                                                                                         |
| Moved marker `{expenses:"moved", x5:{moved:{at, why}}}`, `why: private \| rotated \| stopped`                           | `wire.ts` `movedMarker`, `classify`                         | Built. Written by nothing.                                                                                                                                                                  |
| A device that pulls a marker or an envelope pauses and does not push in that cycle                                      | `syncEngine.ts` `mergeStep`                                 | Shipped since 0.10.0. **Not durable**: nothing is persisted, and a row can be rewritten over a marker by a forced write, by the upsert transport, or after a prune (section 10, finding A). |
| A device config of an unknown kind is "set up by a newer SpendTrack": kept, never synced over                           | `services/storage.ts` `isNewer`, `useSyncStore.initSync`    | Shipped since 0.11.0. (0.10.0 quarantines such a config and reads the device as unlinked.)                                                                                                  |
| The relay accepts an envelope (`st = 5`, string `iv`, string `ct`) and a moved marker; row ids must be lower-case UUIDs | `supabase/migrations/004_sync_rpc.sql` (applied 7 Nov 2026) | Applied. No database change is needed to accept private rows. The prune function (rows untouched for 90 days) would also remove a marker: section 4.5.                                      |
| Join refuses a typed `ST5` code by its prefix                                                                           | `JoinSync.tsx`                                              | Shipped.                                                                                                                                                                                    |

Frozen parameters (`e2e.ts`): HKDF-SHA256 over the 16-byte secret with salt `spendtrack/sync/v5`; info `row-id` → 128 bits formatted as a UUIDv8 (the row id); info `topic` → the Realtime channel `st:` + base64url(128 bits); info `payload-key` → a non-extractable AES-GCM-256 key. Envelope `{st:5, k:1, r, iv, z, ct}`: `r` is the inner payload's `x5.rev`, `iv` 12 random bytes fresh per write, `z` 1 for gzip, `ct` ciphertext and 128-bit tag in unpadded base64url. Additional data `st5|k1|<rowId>|<r>|z<z>` binds a ciphertext to its row, its revision and its compression flag. The inner plaintext is an ordinary v5 wire payload.

## 3. Release 1 (0.21.0): private buckets

A device can start a private bucket, join one with its code, and sync it. Nothing changes for a bucket that is plain, and nothing in this release retires or rewrites a plain row. The owner's existing bucket stays as it is until release 2.

### 3.1 A bucket in place of the bare code

```ts
interface Bucket {
  kind: 'plain' | 'e2e'
  code: string // what the owner sees and types: a UUID, or the ST5 display form
  rowId: string // plain: the code. e2e: derived, never stored, re-derived on every start
  topic: string // plain: plainTopic(code). e2e: keys.topic
  keys: SyncKeys | null
}
```

Derived once per code and cached in memory. Every place that takes "the code" today takes the bucket, and uses `rowId` for the relay and `topic` for Realtime: `cycle`, `attempts`, the transport probe in `openTransport`, `previewJoin`, `ensureSubscribed`, `announce`, the etag memo (`etagOf`/`setEtag`/`landed`, keyed by `fnv36(rowId)`: for a plain bucket today's value, so no migration), `establish`, `publishView`, `setupSync`. The local engine's "is sync on" (`storage.getSyncId()` in `data/local/engine.ts`, which is null for a non-plain config and would stop the outbox recording) asks for "any linked config".

### 3.2 The device's storage

- **The private code lives in its own key, `st5:synckey`**, as `{ code, at }`. No build before this one reads or writes that name, and the rescue export skips every key matching `synckey`.
- `st5:sync` holds `{ kind:'e2e', joinedAt, established }`, with no code and no row id. A quarantined copy of it (`st5:q:st5:sync:*`) therefore never holds a secret.
- No `syncId` mirror for a private bucket.
- **Reader rule:** a valid `st5:synckey` means this device is private. It wins over any `syncId` mirror, it never takes the "config without a mirror was disconnected elsewhere" branch, and a missing or overwritten `st5:sync` is restored from it. Start-up never rewrites a private config, and `saveSyncId` (the plain writer) refuses while a private key exists. Only Disconnect, "Remove from this device" and a completed Join of another code remove the key.
- A config change made by another tab is followed: every cycle start re-reads the persisted config and, when the kind or the code differs from the bucket in memory, stops and sets up again.
- The Reconnect slot (`st5:synckey:prev`) stays UUID-only: `keepPrevious` ignores anything else. Disconnect on a private device forgets the code; its question says so and offers Copy first.

### 3.3 The cycle for a private bucket

`mergeStep` stays the synchronous section it is. Encryption sits outside it; after each await the cycle re-checks `gen !== setupGen` and stops when the bucket changed.

1. `pull(rowId)`.
2. **Read** (async, before `mergeStep`). The only valid content of a private row is an envelope that opens:
   - `open` ok **and** the inner value is a v5 payload whose `x5.rev` equals the envelope's `r` → the inner value goes to `mergeStep` as a plaintext pull does today (decode, sanitise, classify);
   - `open` says `newer` (a later `st` or `k`, or gzip this browser cannot read) → pause `update-required`, remember the etag (so the HEAD short-cut does not re-open it every minute), never overwrite. This judgement is made on an unauthenticated header: a forged one cannot be told from a real one, so the owner has a way out (3.9);
   - **everything else is `invalid`**: a failed authentication, a wrong shape, a plaintext v5 payload, a plaintext moved marker, an inner payload of any other writer class or with another revision. It is never merged and **no copy of it is kept**: what does not open under this bucket's key can be read by no device that holds the code, so there is nothing for the owner to recover from it, and unreadable copies must never fill storage. The row is repaired from this device's copy under the gate that paces plaintext repairs today (at most every 10 minutes, and only by a device that has synced with this code);
   - no row → as today (create on first push for the device that started the bucket, `not-found` for one that joined).
3. `mergeStep(bucket, opened, reason)`: the logic is unchanged. `news` (Realtime row payloads) is always empty for a private bucket. This device's registry entry carries `e2e: true`. The inner payload is encoded with `min: SCHEMA`.
4. **Seal** (async, after `mergeStep`), through one wrapper, the only caller of `seal`: it draws the 12 IV bytes from `crypto.getRandomValues` at the call (never from the engine's seeded generator, never stored, a fresh draw for every seal, a re-seal included), `r` is the step's revision, `z` is 1 when `canCompress()`.
   - `too-large` from `seal`, or an envelope whose JSON exceeds the transport's bound (`PAYLOAD_MAX_CHARS`, 1 MiB: the binding limit, below the codec's own), pauses `too-large`. `tooLargeForRelay` judges the envelope. The pre-seal bound `WIRE_PUSH_MAX` still applies to the inner payload.
5. `push(rowId, envelope, { base: pulled.etag })`: compare-and-set and retries as today. **A private bucket is never force-written by the cycle** (every writer of a private row compare-and-sets, so the forced fourth attempt has no stuck older build to break through): after `CYCLE_ATTEMPTS_MAX` conflicts the cycle ends busy and the next one starts over.

`open` and `seal` run under a deadline like a request does; a timeout is a failed cycle that retries.

**Transport.** A private bucket needs compare-and-set: the RPC transport, or the table transport built with `VITE_SYNC_CAS=on`. On the upsert transport a private bucket pauses (`no-cas`: "This relay cannot keep a private sync safe yet") and writes nothing.

### 3.4 Realtime

Broadcast on `keys.topic` only (`{rev, dev}`: no content). Row events (`postgres_changes`) are never subscribed for a private bucket and `onRowChange` returns at once for one: the filter would carry the row id and the payload is an envelope. The 60-second poll and the HEAD short-cut stay.

### 3.5 Joining with a private code

`previewJoin` takes what was typed and classifies it with `parseSyncCode` (the screens keep not importing the data core):

- a UUID → today's plain join, unchanged;
- an `ST5` code that parses → derive the keys, pull the private row, open it, and return the preview a plain join shows (entries here, entries there) before anything is merged. Confirm → write `st5:synckey`, then the config, then run a cycle. The device is established only after an authenticated open;
- an `ST5` code that does not parse → by reason: `length`, `symbol`, `range`, `checksum` ("One character of that code looks wrong. Check it against your other device.");
- no row for the code → "No private sync was found for that code. Check it on your other device.";
- a row that does not open → the line a plain join has for a copy it cannot read ("The synced copy can't be read. Join from a device that synced it before."): the cause may be the code or the copy, and the owner's next step is the same. Nothing is joined;
- a row marked as a newer format → "This sync was moved by a newer SpendTrack. Reload SpendTrack to update, then join."

The code field turns off auto-capitalise, auto-correct and spell-check. A join never sends the code anywhere: only the derived row id leaves the device.

### 3.6 Starting a new sync

"Generate" creates a private bucket: 16 bytes from `crypto.getRandomValues`, the `ST5` code, `st5:synckey`, and a first sealed push that creates the row. A device on an older version that is given the code says so by the message it has today. Joining an existing plain UUID code keeps working.

### 3.7 The durable fence

A device on this release that pulls a moved marker from its **plain** bucket writes `fenced: { why, at }` into its plain config before it pauses. While `fenced` is set that device never pulls, pushes or re-creates that row, whatever the row holds later, a missing row included. Only joining another code or Disconnect clears it. Its entries, its outbox and its snapshots are untouched.

- `why: private` pauses `moved-private`: "Sync was made private on your other device. Enter the new sync code shown there." Settings › Sync shows the code field in place. It is not a reload state (`needsReload` is false for it) and going offline does not replace it.
- any other `why` keeps today's `moved` wording, now durable.

Nothing in release 1 writes a marker. The fence ships first so that every device is already safe when release 2 does.

### 3.8 On screen

- Settings › Sync, private bucket: the code masked as today (`••••-…-XXXX`), Show and Copy as today; under the code, one line: "Private sync: what this device sends is encrypted here first. Only a device with this code can read the synced copy from now on." (No badge on the status row: the row says what sync is doing, and one sentence says what kind it is.)
- Settings › Sync, not linked, on a build whose relay can keep a private sync safe (`privateSyncReady`: the sync functions, or compare-and-set on the table): the intro says a sync started here is private, and Generate makes a private code. Other builds keep the "isn't encrypted yet" intro and make a plain code.
- Settings › Sync, plain bucket: the existing "isn't encrypted yet" line stays (release 2 adds the action).
- Backup panel: its sentence follows the bucket's kind.
- The sync pill: `moved-private` reads "enter new sync code" and `no-cas` "server not ready"; both open Settings › Sync.
- Device list: unchanged ("This device", "Other device").

### 3.9 The owner's ways out

- **A private row this device cannot read as current** (`update-required` on a private bucket, while no newer build is waiting): Settings › Sync offers "Replace the synced copy", and asks first ("Replace the synced copy with this device's?", saying that other devices add their entries back when they next sync and that anything only the synced copy held is lost). Confirmed, it runs one ordinary cycle, under the lock, that treats the row as unreadable: nothing of it is merged, and this device's copy is sealed and written by compare-and-set on the etag that cycle pulled (never forced; a write that lands first is merged, not written over). It does not wait out the pace of automatic repairs, and it is not offered while a new build is waiting (Reload is the answer then) or on a plain sync. This is the repair for a forged or damaged header.
- **Fenced with no code to enter**: the same panel says "No code? Use Disconnect at the bottom of this page, then start a new sync. Your entries stay on this device." The old code is not shown while fenced: no device syncs with it any more.

## 4. Release 2: making an existing bucket private (gate D)

Version 3 of this section. Version 2 was failed by its second review (two independent read-only reviewers, 15 Nov, against the code of 0.21.0): section 10 records what they found. Not built yet. `U` is the bucket's plain code, `P` its plain row, `R` the private row.

### 4.1 When it is offered

Settings › Sync offers "Make sync private" on a device whose plain bucket is established, not paused and not fenced, when all of these hold:

- the browser has Web Locks, and this device's transport is compare-and-set (RPC, or CAS on);
- every device in the registry reports the RPC mode and a version that has release 1, unless it last pushed more than 60 days ago (`STALE_AFTER_MS`). A row that was never seen (`seen: 0`) counts as a device that has not updated;
- no older writer has been seen in the last 60 days (`legacySeen`).

One more condition is checked when the button is pressed, because it costs a request: **the relay must refuse the table** (migration 005 is applied). The move asks the table transport for the head of a fixed row id that no bucket uses (not of `P`, so `U` stays out of the API's logs). Only the relay's permission refusal lets it go on (the test `reprobeFor` already makes). An answer, a timeout or any other error stops it, with nothing changed: "This sync's server still allows direct reads. Make sync private after the database lockdown." A refused read does not prove that writes are refused: a lockdown made by hand that still let the public key update the table would pass. That could only be checked by writing, so it is not checked, and is recorded here. Before the lockdown a table writer chooses its own tokens, is not held to the creation caps, sees every row event of the table, and may be an old client that can only upsert: the move's compare-and-sets prove nothing there.

The registry is read from the plain row and can be forged by anyone who can write it; the gate is a guard against the owner's own mistake, not a security boundary. A device that only reads looks stale to it; the question says a device that has not synced lately will have to update and enter the code.

### 4.2 The move's own record

The move keeps its state in a key of its own, `st5:synckey:move`, and never in `st5:sync`. Every setup of release 1 writes `st5:sync` and `st5:synckey` from scratch (`keepCode` → `savePrivateSync`): at each start-up, in each tab that follows a changed setup, and in a tab still running 0.21.0. State kept in either would be erased by the first of them, the old row would never be retired, and both devices would go on showing "Synced" on two different rows.

`{ v: 1, for, from, at, phase, absorbed, retired, checkedAt, conflicts, contested }`:

- `for`: a fingerprint of `R`'s row id (never the code or the secret). A record whose `for` is not the bucket in `st5:synckey` belongs to nothing: it is void, and removed when the engine next starts, when Settings › Sync is next opened, or at the next press of the button (a switch that failed half-way must not block the next try).
- `from`: `U`, which the device needs to ask about `P`.
- `phase`: `retiring` until step 5 has seen `P` hold a marker, then `retired`.
- `absorbed`: the token of the one plain payload merged at step 5. `retired`: `P`'s token when it was last seen holding a marker. `checkedAt`: when `P` was last asked. `conflicts`: how many compare-and-sets of the marker have conflicted in a row (kept here so a reload does not reset it). `contested`: step 5 found another device's marker; cleared when another private device joins `R`.

Its name matches the rule that already keeps `st5:synckey` out of the rescue export and the backup (it holds `U`). It is written only by the move, and removed by Disconnect, by "Remove from this device" and by a join. No release before this one reads or writes it. None of it is start-up code: the record is read by the lazy engine, and where its removal lives is the builder's choice within the byte budgets (the eager sync layer has 27 B left).

### 4.3 The move

One cycle kind inside the engine's single-flight loop. **It runs only under the sync Web Lock.** An ordinary cycle that is not granted the lock within 35 s runs without it (`withLock`), and a hide cycle never takes it; the move does neither: not granted, it stops with "Sync is busy in another tab. Try again in a moment."

1. The lockdown check of 4.1; a void record is removed. Then generate the secret and derive the keys. Nothing is stored and no code is shown yet.
2. Run an ordinary cycle on `P`. Offline, paused or failing: stop, nothing changed.
3. **Create `R` while the device is still plain.** Encode this device's copy as a private cycle does, seal it, `push(rowId, envelope, { base: null })`, then pull it back, open it and compare its digest with the digest of **what was sealed** (not of the local copy: an edit made in between would fail the comparison, and every retry leaves an orphan row and counts against the relay's creation caps, 20 rows an hour and 500 in all). This step acknowledges nothing and leaves the engine's token, revision, memo and repair bookkeeping alone: `mergeStep` and `landed` are not used for it. `full`, `too-large`, a conflict, offline or a failed read-back: stop. A crash here leaves one orphan ciphertext row and nothing else.
4. **Switch.** Re-read storage first: the config must still be plain `U` and not fenced, with no `st5:synckey` and no move record. Otherwise stop: another tab changed the sync, and this tab follows it at its next cycle (the row from step 3 is an orphan). Then, in this order:
   1. write the move record (`phase: retiring`);
   2. write `st5:synckey` and read it back. **This write is the switch**: by 3.2's reader rule the device is private from here;
   3. write the private config, and remove the `syncId` mirror.

   The running tab then takes the private bucket itself: the store's code, a new setup generation, the plain subscription stopped, the token slot, `held` and the remote-news flags (`news`, `merged`) cleared, and a subscription to the private topic opened. It does not call `setupSync`, which would queue behind the loop it is running in; the rest of the move's cycle runs on the new generation, where the cycle's own `gen !== setupGen` checks would otherwise end it. The code is shown only now, after the read-back. A crash after the first write leaves a void record on a plain device; after the second, a private device whose record resumes step 5.

5. **Retire `P`**, in the same lock grant, and again after every successful private cycle while `phase` is `retiring`. Never in a hide cycle. Pull `P`:
   - **This device's own marker** (`why: private`, `by` = this device: a lost answer, or a resumed move) → `phase: retired`.
   - **Any other marker** → `P` is retired already, by another device or by someone who forged a marker. One that is not a `private` marker is replaced with this device's by compare-and-set, so the other device is asked for a code and not just told to reload. `contested` is set when the marker names another device. **This device keeps its private bucket and its code**, and `phase` is `retired`. (Version 2 had it drop its bucket and wait for the other device's code. One forged marker then left every device asking for a code that no device held.)
   - **Missing** → create the marker (`base: null`), so the row cannot be re-created in plaintext.
   - **A plain payload, and nothing absorbed yet** → absorb it: merge it into this device and nothing more (no push to `P`, no token kept, no outbox entry acknowledged against `P`). Record `absorbed`, clear `held`, and **write the marker at once**, by compare-and-set on that same pull's token. Only then run a private cycle, so `R` carries what was absorbed; that cycle is a full one, never answered by a HEAD. `absorbed` is written to the record before the merge, not after: a record that cannot be written merges nothing, and a merge that then fails costs that one absorb. Either way a plain payload is merged at most once, which is the side to err on.
   - **A plain payload after one was absorbed** → write the marker by compare-and-set on this pull's token, without merging. What a device wrote there is still on that device, and arrives when it joins.
   - **Anything else** (garbage, an envelope, a newer copy) → write the marker by compare-and-set, without merging and without keeping a quarantine copy.

   A conflict ends the step, and the next private cycle resumes it. **After three conflicts in a row (counted in the record) the marker is written with force**: `P` is a plain row whose content every writer of it still holds, and a writer that keeps the row busy must not be able to keep it open.

   The marker is `movedMarker('private', now)` with `x5.moved.by` set to this device's id (extra fields are ignored by every reader and by the relay). It is announced on the plain topic with a fresh revision (a listener drops a revision it has already merged), so the other device learns at once.

6. While `phase` is `retiring`, Settings › Sync says "Closing the old sync…". A step 5 that could not finish is not a sync failure: the private cycle's result stands, and the line becomes "The old sync is not closed yet. This device keeps trying."

### 4.4 Keeping the old row retired

The record stays for as long as the device is on `R`, and the mover goes on asking about `P`:

- after every private cycle (never a hide cycle) while **no other private device has joined**: no entry of `R`'s registry with another id and `e2e: true`. `R` starts with the plain bucket's registry, so the other device is listed there from the first write, as a plain one: its being listed means nothing. Until it has joined it is the device that could be led back to plaintext, so the row is watched closely. After seven days of this the check is daily: an owner with one device must not ask about `P` at every poll for good;
- otherwise at start-up, and at the first cycle 24 hours after `checkedAt`.

The close check is a HEAD of `P`: a token equal to `retired` ends it. The daily check always pulls, whatever the token says. What a pull finds: its own marker (store the token), another marker (as in step 5), missing (re-create the marker), or anything else: write the marker by compare-and-set on that pull, with force after three conflicts, **without merging what was found and without keeping a copy of it**, and say in Settings › Sync "Something was written to the old sync after it was closed. If a device of yours is still on it, update it and enter this sync code there." (Anyone who knows `U` can cause that line with one write, so it does not say a device of the owner's did it.) What a straggler wrote to `P` is still on that device and is merged when it joins.

A token is trusted only for the close check, and only because the lockdown is a condition of the move (4.1): the relay's functions issue the tokens. Should the lockdown be rolled back later, the daily pull still reads the content. There is no end date: a marker that disappears lets a device that never saw it re-create `P` in plaintext whenever that happens. **The check runs only while the mover is open.** A marker written over while it is closed stays written over until it is opened again, unless the relay refuses the write (4.6).

### 4.5 What the owner sees

- **The question.** "Make sync private?" says what happens in the owner's terms: this device makes a new, encrypted synced copy and closes the old one; the other device stops syncing until the new sync code is entered there; what the old sync held was readable on the server until now, and that is not undone. It shows how old the last backup export is, with Export beside it.
- **After the switch**, the code, and for as long as no other private device has joined (4.4): "Next: enter this code on your other device. It stops syncing until you do." (The same line serves a private sync that Generate just started.)
- **The other device** pulls the marker, persists the fence (3.7) and asks for the code. Joining is 3.5 with its own entries kept and merged. A "Delete everywhere" pressed while fenced is carried out everywhere at the join; the join preview says how many entries this device will delete on the others (a new count: today's preview counts only what the relay's copy deletes here).
- **Contested** (both devices moved, or a marker was forged): "Another device may also have made this sync private. If your other device asks for a sync code, enter this one there. Only if it shows a code of its own: Disconnect one of them, then enter the other's code there. Your entries stay on each device and are merged." The order matters: a forged marker leaves the other device asking for a code and holding none, and an instruction that began with Disconnect would have the owner throw away the only code. Nothing is lost either way. The notice goes when another private device joins this bucket.
- **Disconnect or "Remove from this device" while `retiring`**: the question adds "The old sync is not closed yet. A device still on it keeps syncing there, unencrypted." While no other private device has joined, at any phase, it adds "No other device has this sync code yet. Copy it first: a device waiting for it cannot join without it."

### 4.6 The relay

Release 2 is correct against the relay as it is after 005. Two things are left to the client there, and both are covered by 4.4:

- **A forced write replaces a marker.** `st_sync_push` with `p_force` overwrites a row whatever it holds, a plain cycle of release 1 forces on its fourth attempt, and anyone who knows `U` can call it (`U` could be listed by anyone until 005, so it is treated as known). A device that has not yet pulled the marker would then sync on `P` in plaintext until the mover's next check, and that check runs only while the mover is open.
- **The prune function** (rows untouched for 90 days) removes a marker like any other row.

**Recommended, and the owner's decision (section 9): migration 006, a sticky marker.** `st_sync_push` refuses to replace a moved marker with anything but a moved marker (a marker still replaces a plain payload or another marker, forced or not, so step 5's force lands), answering `conflict` (a device then pulls, finds the marker and fences, as every release that uses the sync functions does on a conflict: 0.11.0 and later, read at the tags), and the prune function keeps a moved row four times as long as a plain one. Not for ever: anyone with the public key can create marker rows, and markers that were never pruned could fill the relay's 500 rows for good. It guards only writes that go through the sync functions, which is every write once 005 is applied. With it the retirement is the relay's own rule and 4.4 is a second line. The client cannot detect it and does not depend on it; the tests run against a relay with and without it. It is written (`supabase/migrations/006_sync_sticky_marker.sql`, its rollback, and `supabase/checks/006_verify.sql`) and proved as 004 and 005 were (real Postgres with the Supabase roles, the released transport and the engine run against it; an independent migration-safety review, safe with notes, taken) and applied by the owner with 005 or before gate D.

## 5. Failure matrix

| Event                                                                                                                  | Result                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A private row is replaced with garbage, a tampered envelope, plaintext, or a plaintext marker                          | `invalid`: one copy quarantined, never merged, repaired from a device's own copy.                                                                                                                    |
| An envelope with a forged "newer" header                                                                               | Pause `update-required`; the owner can replace the copy (3.9).                                                                                                                                       |
| An older valid envelope is put back                                                                                    | It opens; merging it changes nothing; the device then writes its current state.                                                                                                                      |
| A private device loses `st5:sync` (an older build wrote over it, a quota error)                                        | Restored from `st5:synckey` at the next start.                                                                                                                                                       |
| Two tabs, one changes the bucket                                                                                       | The other re-reads the config at its next cycle and follows.                                                                                                                                         |
| The code is lost on every device                                                                                       | The relay copy cannot be read by anyone. Each device still holds its data; a new sync starts from it. Said in the Disconnect question.                                                               |
| (R2) Crash before the switch (step 4, second write)                                                                    | Still a plain bucket. At most an orphan ciphertext row and a void move record, removed at the next start.                                                                                            |
| (R2) Crash after the switch                                                                                            | Private, with a record in `retiring`: the next private cycle resumes step 5. `P` is live until then.                                                                                                 |
| (R2) A start-up, another tab, or a tab still on 0.21.0 rewrites the sync config                                        | The move's record is in its own key and is not touched (4.2).                                                                                                                                        |
| (R2) The other device writes `P` before the marker                                                                     | Absorbed once at step 5 and carried into `R`; a later write is not merged and arrives when that device joins.                                                                                        |
| (R2) A device writes `P` over the marker (an in-flight forced write, a straggler after a prune, someone who knows `U`) | The mover retires `P` again without merging: at its next cycle until the other device has joined, within a day after (4.4), while the mover is open. With migration 006 the relay refuses the write. |
| (R2) A writer keeps `P` busy                                                                                           | The marker is forced after three conflicts.                                                                                                                                                          |
| (R2) Both devices move at once, or a marker is forged                                                                  | Each device keeps its private bucket and its code; the owner uses one code on both (4.5). Nothing is lost.                                                                                           |
| (R2) The move is pressed in two tabs                                                                                   | One runs under the lock; the other is refused, or stops at the re-read of step 4. One code.                                                                                                          |
| (R2) The relay refuses a new row                                                                                       | The move stops at step 3 with nothing changed.                                                                                                                                                       |
| (R2) The relay still answers the table (005 not applied)                                                               | The move stops at step 1 with nothing changed.                                                                                                                                                       |

## 6. Compatibility

| Device                       | Meets                                     | Does                                                                                                                                    |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Release 1 or later           | a plain row                               | Syncs as today.                                                                                                                         |
| Release 1 or later           | a marker on its plain row                 | Fences durably; `private` asks for the code.                                                                                            |
| Release 1 or later           | its private row                           | Syncs encrypted.                                                                                                                        |
| 0.11.0 to 0.20.0             | a marker on its plain row                 | Pauses "moved": reload to update. Not durable: section 4.3 covers it.                                                                   |
| any version before release 1 | a typed `ST5` code                        | Join refuses it.                                                                                                                        |
| 0.11.0 to 0.20.0             | storage of a private device (a downgrade) | "Set up by a newer SpendTrack": does not sync. `st5:synckey` is untouched.                                                              |
| 0.10.0                       | storage of a private device               | Quarantines the config (which holds no code), reads as unlinked, and may be linked again there; back on release 1 the private key wins. |
| 0.21.0 (a tab left open)     | storage of a device that moved            | Follows the saved private setup at its next cycle. Does not know the move's record and does not touch it.                               |
| 0.8.x, 0.9.x                 | a marker                                  | 0.8.4 and older stop on it before any push; 0.8.5 and 0.9.x pause.                                                                      |

## 7. Acceptance criteria, release 1

Each is a test at the level named. Unit tests run the real engine against the fake relay (`src/__tests__/fakeRelay.ts`, which already holds many rows and has a `beforeWrite` hook).

- **AC-P1.** A private cycle round-trips between two devices through a relay that holds only `{st,k,r,iv,z,ct}`. No entry's name, amount, category or note is in any row, topic or request.
- **AC-P2.** Every request of a private bucket (the probe with `auto` and no hint, head, pull, push, the join preview), every channel name and every persisted `meta.sync` value carries the derived row id or topic. None contains the code or the secret.
- **AC-P3.** An edit made while `open` or `seal` is pending is neither lost nor acked early. A bucket change (Disconnect, another tab) while either is pending stops the cycle without a write.
- **AC-P4.** A flipped ciphertext bit, a swapped `r`, an envelope copied from another row, a plaintext v5 payload, a plaintext marker, an empty object, and an inner payload whose revision differs from `r`: each is never merged, never kept, and repaired. An injected plaintext entry never appears on a device.
- **AC-P5.** An older valid envelope put back loses nothing and converges.
- **AC-P6.** A newer envelope (`st` 6, `k` 2) pauses `update-required`, is not overwritten by any cycle, is not re-opened by the next poll, and is replaced only by the owner's action (3.9).
- **AC-P7.** A private bucket is never force-written by a cycle: six conflicts end the cycle busy.
- **AC-P8.** The seal wrapper: two seals of the same payload differ in `iv` and `ct`; its IV never comes from the engine's generator.
- **AC-P9.** Storage: a private device has no `syncId` and no code in `st5:sync`; Disconnect and "Remove from this device" leave no code in any key, quarantine keys included; the rescue export holds none; `keepPrevious` ignores an `ST5` code.
- **AC-P10.** The reader rule: with `st5:synckey` present, a stray `syncId`, a missing `st5:sync` and an overwritten plain `st5:sync` each start up private, and the plain writer refuses.
- **AC-P11.** The local engine records the outbox for a private bucket: an edit made offline is pending, and is sent.
- **AC-P12.** Join: each failure of 3.5 shows its message and changes nothing; a valid code shows the preview before any merge; establishing needs an authenticated open.
- **AC-P13.** Generate creates a private bucket whose first push creates the row; a second device joins it and both converge.
- **AC-P14.** The durable fence: a plain device that pulls a `private` marker persists it, pauses `moved-private`, keeps recording edits, and never touches the row again when the marker is afterwards replaced by plaintext or the row is deleted. Going offline and back keeps the state. Joining a private code clears it and merges its edits.
- **AC-P15.** Size: a defined fixture at the plaintext limit seals to an accepted envelope with gzip, and pauses `too-large` without it (never throws, never truncates).
- **AC-P16.** The upsert transport: a private bucket pauses `no-cas` and writes nothing.
- **AC-P17 (two real browsers, `e2e:data`).** Device A generates a private sync; device B joins with the typed code; edits flow both ways; the relay's log shows only envelopes on a derived row id. Run on Chromium and iPhone WebKit.
- **AC-P18 (`e2e:data`, mixed versions).** The real 0.20.0 build refuses the typed private code, and shows "set up by a newer SpendTrack" on a private device's storage without touching `st5:synckey`.
- **AC-P19 (browser).** The new screens pass axe in both themes and both sizes, and fit at 320 px.

Not extended: the seeded simulator. It models the merge, which a private bucket does not change; its clock cannot drive WebCrypto. Private behaviour is tested on the real engine.

Release 2's criteria are in 7b.

## 7b. Acceptance criteria, release 2

Unit tests run the real engine against the fake relay (`ghost`, `hang`, `beforeWrite`, `seedRow`, `dropRow`, `writeAsOther`, offline clients; another tab is a write to the device's storage, as in `sync.private.test.ts`). The fake relay already models the lockdown (every table call refused) and the tests already fake the Web Lock (`freeze`, `refuse`); the relay gains an option for migration 006. The table transport's head needs an export from `syncService.ts`, a lazy module.

- **AC-M1.** A crash (a reload of the device) after every write of steps 3 to 5 ends with exactly one live private row, `P` holding this device's marker, and both devices converged after the join.
- **AC-M2.** The move's record survives a reload, a setup of the same code, another tab following, and a writer that behaves as 0.21.0 does (`savePrivateSync`). It is void and removed when `st5:synckey` is missing or names another bucket.
- **AC-M3.** A lost answer at step 3 leaves the device plain with one orphan row; at step 5 it resolves through the device's own marker.
- **AC-M4.** The other device writes `P` before the absorb (absorbed, and carried into `R`), between the absorb and the marker (not merged; arrives at its join), and over the marker (retired again without merging; arrives at its join).
- **AC-M5.** An edit made during each of steps 2 to 5 reaches `R`. Nothing is acknowledged against the wrong row. The cycle after an absorb is never answered by a HEAD.
- **AC-M6.** Both devices move: each keeps its private bucket, the one that finds the other's marker shows the contested notice, `P` holds a marker, and after Disconnect and a join on one of them both hold every entry.
- **AC-M7.** A forged marker met at step 5 (another `by`; another `why`; no `by`): the private key is kept, a marker that is not `private` is replaced, and no device is left asking for a code that none holds. The contested notice tells the owner to enter this device's code where one is asked for before it mentions Disconnect, and goes when another private device joins.
- **AC-M8.** The move in two tabs: one not granted the lock is refused and writes nothing; one whose re-read at step 4 finds a changed setup stops; `st5:synckey` is written once; no code is shown before the read-back. A void record left by a switch that failed does not block the next press.
- **AC-M9.** A writer that keeps `P` busy: the marker lands by force within three conflicts. One plain payload is merged, a second is not, and an invalid one leaves no quarantine copy.
- **AC-M10.** `P` pruned during or after the move gets its marker back. A fenced device of release 1 never re-creates `P`.
- **AC-M11.** A "Delete everywhere" and a single delete, on either device, before, during and after the move: the deletions hold after the join, and the join preview's count of what this device will delete on the others is right.
- **AC-M12.** The offer: refused for a recent registry row below release 1, in table mode or never seen, for an older writer seen within 60 days, without Web Locks, on a transport without compare-and-set, and on a bucket that is paused, fenced or not established. A table that answers the head of `P` stops the move before any write.
- **AC-M13.** The check of 4.4, with `R`'s registry as a real move leaves it (the other device's plain-era entry in it): it runs after every private cycle until another device with `e2e: true` appears or seven days pass, and daily after; never in a hide cycle. At the close check an equal token costs no pull; the daily check pulls whatever the token says. Plaintext found over the marker is neither merged nor kept, the marker is written again, and Settings says so.
- **AC-M14.** Storage after the move: the private code only in `st5:synckey`, `U` only in the move's record, no `syncId` mirror; neither is in the rescue export or the backup; Disconnect, "Remove from this device" and a join remove the record, and a void one is removed when the engine starts, when Settings › Sync opens and at the next press.
- **AC-M15.** With migration 006: a forced plain write over the marker is answered `conflict` and a device of 0.21.0 fences; a marker may replace a marker, and a plain payload, forced or not; prune keeps a moved row four times as long as a plain one. The SQL is proved on real Postgres with the released transports, as 004 and 005 were.
- **AC-M16 (two real browsers, `e2e:data`, Chromium and iPhone WebKit).** One device moves; the other, on the real 0.21.0 build, fences and joins with the typed code; edits flow both ways; the relay's log shows a marker on `P` and only envelopes after it, on a derived row id.
- **AC-M17 (`e2e:data`, mixed versions).** The real 0.20.0 build meets the marker, pauses, and never writes `P`.
- **AC-M18 (browser).** The new states (the question, closing the old sync, the next-step line, contested, the straggler notice) pass axe in both themes and both sizes, and fit at 320 px.
- **AC-M19.** After the switch the tab is subscribed to the private topic, and a Broadcast from the other device starts a cycle. The next-step line shows until another private device joins, and not after.
- **Mutations.** Each of these known-bad changes must fail a test: the record kept in `st5:sync`; the move run without the lock; the key written without the re-read; the lockdown check skipped; a second absorb; the marker written after the private cycle and not before; the marker never forced, or forced before three conflicts; the post-absorb cycle answered by a HEAD; a record whose `for` does not match acted on; a merge in 4.4; the check of 4.4 counting every registry entry and not the private ones, or stopping for good once a second device appears; the foreign-marker branch dropping the key.

## 8. Rollout

1. **Release 1 (0.21.0).** Both devices update. Nothing changes for the owner's bucket.
2. **Gate E (005)**, when Settings › Sync says ready, as planned. **It must come before gate D**: the move refuses to run while the relay still answers the table (4.1). After it the public key can no longer list or write the table, and the retiring update is no longer broadcast to row-event listeners. Migration 006 (4.6), if the owner takes it, is applied with it or at any time before gate D.
3. **Release 2**, then **gate D, the owner's**: after a backup export, "Make sync private" on one device and the code on the other. The lead verifies from the owner's reading of Settings › Sync (the relay's registry is ciphertext from then on).
4. The manual way that needs no release 2: Disconnect on both devices, Generate on one, Join on the other. Nothing is lost (each device keeps its entries and a join merges). The old plain row stays on the relay until it is deleted by hand.

## 9. Decisions for the owner (none blocks the build)

- **Migration 006, a sticky marker (4.6): taken by the owner on 15 Nov.** The files are in the repository; he applies them at gate E. One more SQL file to apply, beside 005. It replaces the function every write goes through, so it is proved before it is offered, as 004 and 005 were. Without it release 2 still works, with one gap said plainly: the device that moved keeps the old row closed only while it is open. If someone who knows the old code writes over the marker while that device is closed, a device that has not yet entered the new code syncs unencrypted on the old row until the mover is opened again.
- A QR code or pairing link for the second device needs a QR encoder (a new runtime dependency) or a link with the code in a URL fragment. The typed code works without either. Not built unless asked for.
- The content security policy allows `https://*.supabase.co`. Pinning it to the one project would stop a script flaw sending data to another project, and would hard-code the project in a public repository. Left as it is.

## 10. Review record

Version 1 (one release; the device flipped to private first, then created its row, then retired the plain row) was reviewed on 15 Nov 2026 by two independent read-only reviewers before any code. Both verdicts: **fail as written; the codec and the private cycle are sound; the move is not.**

- **A. The marker is not a durable fence** (both reviewers, blocker). A device that met it only paused. A forced write (the fourth attempt skips the token check), the upsert transport, or a prune followed by a re-create would put plaintext back with nobody noticing. Taken: 3.7 (persisted fence), 4.3 (the mover keeps the row retired), 4.1 (compare-and-set transports only), 3.3 (a private row is never force-written).
- **B. Crash-resume stranded the mover** (correctness, blocker). The flip saved an unestablished private config, which every entry point refuses to create a row for; start-up rewrote the config as plain; the etag of the plain row did not survive; the mover could not tell its own marker from the other device's. Taken: the row is created before the flip (4.2 step 3), `moving` drives the resume, the marker carries `by`.
- **C. The config had other writers** (security, major; correctness, major). A mirror that differs wins today, and the plain writer overwrites any config. Taken: 3.2 (the code in its own key, the reader rule).
- **D. Unauthenticated states that stick** (both, major). A forged "newer" header or a plaintext marker in a private row would stop it for good. Taken: 3.3 (a plaintext marker in a private row is invalid) and 3.9.
- **E. Overclaims** (security, major). "Only a device with this code can read it" was false of everything already on the relay; remnants and metadata were not named. Taken: section 1 and the screen line in 3.8.
- **F. The retire loop merged attacker-writable plaintext without bound** (security, major). Taken: absorb once (4.2 step 5).
- **G. The move had no place in the engine's single-flight, lock and tab model** (correctness, major). Taken: 4.2's first paragraph and 3.2's "followed".
- **H. Both devices moving ended in two buckets** (correctness, major). Taken: the loser fences (4.2 step 5).
- **I. Other takers of "the code" were missing**, among them the local engine's "is sync on", which would have stopped the outbox for a private device (correctness, major). Taken: 3.1, AC-P11.
- **J. Split the track** (correctness). Taken: release 1 carries the cycle, the join and the fence; release 2 carries the move.
- Smaller points taken: the IV wrapper, one quarantined copy, revision equality of the inner payload, `range` among the join failures, the binding size limit, `needsReload`, the 60-day constant, 0.10.0's handling of an unknown config.
- Checked and not a finding: the 7 Nov backup copy is in a private schema with row security on and no grants to the API roles (read-only catalog query, 15 Nov).

### As built (release 1, 0.21.0)

Where the build differs from the text first reviewed, and why. Each is reflected in the sections above.

- **An unreadable private copy is not kept in quarantine** (3.3, AC-P4). Version 2 kept one raw copy. A copy that does not open under the bucket's key can be read by no device that holds the code: keeping it gives the owner nothing to recover and gives anyone who can write the row a way to put bytes in a device's storage.
- **No "Private" badge** (3.8): one sentence under the code says it.
- **The join's "cannot be read" line is the plain join's** (3.5).
- **Generate follows the build** (3.6, 3.8): private where `privateSyncReady`, plain elsewhere, so a relay that can only upsert never gets a private row it would then refuse to write (`no-cas`).
- **Replace is a cycle, not a separate writer** (3.9): it shares the lock, the compare-and-set and the conflict handling with every other write of a private row.
- **Tests.** AC-P1 to P9 and P12 to P16 on the real engine against the fake relay (`src/stores/__tests__/sync.private.test.ts`); P10 in `src/services/storage.test.ts`; P11 in `src/data/local/__tests__/syncSeams.test.ts`; P17 to P19 and 3.9 in real browsers on Chromium and iPhone WebKit, P18 beside a build of the v0.20.0 tag (`e2e/data-engine/private.data.ts`).

### Code reviews of the built branch (15 Nov)

Three independent read-only reviews before the PR: security (verdict fail, on one major finding), sync correctness (pass with notes, the same major finding), and the interface (one blocker).

- **A setup changed in another tab was not followed** (both code reviews, major). 3.2 asked for it and the first build did not do it: a tab left on a plain code kept pushing, in plaintext, what the device added after another tab made it private; a fenced tab stopped being fenced once another tab joined the private code. Taken: every cycle asks storage first and again right before its write (`changedElsewhere`, `followSaved`), and no channel is opened for a setup that changed. Tests on the real engine; mutations P8 and P10.
- **A plain cycle waited for the realtime topic** (correctness, minor regression): without SubtleCrypto a plain sync paused `not-found`, and the failed derivation was cached. Taken: the topic is a promise only realtime awaits, and a failed derivation is not kept.
- **A fenced device kept its channel** (correctness, minor). Taken: the fence closes it.
- **The size refusal was judged on the inner payload** (both, minor). Taken: on what was sent.
- **The replace flag could be seen by a cycle of another setup, and answered with two toasts** (both, nits). Taken: tied to the setup generation; the repair toast is left to the panel.
- **Overclaims** (security, interface): the not-linked intro spoke for every sync on a screen that also joins plain ones; Backup's line lacked "from now on"; the changelog's headline lacked its condition; the guide lacked two limits. Taken.
- **Interface**: one noun for the code ("sync code"), the fenced device hides its dead code and says where Disconnect is, the confirm says the loss in the owner's terms, Replace has its own icon, and focus goes to Sync now when the pause ends under the question. Declined, with reasons: a narrower button on desktop (every action in this panel is full width), "from now on" dropped from the line under the code (the security review asked for the opposite, and release 2 needs it), one verb for "enter" and "join" (the plain strings are 0.20.0's, and both verbs are natural).
- **Test gaps closed**: AC-P3's second half (another tab), AC-P6 (the polls after a newer pause are HEADs; mutation P9), AC-P14 (the channel closes).
- **Recorded, not changed**:
  - Content that opens under the key but is not a valid payload of this format is quarantined as a plain bucket's is: only a holder of the code can produce it, and it can be read. "No copy is kept" (3.3) is about what does not open.
  - Replace repairs a copy whose header is marked newer. A copy that opens and was written by a newer SpendTrack is merged and never written over: the pause stays, and Reload is the way.
  - A cycle that starts as the page is hidden awaits `open` and `seal` before its request, so it may not get out before the page freezes. The change stays in the outbox.
  - An older build's Disconnect on a private device's storage (0.11.0 to 0.20.0 offer one on the "newer SpendTrack" view) removes what that build knows of, not `st5:synckey`: release 1 is private again at its next load. Nothing is lost or exposed; the owner's Disconnect there is undone.
  - A damaged `st5:synckey` beside an intact `st5:sync` marker reads as "set up by a newer SpendTrack", with Disconnect as the way out.

### Second review of release 2 (15 Nov, after 0.21.0 shipped)

Section 4 (version 2) was reviewed again before any of it was built, by two independent read-only reviewers, against the released code. Both verdicts: **fail as written, on the same blocker; the outline (create first, then switch, then retire; absorb once; one marker) is sound.** Section 4 is version 3 because of them.

- **The move's state was kept where the shipped code erases it** (both, blocker). `moving` and `retired` were to live in `st5:sync`. Every setup of release 1 rewrites that key and `st5:synckey` with no other fields, at each start-up and in each tab that follows a changed setup. The old row would never have been retired: the mover on its private row, the other device on the plain one, both saying "Synced", the other device's new entries still going up in plaintext. Taken: 4.2, a key of its own that no shipped writer touches.
- **The lock did not make the move single** (both; major and minor). A cycle not granted the lock in 35 s runs without it, and a hide cycle never takes it: two tabs could each make a secret, and the owner could type the one storage no longer held. Taken: 4.3 (lock or nothing; the re-read before the switch; no code shown before the read-back).
- **A forged marker made the mover destroy its own bucket** (security, major). Any marker naming another device made it drop its key and wait for a code; with a forged one, no device had a code. Taken: 4.3 step 5, a device never gives up its private bucket; both-moved and forged are one case the owner settles with one code (4.5). The loser's way back to plain, with its three writes that could crash apart, is gone with it.
- **Nothing bounded how long the old row could be kept open, or stopped a marker being written over** (security, major). Taken: force after three conflicts; the close watch of 4.4 until the other device joins; migration 006 offered as the relay's own rule (4.6). "No migration is needed" stays true and is no longer the whole of it.
- **Gate E before gate D was a "should"** (security, major). Before the lockdown, tokens are the writer's own choice, the caps do not hold, and the table's row events time the move for an observer. Taken: 4.1, the move asks the table and refuses to run where it answers; 4.4 trusts a token only because of it.
- **Overclaims** (security, major). The line under the code said "from now on" while the other device had not joined, and section 1 said nothing unauthenticated is ever merged, which the absorb is the one exception to. Taken: 4.5's next-step line and section 1.
- **The absorb window was a whole private cycle wide** (correctness, minor). Taken: absorb, then the marker at once, then the private cycle.
- **A HEAD could answer the cycle after an absorb** (correctness, minor): a merge from the relay changes neither the local revision nor the outbox. Taken: the absorb clears `held`.
- **The read-back compared with the local copy** (correctness, minor), so an edit made in between failed the move and left an orphan each time. Taken: compared with what was sealed; step 3 uses none of the cycle's bookkeeping.
- **The daily check had no token to compare and no timer** (correctness, minor). Taken: the record holds `retired` and `checkedAt`; "daily" is the first cycle 24 hours on. The 60-day end is dropped.
- **Disconnect during the move said nothing** (correctness, minor). Taken: 4.5.
- **The join preview's second count does not exist yet** (correctness, minor). Recorded in 4.5 as new work.
- **Smaller points taken**: where `by` sits (`x5.moved.by`), a fresh revision for the marker's announcement, no quarantine copy at step 5, rows never seen count against the offer, the offer hidden on a paused, fenced or unestablished bucket, the metadata list in section 1.
- **For the builder** (correctness): the move, its record and the check of 4.4 belong in the lazy engine or a module only it imports, reached as Generate and Replace are (`loadSyncEngine()`); nothing goes in `useSyncStore.ts`. Reusable as they are: the transport, `bucketFor`, the seal and open wrappers, `encodeWire`, `decodeWire` with `applyRemote`, `movedMarker`, `announce`, `setFenced`, `changedElsewhere` and `followSaved`, the registry's rows and version compare. Not for the move: `mergeStep` and `landed`.
- **Not verified by the reviewers, to settle while building**: whether a backup restore rewrites the engine's sync metadata; whether the fake relay can run two engines on one storage; the real headroom under the eager budget; how the fake relay models a forced write.

**Confirmation of version 3** (the same two reviewers, the same day): both pass with notes, all taken above.

- **The contested notice led with Disconnect** (security, major). A forged marker leaves the other device asking for a code and holding none; told to "Disconnect one of them", the owner could throw away the only code. Taken: 4.5's order, and its warning on Disconnect while no other private device has joined.
- **"The only device in the registry" was false from the first write** (correctness, major). The private row starts with the plain bucket's registry, which lists the other device already. The close watch would never have run. Taken: 4.4 counts only another device that has written as a private one (`e2e: true`).
- **Without migration 006 the old row is guarded only while the mover is open** (security). Said plainly in 4.4, 4.6 and section 9.
- **The lockdown check** (both): only the permission refusal counts, it asks about a row id no bucket uses so `U` stays out of the logs, and a refused read does not prove refused writes (recorded, not checked). The daily check pulls whatever the token says, so a lockdown rolled back later does not blind it.
- **Smaller points taken**: the close watch ends after seven days alone; the straggler line no longer says a device of the owner's wrote; a void record is removed at the next press; the conflict count is in the record; `contested` clears when another private device joins; what taking the private bucket without `setupSync` must also do; no hide cycle and no kept copy in 4.4; 006 lets a marker replace a plain payload, forced or not; the fake relay already models the lockdown and the lock.

### As built (release 2, the engine; 15 Nov)

Built from section 4 as an engine slice with no screen, then reviewed in code by the same two reviewers (security; sync correctness): both pass with notes, all taken. Where the build differs from the text above, and why:

- **"Another private device has joined" is evidence, not a registry entry** (security, major). The private row starts with the plain row's registry, and a plain payload may claim `e2e` for any device: someone who knew the old code could plant a joined-looking device before the move and switch off the next-step line, the warning on Disconnect and the close watch. The record gains `joined`, set only when this device opens a copy on the private row that another device wrote. Without a record (a sync that Generate started) the registry is still read: no plain payload was ever merged there.
- **`absorbed` is recorded before the merge** (security, minor): 4.3 above.
- **Step 5 and the keeping check run only when the lock was granted** (correctness, minor). An ordinary cycle runs unlocked after 35 s; it then does neither.
- **A move that is refused or stops early answers only the press** (correctness, minor). Every other request coalesced into that turn of the loop gets a real cycle.
- **A void sweep spares a record less than two minutes old on a device that holds no key** (correctness, minor): another tab's sweep could otherwise remove the record between the switch's two writes. The press itself (under the lock) and Disconnect remove it whatever its age.
- **A record that cannot be re-written after the switch is said plainly** (security, nit): "This device couldn't save its note of the move, so it stops closing the old sync when SpendTrack closes. Free up space on this device."
- **The offer does not count this device's own registry entry.**
- **AC-M6 follows 4.3**: only the device that finds the other's marker is contested; the one whose marker landed first never sees the other's.
- **Tests.** AC-M1 to M15, M13b (the forged join) and M19's engine half on the real engine against the fake relay (`src/stores/__tests__/sync.move.test.ts`), the sweep race in `src/data/sync/move.sweep.test.ts`, the offer in `offer.test.ts`. Twenty new mutation entries (R1 to R20). Still to build: the screens of 4.5, and AC-M16 to M18 in real browsers.
