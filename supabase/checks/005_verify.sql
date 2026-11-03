-- SpendTrack sync — VERIFY 005. Gate E of docs/brain/sync-runbook.md, right after 005.
--
-- How: Supabase → SQL Editor → New query → paste this whole file → Run. Run it again whenever
-- you like: it leaves nothing behind.
--
-- The answer is one table: n, check, expected, actual, pass.
--   Row 0, RESULT: "PASS 20/20" when the lockdown holds and the sync functions still work,
--   else "FAIL k/20: <the checks that failed>". On FAIL, stop and paste the table to the lead.
--
-- What it does: reads the catalog (no table access for the API roles, row level security, the
-- publication, the functions), then acts as anon, the role the app's public key uses: the table
-- must refuse it, and the sync functions must still create, compare-and-set, pull and head a
-- throwaway row whose id no sync code ever has (00000000-0000-4000-8000-0000000000e…). Every
-- row it writes is undone before it answers; the last row, nothing_left_behind, proves it. It
-- never reads, changes or shows your rows. When this editor may not act as anon, the anon row
-- reads SKIPPED and `node scripts/verify-cas.mjs --lockdown` checks the same through the API.
--
-- It creates one temporary function, pg_temp.st_verify_005, which disappears with the session.

CREATE OR REPLACE FUNCTION pg_temp.st_verify_005()
RETURNS TABLE (n int, "check" text, expected text, actual text, pass boolean)
LANGUAGE plpgsql
AS $verify$
DECLARE
  c_row    CONSTANT text := '00000000-0000-4000-8000-0000000000e1'; -- created through the functions
  c_direct CONSTANT text := '00000000-0000-4000-8000-0000000000e2'; -- a direct insert the table refuses
  c_doc    CONSTANT jsonb := '{"spendtrack":"verify-005","version":"4.0","expenses":[],"x5":{"schema":5,"step":0}}';
  c_ids    text[] := ARRAY[c_row, c_direct];
  v_res    jsonb := '[]'::jsonb;
  v_editor text := current_user;
  v_role   text;
  v_list   text;
  v_table  regclass := to_regclass('public.sync_buckets');
  v_owner  oid;
  v_anon   boolean := false;
  v_full   boolean;
  v_count  bigint;
  v_hour   bigint;
  v_a      text;
  v_ok     boolean;
  v_r      jsonb;
  v_t1     timestamptz;
  v_t2     timestamptz;
  v_total  int;
  v_fail   int;
  v_failed text;
