-- SpendTrack sync — VERIFY 006 (optional: only where 006 was applied). Right after 006, with or
-- without 005. It does not replace 004_verify.sql or 005_verify.sql: run the one for your gate too.
--
-- How: Supabase → SQL Editor → New query → paste this whole file → Run. Run it again whenever
-- you like: it leaves nothing behind.
--
-- The answer is one table: n, check, expected, actual, pass.
--   Row 0, RESULT: "PASS 12/12" when 006 is in place and working, else
--   "FAIL k/12: <the checks that failed>". On FAIL, stop and paste the table to the lead;
--   there is nothing to undo. Where 006 was never applied, or was rolled back, it FAILs (the
--   marker_kept_* and prune_keeps_moved rows): that is expected there.
--
-- What it does: reads the catalog (the functions are still as 004 made them, the prune function
-- still locked), adds five throwaway rows whose ids no sync code ever has
-- (00000000-0000-4000-8000-0000000000f1 to …f5), then calls st_sync_push on them as anon, the
-- role the app's public key uses, and runs the prune function as you. Every row it writes, and
-- anything the prune removes while it runs, is undone before it answers, by an error it raises
-- and catches itself; the last row, nothing_left_behind, proves it. It never shows your rows.
-- When this editor may not act as anon, the anon row reads SKIPPED and the calls run as you
-- (the functions answer the same).
--
-- It creates one temporary function, pg_temp.st_verify_006, which disappears with the session.

CREATE OR REPLACE FUNCTION pg_temp.st_verify_006()
RETURNS TABLE (n int, "check" text, expected text, actual text, pass boolean)
LANGUAGE plpgsql
AS $verify$
DECLARE
  c_moved  CONSTANT text := '00000000-0000-4000-8000-0000000000f1'; -- holds a moved marker
  c_plain  CONSTANT text := '00000000-0000-4000-8000-0000000000f2'; -- holds a plain copy
  c_old_m  CONSTANT text := '00000000-0000-4000-8000-0000000000f3'; -- a marker older than stale_after, younger than 4x
  c_old_p  CONSTANT text := '00000000-0000-4000-8000-0000000000f4'; -- a plain copy older than stale_after
  c_aged_m CONSTANT text := '00000000-0000-4000-8000-0000000000f5'; -- a marker older than 4x stale_after
  c_doc    CONSTANT jsonb := '{"spendtrack":"verify-006","version":"4.0","expenses":[],"x5":{"schema":5,"step":0}}';
  c_marker CONSTANT jsonb := '{"spendtrack":"verify-006","version":"4.0","expenses":"moved","categories":[],"x5":{"schema":5,"min":99,"moved":{"at":"2026-11-15T00:00:00.000Z","why":"private"}}}';
  c_env    CONSTANT jsonb := '{"st":5,"k":1,"iv":"AAAAAAAAAAAAAAAA","z":1,"ct":"AAAA"}';
  c_ids    text[] := ARRAY[c_moved, c_plain, c_old_m, c_old_p, c_aged_m];
  v_res    jsonb := '[]'::jsonb;
  v_editor text := current_user;
  v_table  regclass := to_regclass('public.sync_buckets');
  v_owner  oid;
  v_anon   boolean := false;
  v_count  bigint;
  v_a      text;
  v_ok     boolean;
  v_r      jsonb;
  v_t      timestamptz;
  v_total  int;
  v_fail   int;
  v_failed text;
