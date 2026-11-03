-- SpendTrack sync — VERIFY 004. Gate C of docs/brain/sync-runbook.md, right after 004.
--
-- How: Supabase → SQL Editor → New query → paste this whole file → Run. Run it again whenever
-- you like: it leaves nothing behind.
--
-- The answer is one table: n, check, expected, actual, pass.
--   Row 0, RESULT: "PASS 34/34" when 004 is in place and working, else
--   "FAIL k/34: <the checks that failed>". On FAIL, stop and paste the table to the lead;
--   there is nothing to undo.
--
-- What it does: reads the catalog (who may do what, the functions, the guards), then calls the
-- sync functions as anon, the role the app's public key uses, on throwaway rows whose ids no
-- sync code ever has (00000000-0000-4000-8000-0000000000…). Every row it writes is undone
-- before it answers, by an error it raises and catches itself; the last row,
-- nothing_left_behind, proves it. It never reads, changes or shows your rows. When the relay is
-- at its creation caps it says so and still checks the rest. When this editor may not act as
-- anon, the anon row reads SKIPPED and scripts/verify-cas.mjs checks the same through the API.
--
-- It creates one temporary function, pg_temp.st_verify_004, which disappears with the session.

CREATE OR REPLACE FUNCTION pg_temp.st_verify_004()
RETURNS TABLE (n int, "check" text, expected text, actual text, pass boolean)
LANGUAGE plpgsql
AS $verify$
DECLARE
  c_prefix CONSTANT text := '00000000-0000-4000-8000-0000000000';
  c_row    CONSTANT text := '00000000-0000-4000-8000-0000000000a1'; -- created, then CAS, force
  c_gone   CONSTANT text := '00000000-0000-4000-8000-0000000000a2'; -- never created
  c_new    CONSTANT text := '00000000-0000-4000-8000-0000000000a3'; -- a create refused at the cap
  c_bad    CONSTANT text := 'st-verify-not-a-uuid';                 -- refused by the table guard
  c_doc    CONSTANT jsonb := '{"spendtrack":"verify-004","version":"4.0","expenses":[],"x5":{"schema":5,"step":0}}';
  c_ids    text[];
  v_res    jsonb := '[]'::jsonb;
  v_editor text := current_user;
  v_table  regclass := to_regclass('public.sync_buckets');
  v_owner  oid;
  v_anon   boolean := false;
  v_full   boolean;
  v_count  bigint;
  v_hour   bigint;
  v_a      text;
  v_ok     boolean;
  v_r      jsonb;
  v_big    jsonb;
  v_id     text;
  v_bad    jsonb;
  v_t1     timestamptz;
  v_t2     timestamptz;
  v_t3     timestamptz;
  v_total  int;
  v_fail   int;
  v_failed text;
  f_present int;
  f_definer int;
  f_path    int;
  f_owned   int;
  f_exec    int;
  f_private int;
