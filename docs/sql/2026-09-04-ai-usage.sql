-- CityOps managed AI: the allowance, the rate limit, and the one atomic gate.
--
-- Run this in the Supabase SQL editor for project ggscdbbvqmqiyguiccrf:
--   https://supabase.com/dashboard/project/ggscdbbvqmqiyguiccrf/sql/new
--
-- Steps 0 to 6 can be pasted and run in one go. Step 7 is a read that checks
-- the result. The rollback at the bottom is complete and puts the database back
-- exactly as it was.
--
-- What this is for: the 29 USD tier runs AI on OUR Anthropic key, through the
-- ai-proxy edge function. Nothing in this file talks to Anthropic. It is the
-- meter and the tap: how much a subscriber has used this month, how fast they
-- may ask, and the one function that decides both under a lock so two tabs
-- cannot both squeeze through the last check at the same instant.
--
-- It BUILDS ON the entitlement rule from 2026-09-01-subscriptions.sql and does
-- not restate it: ai_reserve calls public.has_active_entitlement, the same
-- function every write policy calls. A second copy of that rule would be a
-- second thing to get wrong on the day the first one changes.


-- ============================================================
-- STEP 0. Look before you change. Read this output.
-- ============================================================
-- Expected: has_active_entitlement exists (the Phase C migration has run), and
-- neither ai_usage nor ai_calls exists yet. If has_active_entitlement is
-- missing, STOP: run docs/sql/2026-09-01-subscriptions.sql first, because
-- step 4 below calls it and will not compile without it.
select
  to_regprocedure('public.has_active_entitlement(uuid)') as entitlement_helper,
  to_regclass('public.subscriptions') as subscriptions_table,
  to_regclass('public.ai_usage')      as ai_usage_table,
  to_regclass('public.ai_calls')      as ai_calls_table;

-- And who would be let through the tier gate today. Read this row count before
-- step 6: the proxy is configured to accept tier 'managed' only, but the
-- AI_PROXY_TIERS secret can widen that to 'complimentary', and every
-- grandfathered account from the Phase C migration is complimentary. Widen it
-- only if this number is the handful you expect it to be.
select tier, count(*) from public.subscriptions group by tier order by tier;


-- ============================================================
-- STEP 1. The monthly meter.
-- ============================================================
-- One row per user per calendar month. period_start is the first of the month
-- in UTC, which is also what the app shows as the reset date, so the number a
-- subscriber reads and the number that gates them are the same number.
--
-- Written by the edge function with the service role, which bypasses RLS. That
-- is why there is a read policy below and no write policy at all: a client that
-- could write this row could write itself a fresh allowance.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  -- Tokens RESERVED by a call that has started and not yet reported back.
  -- Without this, a subscriber who starts a run and then walks away from the
  -- connection spends our Anthropic balance and is charged nothing for it,
  -- because the only place the real number ever appears is the response nobody
  -- read. The hold is taken up front and released when the call closes.
  held_tokens bigint not null default 0,
  calls int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period_start)
);
-- Safe to re-run on a database that already has the table from an earlier paste.
alter table public.ai_usage add column if not exists held_tokens bigint not null default 0;

alter table public.ai_usage enable row level security;

drop policy if exists "ai_usage read own" on public.ai_usage;
create policy "ai_usage read own" on public.ai_usage
  for select using (user_id = auth.uid());

revoke all on public.ai_usage from anon;
grant select on public.ai_usage to authenticated;


-- ============================================================
-- STEP 2. The call log, which is what makes a rolling window possible.
-- ============================================================
-- A month counter cannot answer "five an hour" and cannot answer "one at a
-- time", so each call gets a row: reserved when it starts, closed when it ends,
-- carrying the tokens Anthropic actually reported.
--
-- No client ever reads or writes this. It is service-role only, and there is no
-- policy on it at all: RLS is on, nothing is granted, so authenticated and anon
-- see an empty table no matter what they ask.
create table if not exists public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  max_tokens int not null,
  is_large boolean not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  status text not null default 'open'
);