BEGIN
  SELECT c.relowner INTO v_owner FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;

  -- Catalog: no table access for the API roles (table, column or, on Postgres 17+, MAINTAIN).
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    SELECT coalesce(string_agg(y.p, ', ' ORDER BY y.ord), '')
      INTO v_list
      FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
           WITH ORDINALITY AS y(p, ord)
     WHERE coalesce(has_table_privilege(v_role, v_table, y.p), true);
    IF coalesce(has_any_column_privilege(v_role, v_table, 'SELECT, INSERT, UPDATE, REFERENCES'), true) THEN
      v_list := concat_ws(', ', nullif(v_list, ''), 'column privileges');
    END IF;
    -- nested, not AND: Postgres may evaluate either side first, and 15/16 reject 'MAINTAIN'
    IF current_setting('server_version_num')::int >= 170000 THEN
      IF coalesce(has_table_privilege(v_role, v_table, 'MAINTAIN'), true) THEN
        v_list := concat_ws(', ', nullif(v_list, ''), 'MAINTAIN');
      END IF;
    END IF;
    v_res := v_res || jsonb_build_object('check', v_role || '_no_table_access', 'expected', 'none',
                                         'actual', coalesce(nullif(v_list, ''), 'none'), 'pass', v_list = '');
  END LOOP;

  SELECT CASE WHEN c.relrowsecurity AND c.relforcerowsecurity THEN 'on, forced'
              WHEN c.relrowsecurity THEN 'on, not forced' ELSE 'off' END
    INTO v_a FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;
  v_res := v_res || jsonb_build_object('check', 'rls_on_not_forced', 'expected', 'on, not forced',
                                       'actual', v_a, 'pass', v_a = 'on, not forced');

  SELECT count(*) INTO v_count FROM pg_catalog.pg_policy AS p WHERE p.polrelid = v_table;
  v_res := v_res || jsonb_build_object('check', 'no_policies', 'expected', '0', 'actual', v_count::text,
                                       'pass', v_count = 0);

  v_ok := NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication_tables AS pt
                       WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public'
                         AND pt.tablename = 'sync_buckets');
  v_res := v_res || jsonb_build_object('check', 'realtime_unpublished', 'expected', 'not published',
                                       'actual', CASE WHEN v_ok THEN 'not published' ELSE 'published' END,
                                       'pass', v_ok);

  SELECT CASE c.relreplident WHEN 'd' THEN 'default' WHEN 'f' THEN 'full' WHEN 'n' THEN 'nothing' ELSE 'index' END
    INTO v_a FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;
  v_res := v_res || jsonb_build_object('check', 'replica_identity_default', 'expected', 'default',
                                       'actual', v_a, 'pass', v_a = 'default');

  SELECT count(*) INTO v_count
    FROM unnest(ARRAY[to_regprocedure('public.st_sync_head(text)'),
                      to_regprocedure('public.st_sync_pull(text)'),
                      to_regprocedure('public.st_sync_push(text, jsonb, timestamptz, boolean)')]) AS f(fn)
    JOIN pg_catalog.pg_proc AS p ON p.oid = f.fn
   WHERE p.prosecdef
     AND p.proconfig @> ARRAY['search_path=""']
     AND p.proowner = v_owner
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  v_res := v_res || jsonb_build_object('check', 'functions_intact',
                                       'expected', '3 of 3 (definer, search_path pinned, owned by the table owner, anon may run)',
                                       'actual', v_count || ' of 3', 'pass', v_count = 3);

  IF to_regprocedure('public.prune_stale_sync_buckets(interval)') IS NULL THEN
    v_ok := true;
    v_a := 'no prune function';
  ELSE
    v_ok := NOT has_function_privilege('anon', to_regprocedure('public.prune_stale_sync_buckets(interval)'), 'EXECUTE')
            AND NOT has_function_privilege('authenticated', to_regprocedure('public.prune_stale_sync_buckets(interval)'), 'EXECUTE')
            AND NOT EXISTS (SELECT 1
                              FROM pg_catalog.pg_proc AS p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                             WHERE p.oid = to_regprocedure('public.prune_stale_sync_buckets(interval)')
                               AND a.grantee = 0 AND a.privilege_type = 'EXECUTE');
    v_a := CASE WHEN v_ok THEN 'nobody' ELSE 'an API role may run prune' END;
  END IF;
  v_res := v_res || jsonb_build_object('check', 'prune_locked', 'expected', 'nobody may run prune',
                                       'actual', v_a, 'pass', v_ok);

  -- Behaviour, on throwaway rows only.
  SELECT count(*) INTO v_count FROM public.sync_buckets AS b WHERE b.sync_id = ANY (c_ids);
  v_res := v_res || jsonb_build_object('check', 'throwaway_ids_free', 'expected', 'no row uses this check''s ids',
                                       'actual', CASE WHEN v_count = 0 THEN 'none does'
                                                      ELSE v_count || ' rows use them: behaviour not checked; tell the lead' END,
                                       'pass', v_count = 0);

  IF v_count = 0 THEN
    SELECT count(*), count(*) FILTER (WHERE b.created_at > now() - interval '1 hour')
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
                                ELSE 'SKIPPED: could not act as anon here; scripts/verify-cas.mjs --lockdown checks this through the API' END,
                 'pass', NOT v_anon OR current_user = 'anon');

      IF v_anon THEN
        BEGIN
          PERFORM count(*) FROM public.sync_buckets AS b WHERE b.sync_id = c_row;
          v_ok := false;
          v_a := 'the table answered';
        EXCEPTION WHEN insufficient_privilege THEN v_ok := true; v_a := '42501';
        END;
      ELSE
        v_ok := NOT coalesce(has_table_privilege('anon', v_table, 'SELECT'), true);
        v_a := 'SKIPPED (not acting as anon): the grants say anon may ' || CASE WHEN v_ok THEN 'not ' ELSE '' END || 'read';
      END IF;
      v_res := v_res || jsonb_build_object('check', 'anon_select_refused', 'expected', '42501', 'actual', v_a, 'pass', v_ok);

      IF v_anon THEN
        BEGIN
          INSERT INTO public.sync_buckets (sync_id, payload) VALUES (c_direct, c_doc);
          v_ok := false;
          v_a := 'the row was written';
        EXCEPTION WHEN insufficient_privilege THEN v_ok := true; v_a := '42501';
        END;
      ELSE
        v_ok := NOT coalesce(has_table_privilege('anon', v_table, 'INSERT'), true);
        v_a := 'SKIPPED (not acting as anon): the grants say anon may ' || CASE WHEN v_ok THEN 'not ' ELSE '' END || 'insert';
      END IF;
      v_res := v_res || jsonb_build_object('check', 'anon_insert_refused', 'expected', '42501', 'actual', v_a, 'pass', v_ok);

      IF v_anon THEN
        BEGIN
          UPDATE public.sync_buckets AS b SET payload = b.payload WHERE b.sync_id = c_row;
          v_ok := false;
          v_a := 'the table answered';
        EXCEPTION WHEN insufficient_privilege THEN v_ok := true; v_a := '42501';
        END;
      ELSE
        v_ok := NOT coalesce(has_table_privilege('anon', v_table, 'UPDATE'), true);
        v_a := 'SKIPPED (not acting as anon): the grants say anon may ' || CASE WHEN v_ok THEN 'not ' ELSE '' END || 'update';
      END IF;
      v_res := v_res || jsonb_build_object('check', 'anon_update_refused', 'expected', '42501', 'actual', v_a, 'pass', v_ok);

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
          PERFORM set_config('role', v_editor, true);
          INSERT INTO public.sync_buckets (sync_id, payload) VALUES (c_row, c_doc);
          IF v_anon THEN PERFORM set_config('role', 'anon', true); END IF;
          v_t1 := (public.st_sync_pull(c_row) ->> 'updated_at')::timestamptz;
        ELSE
          v_r := public.st_sync_push(c_row, c_doc);
          v_ok := (v_r ->> 'ok') = 'true';
          v_a := CASE WHEN v_ok THEN 'ok' ELSE coalesce(v_r::text, 'null') END;
          v_t1 := (v_r ->> 'updated_at')::timestamptz;
        END IF;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'rpc_create_ok', 'expected', 'ok (53400 when the relay is at its caps)',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_row, jsonb_set(c_doc, '{x5,step}', '1'), v_t1);
        v_t2 := (v_r ->> 'updated_at')::timestamptz;
        v_ok := (v_r ->> 'ok') = 'true' AND v_t2 > v_t1;
        v_a := CASE WHEN v_ok THEN 'ok, a later token' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'rpc_cas_ok', 'expected', 'ok, a later token', 'actual', v_a,
                                           'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_row, jsonb_set(c_doc, '{x5,step}', '2'), v_t1);
        v_ok := (v_r ->> 'reason') = 'conflict' AND (v_r ->> 'updated_at')::timestamptz = v_t2;
        v_a := CASE WHEN v_ok THEN 'conflict, with the current token' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'rpc_old_token_is_conflict', 'expected', 'conflict, with the current token',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        -- a base later than the row's token is a conflict too (rpc_pull_ok then shows nothing moved)
        v_r := public.st_sync_push(c_row, jsonb_set(c_doc, '{x5,step}', '3'), v_t2 + interval '1 microsecond');
        v_ok := (v_r ->> 'reason') = 'conflict' AND (v_r ->> 'updated_at')::timestamptz = v_t2;
        v_a := CASE WHEN v_ok THEN 'conflict, with the current token' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'rpc_newer_token_is_conflict', 'expected', 'conflict, with the current token',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_pull(c_row);
        v_ok := (v_r -> 'payload') = jsonb_set(c_doc, '{x5,step}', '1') AND (v_r ->> 'updated_at')::timestamptz = v_t2;
        v_a := CASE WHEN v_ok THEN 'the last payload and its token' WHEN v_r IS NULL THEN 'null' ELSE 'differs' END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'rpc_pull_ok', 'expected', 'the last payload and its token',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_ok := public.st_sync_head(c_row) = v_t2;
        v_a := CASE WHEN v_ok THEN 'the current token' ELSE 'differs' END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'rpc_head_ok', 'expected', 'the current token', 'actual', v_a,
                                           'pass', coalesce(v_ok, false));

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

SELECT * FROM pg_temp.st_verify_005();
