# Private sync (PR-6): spec

Status: version 2, 15 Nov 2026. Version 1 was failed by two independent reviews (security; sync correctness) before any code was written: section 10 records what they found. This version splits the track into two releases and replaces the move's protocol.

Track T2's last piece ("end-to-end encryption with hashed row ids"). Written from the code as it stands at v0.20.0: the data-engine spec the source cites (`DATA-ENGINE-SPEC §10, §11, §13`) is not in this repository, so this document restates what the code froze and specifies what is still to build.

## 1. What this is for, and what it is not

Today a synced bucket is one row of `public.sync_buckets`, in plaintext, under a row id that is the sync code itself. Whoever can read the table can read every entry, and whoever can read a row id holds the code that writes it. Migration 005 (gate E) closes the table to the public key; it does not change what the database, its operator, its backups or a leaked service key can read.

A private bucket's row holds only ciphertext, under a row id that is not the code. **From the moment a bucket is private, what a device sends is encrypted on that device first**, and a change made on the relay by anyone without the code is detected and never merged.

What it does not do, said here so no screen overclaims:

- **It does not un-publish the past.** Everything a plain bucket held before it was made private sat readable on the relay. Private sync protects what is written afterwards.
- **Remnants of old plaintext outlive the switch**: dead rows and write-ahead log in the database (before 005 the table's replica identity is FULL, so the update that retires a row logs the whole old row), the provider's own backups, API logs that hold `sync_id=eq.<code>` for table-transport requests, the 7 Nov backup copy (in a private schema with no API grants; dropped after gate E), and unreadable-copy quarantine keys (`st5:q:relay:*`) on a device.
- **A compromised device is out of scope**: the code and the data are in its storage. So is whoever serves the JavaScript (the hosting account, the build, a dependency), and the clipboard a code is copied through.
- **Metadata is visible to the relay**: row sizes and their change per write, write times, IP addresses and user agents, the device ids in Broadcast messages, the revision and the compression flag of each envelope, and the link between a plain row and the private row that replaced it (creation time, same devices).
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
   - **everything else is `invalid`**: a failed authentication, a wrong shape, a plaintext v5 payload, a plaintext moved marker, an inner payload of any other writer class or with another revision. It is never merged. One raw copy is kept in quarantine (the newest replaces the last: unreadable copies must not fill storage), and the row is repaired from this device's copy under the gate that paces plaintext repairs today;
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
- no row for the code → "No private sync was found for that code.";
- a row that does not open → "That private sync cannot be read with this code." Nothing is joined.

The code field turns off auto-capitalise, auto-correct and spell-check. A join never sends the code anywhere: only the derived row id leaves the device.

### 3.6 Starting a new sync

"Generate" creates a private bucket: 16 bytes from `crypto.getRandomValues`, the `ST5` code, `st5:synckey`, and a first sealed push that creates the row. A device on an older version that is given the code says so by the message it has today. Joining an existing plain UUID code keeps working.

### 3.7 The durable fence

A device on this release that pulls a moved marker from its **plain** bucket writes `fenced: { why, at }` into its plain config before it pauses. While `fenced` is set that device never pulls, pushes or re-creates that row, whatever the row holds later, a missing row included. Only joining another code or Disconnect clears it. Its entries, its outbox and its snapshots are untouched.

- `why: private` pauses `moved-private`: "Sync was made private on your other device. Enter the private code shown there." Settings › Sync shows the code field in place. It is not a reload state (`needsReload` is false for it) and going offline does not replace it.
- any other `why` keeps today's `moved` wording, now durable.

Nothing in release 1 writes a marker. The fence ships first so that every device is already safe when release 2 does.

### 3.8 On screen

- Settings › Sync, private bucket: the code masked as today (`••••-…-XXXX`), Show and Copy as today; "Private" on the status row; the line under it reads "What this device sends is encrypted here first. Only a device with this code can read the synced copy from now on."
- Settings › Sync, plain bucket: the existing "isn't encrypted yet" line stays (release 2 adds the action).
- Backup panel: its sentence follows the bucket's kind.
- The sync pill: `moved-private` reads "Enter private code" and opens Settings › Sync.
- Device list: unchanged ("This device", "Other device").

### 3.9 The owner's ways out

- **A private row this device cannot read as current** (`update-required` on a private bucket, while no newer build is waiting): Settings › Sync offers "Replace the synced copy with this device's". Confirmed, it seals this device's copy and writes it by compare-and-set on the etag last pulled. This is the repair for a forged or damaged header.
- **Fenced with no code to enter**: the same panel says "No code? Disconnect, then start a new sync: your entries stay on this device."

## 4. Release 2: making an existing bucket private (gate D)

Specified here as corrected by the reviews; **it is reviewed again before it is built**, after release 1 has shipped and run.

### 4.1 When it is offered

On a device whose plain bucket is established, when:

- this device's transport is compare-and-set (RPC, or CAS on), and every device in the registry that pushed in the last 60 days (`STALE_AFTER_MS`) reports the RPC mode and a version that has release 1;
- no older writer has been seen recently (`legacySeen`).

The registry is read from the plain row and can be forged by anyone who can write it; the gate is a guard against the owner's own mistake, not a security boundary. A device that only reads looks stale to it; the question says a device that has not synced lately will have to update and enter the code.

### 4.2 The move

It runs as one cycle kind inside the engine's single-flight loop, under the sync Web Lock, with the bucket's plain code `U` and row `P`. The button re-reads the persisted config under the lock (a second tab cannot start a second move).

1. Generate the secret; derive the keys.
2. Run a cycle on `P`. Offline or failing: stop, nothing changed.
3. **Create the private row while the device is still plain**: seal this device's copy, `push(rowId, envelope, { base: null })`, then pull it back, open it and compare its digest with the local one. `full` (the relay's creation caps: 20 rows an hour, 500 in all, RPC only), `too-large`, offline, or a failed read-back: stop. A crash here leaves one orphan ciphertext row and nothing else.
4. **Switch**: write `st5:synckey`, read it back; write the private config with `moving: { from: U, at }`; remove the `syncId` mirror. Bump the engine's generation, stop the plain subscription. From here the device is private, and `moving` means: after each successful private cycle, run step 5.
5. **Retire `P`**: pull `P`.
   - It holds this device's own marker (`by` = this device id: a lost answer, or a resumed move) → done.
   - It holds another device's marker → that device moved first: this device drops its unfinished private bucket (key and config), returns to the plain config for `U` in the fenced state, and shows the ordinary `moved-private` prompt. One winner; the loser joins it like any other device.
   - It is missing → create the marker (`base: null`), so the row cannot be re-created in plaintext.
   - It holds a plain payload → **absorb only** (merge it into this device; no push to `P`, no etag, no outbox ack against `P`), at most once per move: a second plain payload is not merged. Run a private cycle so the private row carries what was absorbed. Then write the marker by compare-and-set on that pull's etag. A conflict ends the step; the next cycle resumes at 5.
   - Anything else (garbage, an envelope, a newer copy) → write the marker by compare-and-set without absorbing.
     The marker is `movedMarker('private', now)` plus `by: <device id>` (extra fields are ignored by every reader and by the relay). It is announced on the plain topic, so the other device learns at once.
