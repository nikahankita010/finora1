/*
# Atomic AI rate limiting: usage counters + RPC

1. Plain-English explanation
   - Today the AI Consultant counts a user's daily messages by running a
     SELECT COUNT over `ai_messages` before every AI call. Two requests
     arriving at the same moment both read the same count, both pass the
     check, and the user can exceed the 30-message daily limit. This
     migration replaces that check-then-act pattern with a single atomic
     database function that both checks and reserves quota in one step.
   - It also adds a short-window burst limit (max 5 requests per minute)
     as a second, independent protection against spam.

2. New Tables
   - `ai_usage` — one row per user per UTC day, holding that day's request
     counter, plus a sliding burst window (array of recent request
     timestamps, pruned automatically).
     - `user_id` (uuid, primary key, references auth.users, cascade delete)
     - `day` (date, primary key, UTC day the row counts)
     - `request_count` (integer, messages sent that day)
     - `burst_timestamps` (timestamptz[], timestamps of requests inside the
       current one-minute burst window)
     - `updated_at` (timestamptz, last time the row changed)
   - No historical usage data is removed: the existing `ai_messages` table
     remains the source of truth for conversations, and this new table only
     starts counting from the day it is deployed.

3. Security changes
   - RLS enabled on `ai_usage`; NO policies and NO grants to `anon` or
     `authenticated` — end users can never read or write their own quota
     through the browser (frontend cannot reset or inflate its quota).
   - `service_role` (the Edge Function) gets SELECT/INSERT/UPDATE — the only
     role that touches the table.
   - New function `check_ai_rate_limit(p_user_id uuid, p_daily_limit int,
     p_burst_limit int, p_burst_window_seconds int)` — SECURITY DEFINER,
     fixed `search_path`, called by the Edge Function only.
     It atomically: opens a row lock (FOR UPDATE), prunes the burst window,
     and refuses when the burst limit or the daily limit is reached.
     Returns jsonb: { allowed, reason, daily_used, daily_limit,
     burst_count, burst_limit, retry_after_seconds }.
   - `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` — ordinary users
     cannot call the rate limiter themselves; the Edge Function uses the
     service role.

4. Important notes
   - The daily limit value (30) stays owned by the application; the function
     takes it as a parameter so changing the quota needs no migration.
   - Day boundary uses `now() AT TIME ZONE 'utc'::text` cast to date —
     consistent UTC days, unaffected by any user device clock.
   - Locking: the INSERT ... ON CONFLICT + SELECT ... FOR UPDATE sequence
     serialises concurrent requests per user+day, so simultaneous requests
     cannot both slip past the limit.
*/

CREATE TABLE IF NOT EXISTS public.ai_usage (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc'::text)::date,
  request_count integer NOT NULL DEFAULT 0,
  burst_timestamps timestamptz[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

-- Edge function (service_role) only; end users get no grants at all.
GRANT SELECT, INSERT, UPDATE ON public.ai_usage TO service_role;

CREATE OR REPLACE FUNCTION public.check_ai_rate_limit(
  p_user_id uuid,
  p_daily_limit integer,
  p_burst_limit integer,
  p_burst_window_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'utc'::text)::date;
  v_row public.ai_usage;
  v_burst timestamptz[];
  v_burst_count integer;
  v_oldest_allowed timestamptz := now() - make_interval(secs => p_burst_window_seconds);
BEGIN
  -- Ensure the row for (user, today) exists; concurrent inserts converge on
  -- the same row via the primary key.
  INSERT INTO public.ai_usage (user_id, day)
  VALUES (p_user_id, v_day)
  ON CONFLICT (user_id, day) DO NOTHING;

  SELECT request_count, burst_timestamps
  INTO v_row.request_count, v_row.burst_timestamps
  FROM public.ai_usage
  WHERE user_id = p_user_id AND day = v_day
  FOR UPDATE;

  -- Keep only timestamps inside the current burst window.
  SELECT array_agg(ts ORDER BY ts)
  INTO v_burst
  FROM unnest(v_row.burst_timestamps) AS ts
  WHERE ts > v_oldest_allowed;

  v_burst_count := COALESCE(array_length(v_burst, 1), 0);

  IF v_burst_count >= p_burst_limit THEN
    -- Ask the caller to retry when the oldest window entry ages out.
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'burst_limit',
      'daily_used', v_row.request_count,
      'daily_limit', p_daily_limit,
      'burst_count', v_burst_count,
      'burst_limit', p_burst_limit,
      'retry_after_seconds',
        GREATEST(1, CEILING(EXTRACT(EPOCH FROM (v_burst[1] + make_interval(secs => p_burst_window_seconds) - now()))))
    );
  END IF;

  IF v_row.request_count >= p_daily_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit',
      'daily_used', v_row.request_count,
      'daily_limit', p_daily_limit,
      'burst_count', v_burst_count,
      'burst_limit', p_burst_limit,
      'retry_after_seconds', NULL
    );
  END IF;

  -- Reserve the request atomically: increment daily count and record the
  -- burst timestamp in the same locked step.
  UPDATE public.ai_usage
  SET request_count = request_count + 1,
      burst_timestamps = COALESCE(v_burst, '{}') || now(),
      updated_at = now()
  WHERE user_id = p_user_id AND day = v_day;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', NULL,
    'daily_used', v_row.request_count + 1,
    'daily_limit', p_daily_limit,
    'burst_count', v_burst_count + 1,
    'burst_limit', p_burst_limit,
    'retry_after_seconds', NULL
  );
END;
$$;

-- The rate limiter is an internal Edge Function API, not a user RPC.
REVOKE EXECUTE ON FUNCTION public.check_ai_rate_limit(uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated;