-- The rolling-window count and the in-flight count are both "this user, recent",
-- so that is the index. Without it every call scans every call ever made.
create index if not exists ai_calls_user_started_idx
  on public.ai_calls (user_id, started_at desc);
create index if not exists ai_calls_open_idx
  on public.ai_calls (user_id, started_at desc) where finished_at is null;

alter table public.ai_calls enable row level security;
revoke all on public.ai_calls from anon, authenticated;


-- ============================================================
-- STEP 3. The numbers, in one place.
-- ============================================================
-- These are DEFAULTS. The edge function passes its own copies on every call, so
-- the operating numbers live in supabase/functions/ai-proxy/index.ts and these
-- are what a hand-run of the function uses. Both sets read the same:
--   350,000 output tokens a calendar month  (about 12 city guides)
--   5 generation-scale calls an hour, 60 small ones
--   a call is "generation scale" at 8,000 max_tokens or more
--   1 call in flight at a time
-- A reservation that never gets closed is swept after 15 minutes. A city guide
-- takes 2 to 4 minutes, so 15 is a wide margin around the longest real call. The
-- sweep does two things at once: it frees the in-flight slot, so a browser that
-- was closed mid-stream cannot wedge an account out of its own subscription, and
-- it charges that run at its ceiling, so walking away from a connection is the
-- most expensive thing a subscriber can do rather than the cheapest.