6. Clear `moving`; keep `retired: { row: U, at }`.

### 4.3 Keeping the old row retired

For 60 days the mover HEADs `P` on start-up and once a day. If `P` is not its marker it re-writes the marker by compare-and-set **without merging what it finds**, and Settings › Sync says "Another device is still using the old sync. Update it and enter the private code." If `P` is missing it re-creates the marker. Anything a straggler wrote to `P` is still on that device and is merged when it joins.

### 4.4 What the other device sees

It pulls the marker, persists the fence (3.7) and asks for the code. Joining is 3.5 with its own entries kept and merged. A "Delete everywhere" pressed while fenced is carried out everywhere at the join; the join preview says how many entries this device will delete on the others.

### 4.5 The relay

The prune function (rows untouched for 90 days) would remove a marker, after which only a device still on `U` and not fenced could re-create `P` in plaintext. Release 1's durable fence and 4.3 cover the owner's devices; the runbook's optional scheduled prune is to leave a `moved` row alone. No migration is needed for release 2.

## 5. Failure matrix

| Event                                                                                                                 | Result                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A private row is replaced with garbage, a tampered envelope, plaintext, or a plaintext marker                         | `invalid`: one copy quarantined, never merged, repaired from a device's own copy.                                                      |
| An envelope with a forged "newer" header                                                                              | Pause `update-required`; the owner can replace the copy (3.9).                                                                         |
| An older valid envelope is put back                                                                                   | It opens; merging it changes nothing; the device then writes its current state.                                                        |
| A private device loses `st5:sync` (an older build wrote over it, a quota error)                                       | Restored from `st5:synckey` at the next start.                                                                                         |
| Two tabs, one changes the bucket                                                                                      | The other re-reads the config at its next cycle and follows.                                                                           |
| The code is lost on every device                                                                                      | The relay copy cannot be read by anyone. Each device still holds its data; a new sync starts from it. Said in the Disconnect question. |
| (R2) Crash before step 4                                                                                              | Still a plain bucket. At most an orphan ciphertext row.                                                                                |
| (R2) Crash after step 4                                                                                               | Private, with `moving`: the next private cycle resumes step 5. `P` is live until then.                                                 |
| (R2) The other device writes `P` before the marker                                                                    | Absorbed once at step 5 and carried into the private row.                                                                              |
| (R2) A device writes `P` over the marker (an in-flight forced write, the upsert transport, a straggler after a prune) | The mover re-retires `P` within a day (4.3). That device keeps its entries and merges them when it joins.                              |
| (R2) Both devices move at once                                                                                        | One marker lands first; the other device drops its unfinished bucket and is fenced.                                                    |
| (R2) The relay refuses a new row                                                                                      | The move stops at step 3 with nothing changed.                                                                                         |

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
| 0.8.x, 0.9.x                 | a marker                                  | 0.8.4 and older stop on it before any push; 0.8.5 and 0.9.x pause.                                                                      |