BEGIN
  -- The check's own ids: four named ones and twenty for the hourly cap (…c0 to …d3).
  c_ids := ARRAY[c_row, c_gone, c_new, c_bad]
           || ARRAY(SELECT c_prefix || to_hex(191 + g.i) FROM generate_series(1, 20) AS g(i));
  SELECT c.relowner INTO v_owner FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;

  -- Catalog: the three functions.
  SELECT count(p.oid)::int,
         count(*) FILTER (WHERE p.prosecdef)::int,
         count(*) FILTER (WHERE p.proconfig @> ARRAY['search_path=""'])::int,
         count(*) FILTER (WHERE p.proowner = v_owner)::int,
         count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
                            AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))::int,
         count(*) FILTER (WHERE p.oid IS NOT NULL AND NOT EXISTS (
                            SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                             WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))::int
    INTO f_present, f_definer, f_path, f_owned, f_exec, f_private
    FROM unnest(ARRAY[to_regprocedure('public.st_sync_head(text)'),
                      to_regprocedure('public.st_sync_pull(text)'),
                      to_regprocedure('public.st_sync_push(text, jsonb, timestamptz, boolean)')]) AS f(fn)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = f.fn;
  v_res := v_res || jsonb_build_object('check', 'functions_present', 'expected', '3 of 3',
                                       'actual', f_present || ' of 3', 'pass', f_present = 3);
  v_res := v_res || jsonb_build_object('check', 'functions_security_definer', 'expected', '3 of 3',
                                       'actual', f_definer || ' of 3', 'pass', f_definer = 3);
  v_res := v_res || jsonb_build_object('check', 'functions_search_path_pinned', 'expected', '3 of 3',
                                       'actual', f_path || ' of 3', 'pass', f_path = 3);
  v_res := v_res || jsonb_build_object('check', 'functions_owned_by_table_owner', 'expected', '3 of 3',
                                       'actual', f_owned || ' of 3', 'pass', f_owned = 3);
  v_res := v_res || jsonb_build_object('check', 'functions_execute_anon_authenticated', 'expected', '3 of 3',
                                       'actual', f_exec || ' of 3', 'pass', f_exec = 3);
  v_res := v_res || jsonb_build_object('check', 'functions_no_public_execute', 'expected', '3 of 3',
                                       'actual', f_private || ' of 3', 'pass', f_private = 3);

  -- Catalog: the F-068 delete, truncate and prune holes closed, old clients still allowed, guards
  -- present, not locked yet.
  SELECT coalesce(string_agg(x.r || ' ' || y.p, ', ' ORDER BY x.r, y.p), 'none') INTO v_a
    FROM unnest(ARRAY['anon', 'authenticated']) AS x(r)
   CROSS JOIN unnest(ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS y(p)
   WHERE coalesce(has_table_privilege(x.r, v_table, y.p), true);
  v_res := v_res || jsonb_build_object('check', 'anon_cannot_delete_or_truncate', 'expected', 'none',
                                       'actual', v_a, 'pass', v_a = 'none');

  IF to_regprocedure('public.prune_stale_sync_buckets(interval)') IS NULL THEN
    v_a := 'no prune function';
    v_ok := true;
  ELSE
    SELECT coalesce(string_agg(w.who, ', ' ORDER BY w.who), 'nobody') INTO v_a
      FROM (SELECT x.r AS who
              FROM unnest(ARRAY['anon', 'authenticated']) AS x(r)
             WHERE has_function_privilege(x.r, to_regprocedure('public.prune_stale_sync_buckets(interval)'), 'EXECUTE')
            UNION ALL
            SELECT 'PUBLIC'
              FROM pg_catalog.pg_proc AS p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
             WHERE p.oid = to_regprocedure('public.prune_stale_sync_buckets(interval)')
               AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS w;
    v_ok := v_a = 'nobody';
  END IF;
  v_res := v_res || jsonb_build_object('check', 'prune_locked', 'expected', 'nobody may run prune',
                                       'actual', CASE WHEN v_ok THEN v_a ELSE v_a || ' may run prune' END,
                                       'pass', v_ok);

  SELECT coalesce(string_agg(x.r || ' ' || y.p, ', ' ORDER BY x.r, y.p), '') INTO v_a
    FROM unnest(ARRAY['anon', 'authenticated']) AS x(r)
   CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS y(p)
   WHERE NOT coalesce(has_table_privilege(x.r, v_table, y.p), false);
  v_res := v_res || jsonb_build_object('check', 'old_clients_still_work',
                                       'expected', 'anon and authenticated: SELECT, INSERT, UPDATE',
                                       'actual', CASE WHEN v_a = '' THEN 'anon and authenticated: SELECT, INSERT, UPDATE'
                                                      ELSE 'missing ' || v_a END,
                                       'pass', v_a = '');

  SELECT count(*) FILTER (WHERE g.present), coalesce(string_agg(g.guard, ', ') FILTER (WHERE NOT g.present), '')
    INTO v_count, v_a
    FROM (SELECT x.guard,
                 CASE WHEN x.guard = 'sync_buckets_created_at_idx'
                      THEN to_regclass('public.sync_buckets_created_at_idx') IS NOT NULL
                      ELSE EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k
                                    WHERE k.conrelid = v_table AND k.conname = x.guard) END AS present
            FROM unnest(ARRAY['sync_buckets_id_uuid', 'sync_buckets_payload_bounded',
                              'sync_buckets_updated_at_finite', 'sync_buckets_created_at_idx']) AS x(guard)) AS g;
  v_res := v_res || jsonb_build_object('check', 'write_guards_present', 'expected', '4 of 4 (3 checks and the index)',
                                       'actual', v_count || ' of 4' || CASE WHEN v_a = '' THEN '' ELSE '; missing ' || v_a END,
                                       'pass', v_count = 4);

  SELECT c.relrowsecurity INTO v_ok FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;
  SELECT 'RLS ' || CASE WHEN v_ok THEN 'on' ELSE 'off' END || ', '
         || CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_publication_tables AS pt
                               WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public'
                                 AND pt.tablename = 'sync_buckets') THEN 'published' ELSE 'not published' END
    INTO v_a;
  v_res := v_res || jsonb_build_object('check', 'not_locked_yet', 'expected', 'RLS off, published',
                                       'actual', v_a, 'pass', v_a = 'RLS off, published');

  -- Behaviour, on throwaway rows only.
  SELECT count(*) INTO v_count FROM public.sync_buckets AS b WHERE b.sync_id = ANY (c_ids);
  v_res := v_res || jsonb_build_object('check', 'throwaway_ids_free', 'expected', 'no row uses this check''s ids',
                                       'actual', CASE WHEN v_count = 0 THEN 'none does'
                                                      ELSE v_count || ' rows use them: behaviour not checked; tell the lead' END,
                                       'pass', v_count = 0);

  IF v_count = 0 THEN
    SELECT count(*), count(*) FILTER (WHERE b.created_at > now() - interval '1 hour' AND b.created_at <= clock_timestamp())
      INTO v_count, v_hour
      FROM public.sync_buckets AS b;
    v_full := v_count >= 500 OR v_hour >= 20;

    BEGIN -- everything in this block is undone by the marker raised at its end
      BEGIN
        PERFORM set_config('role', 'anon', true);
        v_anon := true;
      EXCEPTION WHEN insufficient_privilege THEN
        v_anon := false;
      END;
      v_res := v_res || jsonb_build_object('check', 'acting_as_anon', 'expected', 'anon',
                 'actual', CASE WHEN v_anon THEN current_user::text
                                ELSE 'SKIPPED: could not act as anon here; scripts/verify-cas.mjs checks this through the API' END,
                 'pass', NOT v_anon OR current_user = 'anon');

      BEGIN
        v_ok := public.st_sync_head(c_gone) IS NULL;
        v_a := CASE WHEN v_ok THEN 'null' ELSE 'a token' END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'head_missing_is_null', 'expected', 'null', 'actual', v_a, 'pass', v_ok);

      BEGIN
        v_ok := public.st_sync_pull(c_gone) IS NULL;
        v_a := CASE WHEN v_ok THEN 'null' ELSE 'a row' END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'pull_missing_is_null', 'expected', 'null', 'actual', v_a, 'pass', v_ok);

      BEGIN
        IF v_full THEN
          BEGIN
            v_r := public.st_sync_push(c_row, c_doc);
            v_ok := false;
            v_a := 'answered ' || coalesce(v_r::text, 'null');
          EXCEPTION WHEN SQLSTATE '53400' THEN
            v_ok := true;
            v_a := '53400 relay is full (the relay is at its creation caps: expected)';
          END;
          -- the remaining checks work on a row the editor adds here (undone with the rest)
          PERFORM set_config('role', v_editor, true);
          INSERT INTO public.sync_buckets (sync_id, payload) VALUES (c_row, c_doc);
          IF v_anon THEN PERFORM set_config('role', 'anon', true); END IF;
          v_t1 := (public.st_sync_pull(c_row) ->> 'updated_at')::timestamptz;
        ELSE
          v_r := public.st_sync_push(c_row, c_doc);
          v_ok := (v_r ->> 'ok') = 'true';
          v_a := CASE WHEN v_ok THEN 'ok' ELSE coalesce(v_r::text, 'null') END;
          v_t1 := (v_r ->> 'updated_at')::timestamptz; -- the etag string, as the app gets it
        END IF;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'create_ok', 'expected', 'ok (53400 when the relay is at its caps)',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_row, jsonb_set(c_doc, '{x5,step}', '1'));
        v_ok := (v_r ->> 'reason') = 'conflict' AND (public.st_sync_pull(c_row) -> 'payload') = c_doc;
        v_a := CASE WHEN v_ok THEN 'conflict; payload unchanged' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'create_again_is_conflict', 'expected', 'conflict; payload unchanged',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_row, jsonb_set(c_doc, '{x5,step}', '2'), v_t1);
        v_ok := (v_r ->> 'ok') = 'true';
        v_t2 := (v_r ->> 'updated_at')::timestamptz;
        v_a := CASE WHEN v_ok THEN 'ok' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'cas_exact_token_ok', 'expected', 'ok', 'actual', v_a,
                                           'pass', coalesce(v_ok, false));

      v_ok := v_t2 > v_t1;
      v_res := v_res || jsonb_build_object('check', 'cas_token_increases', 'expected', 'later than the base',
                 'actual', CASE WHEN v_ok THEN 'later than the base' WHEN v_t2 IS NULL THEN 'no token' ELSE 'not later' END,
                 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_row, jsonb_set(c_doc, '{x5,step}', '3'), v_t1);
        v_ok := (v_r ->> 'reason') = 'conflict' AND (v_r ->> 'updated_at')::timestamptz = v_t2;
        v_a := CASE WHEN v_ok THEN 'conflict, with the current token' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'cas_old_token_is_conflict', 'expected', 'conflict, with the current token',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        -- a base later than the row's token (an older build's upsert can move a token back)
        v_r := public.st_sync_push(c_row, jsonb_set(c_doc, '{x5,step}', '3'), v_t2 + interval '1 microsecond');
        v_ok := (v_r ->> 'reason') = 'conflict' AND (v_r ->> 'updated_at')::timestamptz = v_t2
                AND (public.st_sync_pull(c_row) -> 'payload') = jsonb_set(c_doc, '{x5,step}', '2');
        v_a := CASE WHEN v_ok THEN 'conflict, with the current token; payload unchanged' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'cas_newer_token_is_conflict',
                                           'expected', 'conflict, with the current token; payload unchanged',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_row, jsonb_set(c_doc, '{x5,step}', '4'), NULL, true);
        v_t3 := (v_r ->> 'updated_at')::timestamptz;
        v_ok := (v_r ->> 'ok') = 'true' AND v_t3 > v_t2;
        v_a := CASE WHEN v_ok THEN 'ok, a later token' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'force_existing_ok', 'expected', 'ok, a later token',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_gone, c_doc, NULL, true);
        v_ok := (v_r ->> 'reason') = 'missing' AND public.st_sync_head(c_gone) IS NULL;
        v_a := CASE WHEN v_ok THEN 'missing; nothing created' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'force_missing_is_missing', 'expected', 'missing; nothing created',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_gone, c_doc, v_t1);
        v_ok := (v_r ->> 'reason') = 'missing';
        v_a := CASE WHEN v_ok THEN 'missing' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'cas_missing_is_missing', 'expected', 'missing', 'actual', v_a,
                                           'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_pull(c_row);
        v_ok := (v_r ->> 'updated_at')::timestamptz = public.st_sync_head(c_row)
                AND (v_r -> 'payload') = jsonb_set(c_doc, '{x5,step}', '4');
        v_a := CASE WHEN v_ok THEN 'same token; the last payload' ELSE 'differs' END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'pull_matches_head', 'expected', 'same token; the last payload',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_row, '{"st":5,"k":1,"iv":"AAAAAAAAAAAAAAAA","z":1,"ct":"AAAA"}', NULL, true);
        v_ok := (v_r ->> 'ok') = 'true';
        v_a := CASE WHEN v_ok THEN 'ok' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'private_envelope_accepted', 'expected', 'ok', 'actual', v_a,
                                           'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_row, '{"version":"4.0","expenses":"moved","categories":[],"x5":{"schema":5,"min":99}}',
                                   NULL, true);
        v_ok := (v_r ->> 'ok') = 'true';
        v_a := CASE WHEN v_ok THEN 'ok' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'moved_marker_accepted', 'expected', 'ok', 'actual', v_a,
                                           'pass', coalesce(v_ok, false));

      v_a := '';
      FOREACH v_id IN ARRAY ARRAY['not-a-uuid', upper(c_row), NULL] LOOP
        BEGIN
          v_r := public.st_sync_push(v_id, c_doc);
          v_a := v_a || ' accepted';
        EXCEPTION WHEN OTHERS THEN v_a := v_a || ' ' || SQLSTATE;
        END;
      END LOOP;
      v_a := btrim(v_a);
      v_res := v_res || jsonb_build_object('check', 'bad_row_id_refused', 'expected', '22023 22023 22023 (not a UUID, upper case, null)',
                                           'actual', v_a, 'pass', v_a = '22023 22023 22023');

      v_a := '';
      FOREACH v_bad IN ARRAY ARRAY['[]'::jsonb, '{}'::jsonb, '{"version":"4.0","expenses":[]}'::jsonb, NULL::jsonb] LOOP
        BEGIN
          v_r := public.st_sync_push(c_gone, v_bad);
          v_a := v_a || ' accepted';
        EXCEPTION WHEN OTHERS THEN v_a := v_a || ' ' || SQLSTATE;
        END;
      END LOOP;
      v_a := btrim(v_a);
      v_res := v_res || jsonb_build_object('check', 'bad_payload_refused',
                                           'expected', '22023 22023 22023 22023 (array, {}, v4 without x5, null)',
                                           'actual', v_a, 'pass', v_a = '22023 22023 22023 22023');

      BEGIN
        -- {"x5": {"pad": "…"}, "expenses": []}, padded to exactly 1,258,291 bytes of jsonb text
        v_count := octet_length(jsonb_build_object('expenses', '[]'::jsonb, 'x5', jsonb_build_object('pad', ''))::text);
        v_big := jsonb_build_object('expenses', '[]'::jsonb, 'x5', jsonb_build_object('pad', repeat('x', 1258291 - v_count::int)));
        v_r := public.st_sync_push(c_row, v_big, NULL, true);
        v_ok := (v_r ->> 'ok') = 'true' AND octet_length(v_big::text) = 1258291;
        v_a := octet_length(v_big::text) || ' B ' || CASE WHEN (v_r ->> 'ok') = 'true' THEN 'ok' ELSE coalesce(v_r::text, 'null') END;
        BEGIN
          v_r := public.st_sync_push(c_row, jsonb_set(v_big, '{x5,pad}', to_jsonb(repeat('x', 1258292 - v_count::int))), NULL, true);
          v_ok := false;
          v_a := v_a || '; 1258292 B accepted';
        EXCEPTION WHEN SQLSTATE '22023' THEN v_a := v_a || '; 1258292 B 22023';
        END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'size_limit_exact', 'expected', '1258291 B ok; 1258292 B 22023',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        -- the editor fills the last hour up to 20 creates (throwaway rows, undone with the rest)
        PERFORM set_config('role', v_editor, true);
        SELECT count(*) INTO v_hour FROM public.sync_buckets AS b WHERE b.created_at > now() - interval '1 hour' AND b.created_at <= clock_timestamp();
        INSERT INTO public.sync_buckets (sync_id, payload)
        SELECT c_prefix || to_hex(191 + g.i), c_doc FROM generate_series(1, greatest(0, 20 - v_hour)::int) AS g(i);
        IF v_anon THEN PERFORM set_config('role', 'anon', true); END IF;
        BEGIN
          v_r := public.st_sync_push(c_new, c_doc);
          v_ok := false;
          v_a := 'a new row: ' || coalesce(v_r::text, 'null');
        EXCEPTION WHEN SQLSTATE '53400' THEN
          v_ok := true;
          v_a := '53400 for a new row';
        END;
        v_r := public.st_sync_push(c_row, c_doc);
        v_ok := v_ok AND (v_r ->> 'reason') = 'conflict';
        v_a := v_a || '; ' || coalesce(v_r ->> 'reason', v_r::text, 'null') || ' for an existing row';
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'hourly_create_cap', 'expected', '53400 for a new row; conflict for an existing row',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        BEGIN
          INSERT INTO public.sync_buckets (sync_id, payload) VALUES (c_bad, c_doc);
          v_ok := false;
          v_a := 'the row was written';
        EXCEPTION WHEN check_violation THEN
          GET STACKED DIAGNOSTICS v_a = CONSTRAINT_NAME;
          v_ok := v_a = 'sync_buckets_id_uuid';
          v_a := '23514 ' || v_a;
        END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'table_guard_refuses_bad_row', 'expected', '23514 sync_buckets_id_uuid',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        IF v_anon THEN
          BEGIN
            DELETE FROM public.sync_buckets AS b WHERE b.sync_id = c_row;
            v_ok := false;
            v_a := 'DELETE ran';
          EXCEPTION WHEN insufficient_privilege THEN
            v_ok := true;
            v_a := 'DELETE 42501';
          END;
          IF to_regprocedure('public.prune_stale_sync_buckets(interval)') IS NULL THEN
            v_a := v_a || ', no prune function';
          ELSE
            BEGIN
              PERFORM public.prune_stale_sync_buckets(interval '6000 years');
              v_ok := false;
              v_a := v_a || ', prune ran';
            EXCEPTION WHEN insufficient_privilege THEN
              -- refused at the door (EXECUTE), not by the table inside it
              GET STACKED DIAGNOSTICS v_id = MESSAGE_TEXT;
              IF v_id LIKE 'permission denied for function%' THEN
                v_a := v_a || ', prune 42501';
              ELSE
                v_ok := false;
                v_a := v_a || ', prune ran (then: ' || v_id || ')';
              END IF;
            END;
          END IF;
        ELSE
          v_ok := NOT coalesce(has_table_privilege('anon', v_table, 'DELETE'), true)
                  AND NOT coalesce(has_function_privilege('anon', to_regprocedure('public.prune_stale_sync_buckets(interval)'), 'EXECUTE'), false);
          v_a := 'SKIPPED (not acting as anon): the grants say anon may ' || CASE WHEN v_ok THEN 'not ' ELSE '' END
                 || 'DELETE or prune';
        END IF;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'anon_cannot_delete', 'expected', 'DELETE 42501, prune 42501',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      RAISE EXCEPTION 'st-verify-undo' USING ERRCODE = 'P0001';
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE <> 'P0001' OR SQLERRM <> 'st-verify-undo' THEN
        v_res := v_res || jsonb_build_object('check', 'unexpected_error', 'expected', 'none',
                                             'actual', SQLSTATE || ': ' || SQLERRM, 'pass', false);
      END IF;
    END;
  END IF;

  SELECT count(*) INTO v_count FROM public.sync_buckets AS b WHERE b.sync_id = ANY (c_ids);
  v_res := v_res || jsonb_build_object('check', 'nothing_left_behind', 'expected', '0 check rows',
             'actual', v_count || ' check rows' || CASE WHEN current_user = v_editor THEN ''
                                                        ELSE '; still acting as ' || current_user END,
             'pass', v_count = 0 AND current_user = v_editor);

  SELECT count(*)::int,
         count(*) FILTER (WHERE (x.e ->> 'pass') IS DISTINCT FROM 'true')::int,
         string_agg(x.e ->> 'check', ', ' ORDER BY x.i) FILTER (WHERE (x.e ->> 'pass') IS DISTINCT FROM 'true')
    INTO v_total, v_fail, v_failed
    FROM jsonb_array_elements(v_res) WITH ORDINALITY AS x(e, i);

  RETURN QUERY
    SELECT 0, 'RESULT'::text, 'all pass'::text,
           CASE WHEN v_fail = 0 THEN 'PASS ' || v_total || '/' || v_total
                ELSE 'FAIL ' || v_fail || '/' || v_total || ': ' || v_failed END,
           v_fail = 0
    UNION ALL
    SELECT x.i::int, x.e ->> 'check', x.e ->> 'expected', x.e ->> 'actual', coalesce((x.e ->> 'pass') = 'true', false)
      FROM jsonb_array_elements(v_res) WITH ORDINALITY AS x(e, i)
    ORDER BY 1;
END
$verify$;

SELECT * FROM pg_temp.st_verify_004();