-- ============================================================
-- STEP 4. The one atomic gate.
-- ============================================================
-- Order, and all of it under one lock:
--   1. the entitlement rule, by calling the Phase C helper, not by copying it
--   2. the tier, against the list the caller allows
--   3. the monthly output allowance, counting spend AND holds
--   4. the rolling hourly limit for this call's size
--   5. the in-flight limit
--   6. the reservation, which takes a hold for the whole call
-- Before all six, abandoned runs from earlier are swept and charged at their
-- ceiling, so a dropped connection frees its slot without freeing its cost.
--
-- The lock is the point. Two tabs pressing Generate in the same second each run
-- these six checks; without the row lock on ai_usage both read "0 in flight"
-- and both proceed. With it, the second one waits, then reads what the first
-- one wrote, and is refused. That is the difference between a rate limit and a
-- suggestion.
--
-- The monthly check reserves the WHOLE call up front and releases the unused
-- part when it closes, rather than checking the counter and hoping. That is not
-- bookkeeping fussiness, it is the one thing standing between this and a free
-- relay: the tokens a run really cost are reported in a response, and a caller
-- who abandons the connection makes sure nobody ever reads it. With a hold,
-- that run has already been charged; without one it is free. The cost of the
-- hold is that the last few thousand tokens of a month cannot start a big run,
-- which is what a cap is.
create or replace function public.ai_reserve(
  uid uuid,
  want_max_tokens int,
  allowed_tiers text[] default array['managed'],
  large_call_min_tokens int default 8000,
  monthly_output_cap bigint default 350000,
  large_per_hour int default 5,
  small_per_hour int default 60,
  inflight_limit int default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_catalog
as $$
declare
  period date := date_trunc('month', now() at time zone 'utc')::date;
  resets date := (date_trunc('month', now() at time zone 'utc') + interval '1 month')::date;
  stale interval := interval '15 minutes';
  u public.ai_usage%rowtype;
  the_tier text;
  large boolean := want_max_tokens >= large_call_min_tokens;
  used_hour int;
  hour_cap int;
  oldest timestamptz;
  in_flight int;
  committed bigint;
  new_id uuid;
  a record;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_user',
      'message', 'Sign in to use AI on our key.');
  end if;

  -- THE serialization point. The row is created if it is missing and then
  -- locked, so every check below this line is this user's alone until commit.
  insert into public.ai_usage (user_id, period_start)
  values (uid, period)
  on conflict (user_id, period_start) do nothing;

  select * into u from public.ai_usage
  where user_id = uid and period_start = period
  for update;

  -- Abandoned runs, closed out at their CEILING before anything is counted.
  --
  -- This is the money rule and it is worth being blunt about. A call whose
  -- connection went away never reports its tokens, but Anthropic generated
  -- them and we paid for them. Counting an abandoned run as zero would make
  -- "start a big run, drop the connection, repeat" the cheapest way to spend
  -- somebody else's Anthropic balance. Counting it at its ceiling makes it the
  -- most expensive thing a subscriber can do to their own allowance instead.
  for a in
    select c.id, c.max_tokens, date_trunc('month', c.started_at at time zone 'utc')::date as p
    from public.ai_calls c
    where c.user_id = uid and c.finished_at is null and c.started_at <= now() - stale
  loop
    update public.ai_calls
    set finished_at = now(), status = 'abandoned', output_tokens = a.max_tokens
    where id = a.id;
    update public.ai_usage
    set output_tokens = output_tokens + a.max_tokens,
        held_tokens = greatest(held_tokens - a.max_tokens, 0),
        updated_at = now()
    where user_id = uid and period_start = a.p;
  end loop;
  -- Re-read: the sweep above may have moved this month's numbers.
  select * into u from public.ai_usage
  where user_id = uid and period_start = period;

  -- 1. The entitlement rule, asked rather than restated.
  if not public.has_active_entitlement(uid) then
    return jsonb_build_object('ok', false, 'reason', 'not_entitled',
      'message', 'AI on our key needs an active subscription. Copy the prompt and run it in ' ||
                 'your own Claude or ChatGPT: that path is free and it is right here.');
  end if;

  -- 2. The tier. No row means the free trial, which is not the managed tier:
  -- a trial gets everything the app can do on the traveler's OWN key, and our
  -- Anthropic bill is not part of a trial.
  select s.tier into the_tier from public.subscriptions s where s.user_id = uid;
  if the_tier is null or not (the_tier = any(allowed_tiers)) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_tier',
      'message', 'Your plan runs AI on your own Anthropic key. Add one in Profile, or switch ' ||
                 'to the plan that includes AI.');
  end if;

  -- 3. The month, counting what has been spent AND what is on hold for a run
  -- already going. The whole call is reserved up front, so the allowance can
  -- never be overshot by a run that was admitted with too little left.
  committed := u.output_tokens + u.held_tokens;
  if committed + want_max_tokens > monthly_output_cap then
    return jsonb_build_object('ok', false, 'reason', 'over_monthly_cap',
      'message', case when committed >= monthly_output_cap
        then 'You have used this month''s included AI.'
        else 'There is not enough of this month''s included AI left for a run this size.' end,
      'output_tokens_used', u.output_tokens,
      'output_tokens_cap', monthly_output_cap,
      'resets_at', resets);
  end if;

  -- 4. The hour, counted separately for generation-scale calls and small ones.
  -- A hundred-token geocode and a whole city guide are not the same event and
  -- must not spend the same budget.
  hour_cap := case when large then large_per_hour else small_per_hour end;
  select count(*), min(c.started_at) into used_hour, oldest
  from public.ai_calls c
  where c.user_id = uid
    and c.started_at > now() - interval '1 hour'
    and c.is_large = large;
  if used_hour >= hour_cap then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
      'message', case when large
        then 'That is ' || hour_cap || ' big AI runs in an hour, which is this plan''s limit.'
        else 'That is a lot of small AI calls in an hour, which is this plan''s limit.' end,
      'resets_at', oldest + interval '1 hour');
  end if;

  -- 5. One at a time. A reservation nobody closed stops counting after the
  -- stale window, so a closed tab costs a wait and never a lockout.
  select count(*) into in_flight
  from public.ai_calls c
  where c.user_id = uid and c.finished_at is null and c.started_at > now() - stale;
  if in_flight >= inflight_limit then
    return jsonb_build_object('ok', false, 'reason', 'busy',
      'message', 'One AI run at a time. Let the one already going finish, or cancel it.');
  end if;

  -- 6. The reservation itself: the row, and the HOLD for the whole call.
  insert into public.ai_calls (user_id, max_tokens, is_large)
  values (uid, want_max_tokens, large)
  returning id into new_id;

  update public.ai_usage
  set calls = calls + 1,
      held_tokens = held_tokens + want_max_tokens,
      updated_at = now()
  where user_id = uid and period_start = period;

  return jsonb_build_object('ok', true, 'call_id', new_id,
    'output_tokens_used', u.output_tokens,
    'output_tokens_cap', monthly_output_cap,
    'resets_at', resets);