## 7. Acceptance criteria, release 1

Each is a test at the level named. Unit tests run the real engine against the fake relay (`src/__tests__/fakeRelay.ts`, which already holds many rows and has a `beforeWrite` hook).

- **AC-P1.** A private cycle round-trips between two devices through a relay that holds only `{st,k,r,iv,z,ct}`. No entry's name, amount, category or note is in any row, topic or request.
- **AC-P2.** Every request of a private bucket (the probe with `auto` and no hint, head, pull, push, the join preview), every channel name and every persisted `meta.sync` value carries the derived row id or topic. None contains the code or the secret.
- **AC-P3.** An edit made while `open` or `seal` is pending is neither lost nor acked early. A bucket change (Disconnect, another tab) while either is pending stops the cycle without a write.
- **AC-P4.** A flipped ciphertext bit, a swapped `r`, an envelope copied from another row, a plaintext v5 payload, a plaintext marker, an empty object, and an inner payload whose revision differs from `r`: each is quarantined (one copy kept in all), not merged, and repaired. An injected plaintext entry never appears on a device.
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

Release 2's criteria are written with its second review: the move with a crash after every write, a lost answer at steps 3 and 5, the other device writing before and over the marker, a pruned row, a stale second tab, both devices moving, and the move on each transport.

## 8. Rollout

1. **Release 1 (0.21.0).** Both devices update. Nothing changes for the owner's bucket.
2. **Gate E (005)**, when Settings › Sync says ready, as planned. It should come before gate D: after it the public key can no longer list or write the table, and the retiring update is no longer broadcast to row-event listeners.
3. **Release 2**, then **gate D, the owner's**: after a backup export, "Make sync private" on one device and the code on the other. The lead verifies from the owner's reading of Settings › Sync (the relay's registry is ciphertext from then on).
4. The manual way that needs no release 2: Disconnect on both devices, Generate on one, Join on the other. Nothing is lost (each device keeps its entries and a join merges). The old plain row stays on the relay until it is deleted by hand.

## 9. Decisions for the owner (none blocks the build)

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