BEGIN
  SELECT c.relowner INTO v_owner FROM pg_catalog.pg_class AS c WHERE c.oid = v_table;

  -- Catalog: 006 replaced two function bodies and nothing else.
  SELECT count(*) INTO v_count
    FROM unnest(ARRAY[to_regprocedure('public.st_sync_head(text)'),
                      to_regprocedure('public.st_sync_pull(text)'),
                      to_regprocedure('public.st_sync_push(text, jsonb, timestamptz, boolean)')]) AS f(fn)
    JOIN pg_catalog.pg_proc AS p ON p.oid = f.fn
   WHERE p.prosecdef
     AND p.proconfig @> ARRAY['search_path=""']
     AND p.proowner = v_owner
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  v_res := v_res || jsonb_build_object('check', 'functions_intact',
                                       'expected', '3 of 3 (definer, search_path pinned, owned by the table owner, anon may run, PUBLIC may not)',
                                       'actual', v_count || ' of 3', 'pass', v_count = 3);

  SELECT count(*) INTO v_count
    FROM pg_catalog.pg_proc AS p
   WHERE p.oid = to_regprocedure('public.prune_stale_sync_buckets(interval)')
     AND NOT p.prosecdef
     AND p.proconfig @> ARRAY['search_path=""']
     AND p.proowner = v_owner
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  v_res := v_res || jsonb_build_object('check', 'prune_intact',
                                       'expected', 'search_path pinned, owned by the table owner, nobody may run prune',
                                       'actual', CASE WHEN v_count = 1 THEN 'as expected' ELSE 'missing or changed' END,
                                       'pass', v_count = 1);

  -- Behaviour, on throwaway rows only.
  SELECT count(*) INTO v_count FROM public.sync_buckets AS b WHERE b.sync_id = ANY (c_ids);
  v_res := v_res || jsonb_build_object('check', 'throwaway_ids_free', 'expected', 'no row uses this check''s ids',
                                       'actual', CASE WHEN v_count = 0 THEN 'none does'
                                                      ELSE v_count || ' rows use them: behaviour not checked; tell the lead' END,
                                       'pass', v_count = 0);

  IF v_count = 0 THEN
    BEGIN -- everything in this block is undone by the marker raised at its end
      -- the editor adds the rows (no create through the function: the creation caps stay out of it)
      INSERT INTO public.sync_buckets (sync_id, payload) VALUES (c_moved, c_marker), (c_plain, c_doc);
      INSERT INTO public.sync_buckets (sync_id, payload, updated_at)
      VALUES (c_old_m, c_marker, now() - interval '1500 years'),
             (c_old_p, c_doc, now() - interval '1001 years'),
             (c_aged_m, c_marker, now() - interval '4001 years');

      BEGIN
        PERFORM set_config('role', 'anon', true);
        v_anon := true;
      EXCEPTION WHEN insufficient_privilege THEN
        v_anon := false;
      END;
      v_res := v_res || jsonb_build_object('check', 'acting_as_anon', 'expected', 'anon',
                 'actual', CASE WHEN v_anon THEN current_user::text
                                ELSE 'SKIPPED: could not act as anon here; the calls below ran as ' || v_editor END,
                 'pass', NOT v_anon OR current_user = 'anon');

      BEGIN
        v_t := public.st_sync_head(c_moved);
        v_r := public.st_sync_push(c_moved, jsonb_set(c_doc, '{x5,step}', '1'), v_t);
        v_ok := (v_r ->> 'reason') = 'conflict' AND (v_r ->> 'updated_at')::timestamptz = v_t
                AND (public.st_sync_pull(c_moved) -> 'payload') = c_marker;
        v_a := CASE WHEN v_ok THEN 'conflict, with the current token; marker unchanged' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'marker_kept_on_cas', 'expected', 'conflict, with the current token; marker unchanged',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_t := public.st_sync_head(c_moved);
        v_r := public.st_sync_push(c_moved, jsonb_set(c_doc, '{x5,step}', '2'), NULL, true);
        v_ok := (v_r ->> 'reason') = 'conflict' AND (v_r ->> 'updated_at')::timestamptz = v_t
                AND (public.st_sync_pull(c_moved) -> 'payload') = c_marker;
        v_a := CASE WHEN v_ok THEN 'conflict, with the current token; marker unchanged' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'marker_kept_on_force', 'expected', 'conflict, with the current token; marker unchanged',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_t := public.st_sync_head(c_moved);
        v_r := public.st_sync_push(c_moved, c_env, NULL, true);
        v_ok := (v_r ->> 'reason') = 'conflict' AND (v_r ->> 'updated_at')::timestamptz = v_t
                AND (public.st_sync_pull(c_moved) -> 'payload') = c_marker;
        v_a := CASE WHEN v_ok THEN 'conflict, with the current token; marker unchanged' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'marker_kept_on_forced_envelope', 'expected', 'conflict, with the current token; marker unchanged',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_t := public.st_sync_head(c_moved);
        v_r := public.st_sync_push(c_moved, jsonb_set(c_marker, '{x5,moved,why}', '"rotated"'), v_t);
        v_ok := (v_r ->> 'ok') = 'true' AND (v_r ->> 'updated_at')::timestamptz > v_t;
        v_a := CASE WHEN v_ok THEN 'ok, a later token' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'marker_replaces_marker', 'expected', 'ok, a later token',
                                           'actual', v_a, 'pass', coalesce(v_ok, false));

      BEGIN
        v_t := public.st_sync_head(c_plain);
        v_r := public.st_sync_push(c_plain, jsonb_set(c_doc, '{x5,step}', '1'), v_t);
        v_ok := (v_r ->> 'ok') = 'true';
        v_a := CASE WHEN v_ok THEN 'ok' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'plain_still_written', 'expected', 'ok', 'actual', v_a,
                                           'pass', coalesce(v_ok, false));

      BEGIN
        v_r := public.st_sync_push(c_plain, c_marker, NULL, true);
        v_ok := (v_r ->> 'ok') = 'true' AND (public.st_sync_pull(c_plain) -> 'payload') = c_marker;
        v_a := CASE WHEN v_ok THEN 'ok' ELSE coalesce(v_r::text, 'null') END;
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'marker_replaces_plain', 'expected', 'ok', 'actual', v_a,
                                           'pass', coalesce(v_ok, false));

      BEGIN
        -- as the editor: the API roles may not run prune. With stale_after 1,000 years it
        -- removes only rows untouched that long (markers: 4,000 years), undone with the rest.
        PERFORM set_config('role', v_editor, true);
        PERFORM public.prune_stale_sync_buckets(interval '1000 years');
        SELECT string_agg(CASE b.sync_id WHEN c_old_m THEN 'marker under 4x kept'
                                         WHEN c_aged_m THEN 'marker over 4x kept'
                                         ELSE 'old plain copy kept' END, ', ' ORDER BY b.sync_id)
          INTO v_a
          FROM public.sync_buckets AS b WHERE b.sync_id IN (c_old_m, c_old_p, c_aged_m);
        v_ok := v_a = 'marker under 4x kept';
        v_a := coalesce(v_a, 'all three removed');
      EXCEPTION WHEN OTHERS THEN v_ok := false; v_a := SQLSTATE || ': ' || SQLERRM;
      END;
      v_res := v_res || jsonb_build_object('check', 'prune_keeps_moved', 'expected', 'marker under 4x kept',
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

SELECT * FROM pg_temp.st_verify_006();