end;
$$;

-- Service role only. This is NOT the landmine the Phase C file warns about:
-- has_active_entitlement must keep its grant to authenticated forever because
-- RLS policies call it as the querying role. Nothing calls these two except the
-- edge function holding the service role, and a client that could call
-- ai_finish could write itself a zero-token bill.
revoke all on function public.ai_reserve(uuid, int, text[], int, bigint, int, int, int) from public;
grant execute on function public.ai_reserve(uuid, int, text[], int, bigint, int, int, int) to service_role;


-- ============================================================
-- STEP 5. Closing a call, with the numbers Anthropic reported.
-- ============================================================
-- Never an estimate. The edge function reads input_tokens and output_tokens off
-- the response (thinking tokens are already inside output_tokens, because that
-- is how they are billed), and this writes exactly those.
--
-- Idempotent: a call already closed is left alone, so a retried finish cannot
-- double-charge an account.
create or replace function public.ai_finish(
  call_id uuid,
  input_tokens bigint,
  output_tokens bigint,
  call_status text default 'done'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  c public.ai_calls%rowtype;
  period date;
  inp bigint := greatest(coalesce(input_tokens, 0), 0);
  outp bigint := greatest(coalesce(output_tokens, 0), 0);
begin
  select * into c from public.ai_calls where id = call_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_such_call');
  end if;
  if c.finished_at is not null then
    return jsonb_build_object('ok', true, 'reason', 'already_closed');
  end if;

  update public.ai_calls
  set finished_at = now(), input_tokens = inp, output_tokens = outp,
      status = coalesce(call_status, 'done')
  where id = call_id;

  -- The month the call STARTED in, not the month it ended in. A run that
  -- crosses midnight on the first of the month belongs to the allowance it was
  -- admitted against, and to the hold that was taken there.
  period := date_trunc('month', c.started_at at time zone 'utc')::date;
  insert into public.ai_usage (user_id, period_start, input_tokens, output_tokens, calls)
  values (c.user_id, period, inp, outp, 0)
  on conflict (user_id, period_start) do update
  set input_tokens = public.ai_usage.input_tokens + inp,
      output_tokens = public.ai_usage.output_tokens + outp,
      -- The hold this call took, released. greatest() rather than a bare
      -- subtraction because a negative hold would hand out free allowance,
      -- and this is the one arithmetic in the file that could.
      held_tokens = greatest(public.ai_usage.held_tokens - c.max_tokens, 0),
      updated_at = now();

  return jsonb_build_object('ok', true, 'output_tokens', outp);
end;
$$;

revoke all on function public.ai_finish(uuid, bigint, bigint, text) from public;
grant execute on function public.ai_finish(uuid, bigint, bigint, text) to service_role;


-- ============================================================
-- STEP 6. The one read the app makes for the meter.
-- ============================================================
-- A subscriber sees how much of this month's AI they have used, in the same
-- numbers that gate them. It answers for the no-row case too, which is every
-- subscriber on the first of the month.
--
-- It reports the tier so the app knows whether to draw a meter at all: a
-- bring-your-own-key subscriber is spending their own money and is shown
-- nothing, because their usage is not our business to display.
create or replace function public.my_ai_usage()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
stable
as $$
declare
  uid uuid := auth.uid();
  period date := date_trunc('month', now() at time zone 'utc')::date;
  u public.ai_usage%rowtype;
  the_tier text;
begin
  if uid is null then
    return jsonb_build_object('signed_in', false);
  end if;
  select s.tier into the_tier from public.subscriptions s where s.user_id = uid;
  select * into u from public.ai_usage where user_id = uid and period_start = period;
  return jsonb_build_object(
    'signed_in', true,
    'tier', the_tier,
    'period_start', period,
    'resets_at', (date_trunc('month', now() at time zone 'utc') + interval '1 month')::date,
    'output_tokens', coalesce(u.output_tokens, 0),
    'held_tokens', coalesce(u.held_tokens, 0),
    'input_tokens', coalesce(u.input_tokens, 0),
    'calls', coalesce(u.calls, 0)
  );
end;
$$;

-- Read-only, own row, and the caller's identity comes from auth.uid() inside
-- the function rather than from an argument, so there is no id to swap.
grant execute on function public.my_ai_usage() to authenticated;


-- ============================================================
-- STEP 7. Check it before you trust it.
-- ============================================================
-- Expect: both tables present, three functions present, and no usage rows yet.
select
  to_regclass('public.ai_usage') as ai_usage,
  to_regclass('public.ai_calls') as ai_calls,
  to_regprocedure('public.ai_reserve(uuid,int,text[],int,bigint,int,int,int)') as reserve,
  to_regprocedure('public.ai_finish(uuid,bigint,bigint,text)') as finish,
  to_regprocedure('public.my_ai_usage()') as meter,
  (select count(*) from public.ai_usage) as usage_rows,
  (select count(*) from public.ai_calls) as call_rows;

-- And the refusal path, without spending anything. Pick any account that is NOT
-- on the managed tier and this must come back ok=false with reason wrong_tier
-- or not_entitled. Nothing is written when a check refuses, except the ai_usage
-- row the lock needed, which is zeroed and harmless.
-- select public.ai_reserve(
--   (select id from auth.users order by created_at limit 1), 32000);


-- ============================================================
-- OPERATING IT
-- ============================================================
-- Who is using what, this month:
--   select u.email, a.calls, a.input_tokens, a.output_tokens
--   from public.ai_usage a join auth.users u on u.id = a.user_id
--   where a.period_start = date_trunc('month', now() at time zone 'utc')::date
--   order by a.output_tokens desc;
--
-- A hold that is stuck (a run swept while its connection was merely slow):
--   select * from public.ai_calls where user_id = '<uuid>' order by started_at desc limit 5;
--   update public.ai_usage set held_tokens = 0, updated_at = now()
--   where user_id = '<uuid>'
--     and period_start = date_trunc('month', now() at time zone 'utc')::date;
--
-- Give one subscriber the rest of the month back (a failed run, a support call):
--   update public.ai_usage set output_tokens = 0, updated_at = now()
--   where user_id = '<uuid>'
--     and period_start = date_trunc('month', now() at time zone 'utc')::date;
--
-- Stop ALL spend on our key immediately, with no deploy: set the secret
-- AI_PROXY_DISABLED to 1 at
--   https://supabase.com/dashboard/project/ggscdbbvqmqiyguiccrf/functions/secrets
-- The next call refuses with a sentence that names the free copy-a-prompt path.
-- The app keeps working. Nothing else is affected.


-- ============================================================
-- ROLLBACK. Complete, and safe to run at any point.
-- ============================================================
-- Removes everything this file added and nothing else. It does not touch
-- subscriptions, has_active_entitlement, or any write policy: those are Phase
-- C's and the app depends on them. Losing ai_usage loses the record of who used
-- how much AI this month, which is a meter reading, not anybody's data.
--
-- Set AI_PROXY_DISABLED first if the proxy is deployed, or the next call will
-- fail on a missing function instead of refusing politely.
--
-- drop function if exists public.my_ai_usage();
-- drop function if exists public.ai_finish(uuid, bigint, bigint, text);
-- drop function if exists public.ai_reserve(uuid, int, text[], int, bigint, int, int, int);
-- drop table if exists public.ai_calls;
-- drop table if exists public.ai_usage;
