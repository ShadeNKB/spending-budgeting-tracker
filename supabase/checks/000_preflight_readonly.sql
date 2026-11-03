-- SpendTrack sync — PREFLIGHT (read-only). Gate C and gate E of docs/brain/sync-runbook.md.
--
-- How: Supabase → SQL Editor → New query → paste this whole file → Run. Run it before 004,
-- after 004, before 005 and after 005.
--
-- It is ONE read-only SELECT: it changes nothing, and you can run it as often as you like.
-- The answer is one table of 21 rows (n 0 to 20): item, value, stop, note.
--   Row 0, verdict: GO, or STOP with the items that stopped it. On STOP, do not apply
--   anything: paste the table to the lead.
--   Row 1, stage: "before 004", "004 applied", "005 applied", or "mixed" (a STOP).
-- The table holds counts, sizes, times and role names only: never a sync code and never your
-- data, so it is safe to paste into the runbook log.
--
-- An ERROR such as `column "created_at" does not exist` or `relation "public.sync_buckets" does
-- not exist` means the wrong project, or 002 is missing: STOP and tell the lead.

WITH
tbl AS (
  SELECT c.oid, c.relowner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, c.relreplident AS replident
    FROM pg_catalog.pg_class AS c
   WHERE c.oid = 'public.sync_buckets'::regclass
),
r AS MATERIALIZED (
  SELECT b.created_at,
         b.updated_at,
         b.sync_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AS good_id,
         jsonb_typeof(b.payload) = 'object' AS is_object,
         octet_length(b.payload::text) AS bytes,
         b.updated_at > now() - interval '30 days' AS active,
         CASE
           WHEN jsonb_typeof(b.payload) <> 'object' THEN 'other'
           WHEN b.payload ->> 'spendtrack' = 'verify-cas' THEN 'check rows'
           WHEN b.payload ? 'st' THEN 'private'
           WHEN (b.payload -> 'expenses') = '"moved"'::jsonb THEN 'moved'
           WHEN b.payload ? 'x5' THEN 'v5'
           WHEN b.payload ? 'wr' THEN 'v0.8.5'
           WHEN jsonb_typeof(b.payload -> 'expenses') = 'array' THEN 'v0.8.0-0.8.4'
           ELSE 'other'
         END AS class
    FROM public.sync_buckets AS b
),
census AS (
  SELECT count(*) AS total,
         count(*) FILTER (WHERE r.created_at > now() - interval '1 hour' AND r.created_at <= clock_timestamp()) AS last_hour,
         count(*) FILTER (WHERE NOT r.good_id) AS bad_id,
         count(*) FILTER (WHERE NOT r.good_id AND r.active) AS bad_id_active,
         count(*) FILTER (WHERE NOT (r.is_object AND r.bytes <= 2097152)) AS bad_payload,
         count(*) FILTER (WHERE NOT (r.is_object AND r.bytes <= 2097152) AND r.active) AS bad_payload_active,
         max(r.bytes) FILTER (WHERE r.active) AS largest_active,
         max(r.updated_at) FILTER (WHERE isfinite(r.updated_at)) AS newest,
         count(*) FILTER (WHERE NOT isfinite(r.updated_at)) AS non_finite,
         count(*) FILTER (WHERE r.class = 'v5') AS c_v5,
         count(*) FILTER (WHERE r.class = 'v0.8.5') AS c_085,
         count(*) FILTER (WHERE r.class = 'v0.8.0-0.8.4') AS c_080,
         count(*) FILTER (WHERE r.class = 'private') AS c_private,
         count(*) FILTER (WHERE r.class = 'moved') AS c_moved,
         count(*) FILTER (WHERE r.class = 'check rows') AS c_check,
         count(*) FILTER (WHERE r.class = 'other') AS c_other
    FROM r
),
privs AS (
  SELECT x.rolname,
         to_regrole(x.rolname) IS NOT NULL AS present,
         coalesce(has_table_privilege(to_regrole(x.rolname), t.oid, 'SELECT'), false) AS sel,
         coalesce(has_table_privilege(to_regrole(x.rolname), t.oid, 'INSERT'), false) AS ins,
         coalesce(has_table_privilege(to_regrole(x.rolname), t.oid, 'UPDATE'), false) AS upd,
         coalesce(has_table_privilege(to_regrole(x.rolname), t.oid, 'DELETE'), false) AS del,
         coalesce(has_table_privilege(to_regrole(x.rolname), t.oid, 'TRUNCATE'), false) AS trunc,
         coalesce(has_table_privilege(to_regrole(x.rolname), t.oid, 'REFERENCES'), false) AS refs,
         coalesce(has_table_privilege(to_regrole(x.rolname), t.oid, 'TRIGGER'), false) AS trig,
         -- MAINTAIN exists from Postgres 17 (CASE keeps older servers from evaluating it)
         CASE WHEN current_setting('server_version_num')::int >= 170000
              THEN coalesce(has_table_privilege(to_regrole(x.rolname), t.oid, 'MAINTAIN'), false)
              ELSE false END AS maint,
         coalesce(has_any_column_privilege(to_regrole(x.rolname), t.oid, 'SELECT, INSERT, UPDATE, REFERENCES'), false) AS cols
    FROM (VALUES ('anon'), ('authenticated')) AS x(rolname)
   CROSS JOIN tbl AS t
),
priv_text AS (
  SELECT p.rolname,
         p.sel, p.ins, p.upd, p.del, p.trunc,
         p.sel OR p.ins OR p.upd OR p.del OR p.trunc OR p.refs OR p.trig OR p.maint OR p.cols AS any_access,
         CASE
           WHEN NOT p.present THEN 'role missing'
           ELSE coalesce(nullif(concat_ws(', ',
                  CASE WHEN p.sel THEN 'SELECT' END, CASE WHEN p.ins THEN 'INSERT' END,
                  CASE WHEN p.upd THEN 'UPDATE' END, CASE WHEN p.del THEN 'DELETE' END,
                  CASE WHEN p.trunc THEN 'TRUNCATE' END, CASE WHEN p.refs THEN 'REFERENCES' END,
                  CASE WHEN p.trig THEN 'TRIGGER' END, CASE WHEN p.maint THEN 'MAINTAIN' END), ''),
                CASE WHEN p.cols THEN 'column privileges only' ELSE 'none' END)
         END AS list
    FROM privs AS p
),
anon_p AS (SELECT * FROM priv_text WHERE rolname = 'anon'),
auth_p AS (SELECT * FROM priv_text WHERE rolname = 'authenticated'),
prune AS (
  SELECT to_regprocedure('public.prune_stale_sync_buckets(interval)') AS fn
),
prune_facts AS (
  SELECT pr.fn IS NULL AS absent,
         coalesce(has_function_privilege(to_regrole('anon'), pr.fn, 'EXECUTE'), false) AS anon_exec,
         coalesce(has_function_privilege(to_regrole('authenticated'), pr.fn, 'EXECUTE'), false) AS auth_exec,
         EXISTS (SELECT 1
                   FROM pg_catalog.pg_proc AS p,
                        aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                  WHERE p.oid = pr.fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
    FROM prune AS pr
),
fns AS (
  SELECT f.name, p.oid AS fn, p.prosecdef, p.proconfig, p.proowner, p.proacl
    FROM (VALUES ('st_sync_head', 'public.st_sync_head(text)'),
                 ('st_sync_pull', 'public.st_sync_pull(text)'),
                 ('st_sync_push', 'public.st_sync_push(text, jsonb, timestamptz, boolean)')) AS f(name, sig)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = to_regprocedure(f.sig)
),
fn_problems AS (
  SELECT f.name,
         f.fn IS NOT NULL AS present,
         CASE WHEN f.fn IS NULL THEN 'missing'
              ELSE nullif(concat_ws(', ',
                     CASE WHEN NOT f.prosecdef THEN 'not security definer' END,
                     CASE WHEN f.proconfig IS NULL OR NOT f.proconfig @> ARRAY['search_path=""'] THEN 'search_path not pinned' END,
                     CASE WHEN f.proowner <> t.relowner THEN 'not owned by the table owner' END,
                     CASE WHEN NOT coalesce(has_function_privilege(to_regrole('anon'), f.fn, 'EXECUTE'), false) THEN 'anon cannot run it' END,
                     CASE WHEN NOT coalesce(has_function_privilege(to_regrole('authenticated'), f.fn, 'EXECUTE'), false) THEN 'authenticated cannot run it' END,
                     CASE WHEN EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) AS a
                                        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'PUBLIC can run it' END), '')
         END AS problem
    FROM fns AS f CROSS JOIN tbl AS t
),
fn_extra AS (
  SELECT count(*) AS extra
    FROM pg_catalog.pg_proc AS p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('st_sync_head', 'st_sync_pull', 'st_sync_push')
     AND p.oid NOT IN (SELECT f.fn FROM fns AS f WHERE f.fn IS NOT NULL)
),
fn_summary AS (
  SELECT count(*) FILTER (WHERE fp.present) AS present,
         count(*) FILTER (WHERE fp.problem IS NOT NULL) AS bad,
         string_agg(fp.name || ': ' || fp.problem, '; ' ORDER BY fp.name) FILTER (WHERE fp.problem IS NOT NULL) AS problems,
         (SELECT fe.extra FROM fn_extra AS fe) AS extra
    FROM fn_problems AS fp
),
guards AS (
  SELECT g.name,
         CASE WHEN g.name = 'sync_buckets_created_at_idx'
              THEN to_regclass('public.sync_buckets_created_at_idx') IS NOT NULL
              ELSE EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k, tbl AS t
                            WHERE k.conrelid = t.oid AND k.conname = g.name) END AS present
    FROM (VALUES (1, 'sync_buckets_id_uuid'), (2, 'sync_buckets_payload_bounded'),
                 (3, 'sync_buckets_updated_at_finite'), (4, 'sync_buckets_created_at_idx')) AS g(ord, name)
),
guard_summary AS (
  SELECT count(*) FILTER (WHERE g.present) AS present,
         string_agg(g.name, ', ') FILTER (WHERE NOT g.present) AS missing
    FROM guards AS g
),
pub AS (
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_publication AS p WHERE p.pubname = 'supabase_realtime') AS has_pub,
         EXISTS (SELECT 1 FROM pg_catalog.pg_publication_tables AS pt
                  WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public'
                    AND pt.tablename = 'sync_buckets') AS published
),
pol AS (
  SELECT count(*) AS policies FROM pg_catalog.pg_policy AS p, tbl AS t WHERE p.polrelid = t.oid
),
facts AS (
  SELECT fs.present = 0 AND fs.extra = 0 AS fns_none,
         fs.present = 3 AND fs.bad = 0 AND fs.extra = 0 AS fns_exact,
         gs.present = 0 AS guards_none,
         gs.present = 4 AS guards_all,
         t.rls, t.forced,
         a.sel AS a_sel, a.ins AS a_ins, a.upd AS a_upd, a.del AS a_del, a.trunc AS a_trunc, a.any_access AS a_any,
         u.sel AS u_sel, u.ins AS u_ins, u.upd AS u_upd, u.del AS u_del, u.trunc AS u_trunc, u.any_access AS u_any,
         pf.absent OR NOT (pf.anon_exec OR pf.auth_exec OR pf.public_exec) AS prune_locked,
         pb.published
    FROM fn_summary AS fs, guard_summary AS gs, tbl AS t, anon_p AS a, auth_p AS u, prune_facts AS pf, pub AS pb
),
stage AS (
  SELECT CASE
           WHEN f.fns_none AND f.guards_none AND NOT f.rls AND f.a_sel THEN 'before 004'
           WHEN f.fns_exact AND f.guards_all AND NOT f.rls
                AND f.a_sel AND f.a_ins AND f.a_upd AND f.u_sel AND f.u_ins AND f.u_upd
                AND NOT (f.a_del OR f.a_trunc OR f.u_del OR f.u_trunc) AND f.prune_locked THEN '004 applied'
           WHEN f.fns_exact AND f.guards_all AND f.rls AND NOT f.forced
                AND NOT f.a_any AND NOT f.u_any AND NOT f.published AND f.prune_locked THEN '005 applied'
           ELSE 'mixed'
         END AS value
    FROM facts AS f
),
items AS (
  SELECT 1 AS n, 'stage' AS item, s.value, s.value = 'mixed' AS stop,
         CASE s.value
           WHEN 'before 004' THEN 'next: apply 004_sync_rpc.sql (gate C)'
           WHEN '004 applied' THEN 'next: checks/004_verify.sql; 005 only when Settings says "Ready for the database lockdown." (gate E)'
           WHEN '005 applied' THEN 'locked: checks/005_verify.sql proves it'
           ELSE 'neither before 004 nor as 004 or 005 left it: tell the lead'
         END AS note
    FROM stage AS s
  UNION ALL
  SELECT 2, 'table_owner',
         t.relowner::regrole::text || CASE WHEN t.relowner::regrole::text = current_user THEN ' (you)'
                                           ELSE '; you are ' || current_user END,
         t.relowner::regrole::text <> current_user,
         CASE WHEN t.relowner::regrole::text = current_user THEN 'migrations run as the table owner: that is you'
              ELSE 'run every SpendTrack file as the table owner (normally postgres)' END
    FROM tbl AS t
  UNION ALL
  SELECT 3, 'rows_total', c.total || ' of the 500 cap', c.total >= 450,
         CASE WHEN c.total >= 450 THEN 'close to the 500-row creation cap: tell the lead before going on'
              ELSE 'one row per sync code ever used; new codes stop at 500' END
    FROM census AS c
  UNION ALL
  SELECT 4, 'rows_created_last_hour', c.last_hour || ' of the 20 cap', false,
         'new codes per hour; the 21st is refused until the hour passes'
    FROM census AS c
  UNION ALL
  SELECT 5, 'rows_bad_id', c.bad_id || ' in total, ' || c.bad_id_active || ' written in the last 30 days',
         c.bad_id_active > 0,
         CASE WHEN c.bad_id_active > 0 THEN 'a row whose id is not a lower-case UUID is in use: 004 would stop it updating; tell the lead'
              ELSE 'ids that are not a lower-case UUID (old junk is harmless: 004 never touches it)' END
    FROM census AS c
  UNION ALL
  SELECT 6, 'rows_bad_payload', c.bad_payload || ' in total, ' || c.bad_payload_active || ' written in the last 30 days',
         c.bad_payload_active > 0,
         CASE WHEN c.bad_payload_active > 0 THEN 'a row in use holds a payload 004 would refuse (not an object, or over 2 MiB): tell the lead'
              ELSE 'payloads that are not an object or are over 2 MiB of jsonb text' END
    FROM census AS c
  UNION ALL
  -- KB rounded down up to the limit and up past it: the number reads over 1,228 exactly when
  -- stop is true (1,258,291 bytes is 1,228.8 KB).
  SELECT 7, 'largest_active_payload',
         CASE WHEN c.largest_active IS NULL THEN 'no row written in the last 30 days'
              ELSE to_char(CASE WHEN c.largest_active > 1258291 THEN ceil(c.largest_active / 1024.0)
                                ELSE floor(c.largest_active / 1024.0) END, 'FM999,999,990')
                   || ' KB of 1,228 KB' END,
         coalesce(c.largest_active > 1258291, false),
         CASE WHEN coalesce(c.largest_active > 1258291, false)
              THEN 'a row in use is over what st_sync_push accepts (1,258,291 bytes): tell the lead'
              WHEN c.largest_active > 1024000
              THEN 'near the 1,228 KB limit (not a stop): past it, the functions refuse that copy and its device pauses sync as "too large"; tell the lead'
              ELSE 'jsonb text of the largest row written in the last 30 days; st_sync_push takes up to 1,228 KB' END
    FROM census AS c
  UNION ALL
  SELECT 8, 'newest_write',
         CASE WHEN c.newest IS NULL THEN 'no rows'
              WHEN c.newest > now() + interval '1 day' THEN 'in the future'
              WHEN now() - c.newest < interval '1 minute' THEN 'under a minute ago'
              WHEN now() - c.newest < interval '1 hour' THEN floor(extract(epoch FROM now() - c.newest) / 60)::int || ' min ago'
              WHEN now() - c.newest < interval '2 days' THEN floor(extract(epoch FROM now() - c.newest) / 3600)::int || ' h ago'
              ELSE floor(extract(epoch FROM now() - c.newest) / 86400)::int || ' days ago' END,
         false,
         'your devices last synced about then (any device, any code)'
         || CASE WHEN c.non_finite > 0 THEN '; ' || c.non_finite || ' rows carry a time that is not a real time (004 copes)' ELSE '' END
    FROM census AS c
  UNION ALL
  SELECT 9, 'writer_classes',
         'v5 ' || c.c_v5 || ' · v0.8.5 ' || c.c_085 || ' · v0.8.0-0.8.4 ' || c.c_080 || ' · private ' || c.c_private
         || ' · moved ' || c.c_moved || ' · check rows ' || c.c_check || ' · other ' || c.c_other,
         false,
         'which app versions wrote the rows; check rows are scripts/verify-cas.mjs throwaways'
    FROM census AS c
  UNION ALL
  SELECT 10, 'anon_table_privileges', a.list, false, 'what the public anon key may do on the table'
    FROM anon_p AS a
  UNION ALL
  SELECT 11, 'authenticated_table_privileges', u.list, false, 'the same for signed-in API users (SpendTrack has none)'
    FROM auth_p AS u
  UNION ALL
  SELECT 12, 'anon_can_prune',
         CASE WHEN pf.absent THEN 'no prune function' WHEN pf.anon_exec THEN 'yes' ELSE 'no' END,
         false, 'yes before 004 (F-068); 004 takes it away'
    FROM prune_facts AS pf
  UNION ALL
  SELECT 13, 'row_level_security',
         CASE WHEN t.rls AND t.forced THEN 'on, forced' WHEN t.rls THEN 'on' ELSE 'off' END,
         t.forced,
         CASE WHEN t.forced THEN 'forced row level security would stop the sync functions: tell the lead'
              ELSE 'off until 005; 005 turns it on (not forced)' END
    FROM tbl AS t
  UNION ALL
  SELECT 14, 'policies', p.policies::text, p.policies > 0,
         CASE WHEN p.policies > 0 THEN 'SpendTrack defines no policies; someone added one: tell the lead'
              ELSE 'none, on purpose (after 005: deny-all for the API)' END
    FROM pol AS p
  UNION ALL
  SELECT 15, 'realtime_publication',
         CASE WHEN NOT pb.has_pub THEN 'no publication' WHEN pb.published THEN 'table published' ELSE 'not published' END,
         false, 'row changes broadcast to devices until 005'
    FROM pub AS pb
  UNION ALL
  SELECT 16, 'replica_identity',
         CASE t.replident WHEN 'd' THEN 'default' WHEN 'f' THEN 'full' WHEN 'n' THEN 'nothing' ELSE 'index' END,
         false, 'full until 005, default after'
    FROM tbl AS t
  UNION ALL
  SELECT 17, 'sync_functions',
         CASE WHEN fs.present = 0 AND fs.extra = 0 THEN 'none'
              WHEN fs.present = 3 AND fs.bad = 0 AND fs.extra = 0 THEN '3 of 3, as 004 made them'
              ELSE fs.present || ' of 3; ' || concat_ws('; ', fs.problems,
                     CASE WHEN fs.extra > 0 THEN fs.extra || ' other st_sync_* functions' END) END,
         NOT ((fs.present = 0 AND fs.extra = 0) OR (fs.present = 3 AND fs.bad = 0 AND fs.extra = 0)),
         CASE WHEN fs.present = 0 AND fs.extra = 0 THEN '004 adds st_sync_head, st_sync_pull and st_sync_push'
              WHEN fs.present = 3 AND fs.bad = 0 AND fs.extra = 0 THEN 'security definer, search_path pinned, owned by the table owner, anon may run them'
              ELSE 'not as 004 makes them: tell the lead' END
    FROM fn_summary AS fs
  UNION ALL
  SELECT 18, 'write_guards',
         CASE WHEN gs.present = 0 THEN 'none' WHEN gs.present = 4 THEN 'all 4 (3 checks and the index)'
              ELSE gs.present || ' of 4; missing ' || gs.missing END,
         gs.present BETWEEN 1 AND 3,
         CASE WHEN gs.present BETWEEN 1 AND 3 THEN 'part of 004 is missing: tell the lead'
              ELSE '004 adds 3 checks on new writes and an index on created_at' END
    FROM guard_summary AS gs
  UNION ALL
  SELECT 19, 'server_time_zone', current_setting('TimeZone'), false,
         'tokens carry this zone''s offset; any zone works'
  UNION ALL
  SELECT 20, 'postgres_version', current_setting('server_version'), false, 'for the log'
)
SELECT 0 AS n,
       'verdict' AS item,
       CASE WHEN bool_or(i.stop) THEN 'STOP' ELSE 'GO' END AS value,
       bool_or(i.stop) AS stop,
       CASE WHEN bool_or(i.stop)
            THEN 'stopped by: ' || string_agg(i.item, ', ' ORDER BY i.n) FILTER (WHERE i.stop)
                 || '. Apply nothing; paste this table to the lead.'
            ELSE 'nothing stops you: go on with the runbook step' END AS note
  FROM items AS i
UNION ALL
SELECT i.n, i.item, i.value, i.stop, i.note FROM items AS i
ORDER BY n;
