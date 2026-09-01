-- CityOps Phase C: subscription billing.
-- Run this in the Supabase SQL editor for project ggscdbbvqmqiyguiccrf:
--   https://supabase.com/dashboard/project/ggscdbbvqmqiyguiccrf/sql/new
--
-- Run step 0 first and read what it prints. Steps 1 to 5 are one transaction and
-- can be pasted together. Step 6 is the grandfathering pass. The rollback at the
-- bottom is complete and puts the database back exactly as it was.
--
-- Nothing in here charges anyone or talks to Stripe. It creates the table the
-- webhook writes, the helper the write policies ask, and the one read the app
-- makes to say what plan someone is on.


-- ============================================================
-- STEP 0. Look before you change. Read this output.
-- ============================================================
-- Expected: one own-rows policy per table (four rows), each FOR ALL, each with
-- qual and with_check reading user_id = auth.uid(). If you see anything else,
-- stop and save the output before running step 3, because step 3 replaces them.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('cities', 'city_state', 'planahead', 'shares')
order by tablename, policyname;


-- ============================================================
-- STEP 1. The table the Stripe webhook writes.
-- ============================================================
-- One row per user. The webhook writes it with the service role; no client ever
-- writes it, which is why there is no insert, update or delete policy below.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  tier text not null check (tier in ('byok', 'managed', 'complimentary')),
  status text not null default 'incomplete',
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  updated_at timestamptz not null default now()
);

-- customer.subscription.* events arrive keyed by the Stripe customer, not by our
-- user, so that lookup has to be an index rather than a table scan per event.
create unique index if not exists subscriptions_stripe_customer_idx
  on public.subscriptions (stripe_customer_id)
  where stripe_customer_id is not null;

alter table public.subscriptions enable row level security;

-- Read your own row and nothing else. There is deliberately no write policy:
-- the only writer is the webhook, holding the service role, which bypasses RLS.
drop policy if exists "subscriptions read own" on public.subscriptions;
create policy "subscriptions read own" on public.subscriptions
  for select using (user_id = auth.uid());

revoke all on public.subscriptions from anon;
grant select on public.subscriptions to authenticated;


-- ============================================================
-- STEP 2. The helper the write policies ask.
-- ============================================================
-- SECURITY DEFINER because it reads auth.users, which the authenticated role
-- cannot. Its numbers are the same numbers the app shows: 14 day trial from
-- account creation, 7 day grace past the end of a period that was paid for.
--
-- NOTE, and this is a rule and not a preference: never revoke EXECUTE on this
-- function. Row Level Security policies call it as the querying role, so the
-- moment authenticated cannot execute it, every gated write on every table
-- fails at once and the app looks broken in a way that points nowhere near here.
create or replace function public.has_active_entitlement(uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_catalog
stable
as $$
declare
  s public.subscriptions%rowtype;
  made timestamptz;
  base timestamptz;
begin
  if uid is null then
    return false;
  end if;

  select * into s from public.subscriptions where user_id = uid;

  if not found then
    -- No row is the trial, measured from when the account was made. That date
    -- lives in auth.users, so there is nothing here a client could forge.
    select u.created_at into made from auth.users u where u.id = uid;
    if made is null then
      return false;
    end if;
    return now() < made + interval '14 days';
  end if;

  -- Complimentary outranks status. No Stripe event ever writes this tier, so
  -- nothing can age it out.
  if s.tier = 'complimentary' then
    return true;
  end if;

  if s.status = 'active' then
    return true;
  end if;

  if s.status = 'trialing' then
    -- A webhook can be late, and a trial that has ended is over whatever the
    -- last stored status still says.
    return s.trial_ends_at is null or now() < s.trial_ends_at;
  end if;

  if s.status = 'past_due' then
    -- Grace runs from the end of the period they already paid for. With no
    -- period end stored, from when the row was last written, so the window
    -- cannot slide forward on every read.
    base := coalesce(s.current_period_end, s.updated_at);
    if base is null then
      return false;
    end if;
    return now() < base + interval '7 days';
  end if;

  -- canceled, unpaid, incomplete, incomplete_expired, paused, and any status
  -- Stripe has not invented yet.
  return false;
end;
$$;

grant execute on function public.has_active_entitlement(uuid) to authenticated;


-- ============================================================
-- STEP 3. Enforcement, in the database, on writes only.
-- ============================================================
-- Reads stay own-rows so a lapsed account keeps everything it made and can
-- still export it. Deletes stay open so a lapsed account can still unpublish a
-- share link or clear a city: locking someone out of removing their own data
-- would be holding it hostage, not gating a feature.
--
-- Existing rows are untouched. Enforcement applies to writes made from now on.
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['cities', 'city_state', 'planahead', 'shares'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'skipping %, table does not exist', t;
      continue;
    end if;

    for p in select policyname from pg_policies
             where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;

    execute format(
      'create policy %I on public.%I for select using (user_id = auth.uid())',
      t || ' read own', t);
    execute format(
      'create policy %I on public.%I for delete using (user_id = auth.uid())',
      t || ' delete own', t);
    execute format(
      'create policy %I on public.%I for insert with check '
      '(user_id = auth.uid() and public.has_active_entitlement(auth.uid()))',
      t || ' insert entitled', t);
    execute format(
      'create policy %I on public.%I for update using (user_id = auth.uid()) '
      'with check (user_id = auth.uid() and public.has_active_entitlement(auth.uid()))',
      t || ' update entitled', t);
  end loop;
end $$;


-- ============================================================
-- STEP 4. The one read the app makes.
-- ============================================================
-- The app could select its own subscriptions row directly, but that answers
-- nothing when there is no row, which is exactly the trial case. This returns
-- the same answer the helper enforces, plus the account creation date the trial
-- is measured from, in one round trip.
create or replace function public.my_entitlement()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_catalog
stable
as $$
declare
  uid uuid := auth.uid();
  s public.subscriptions%rowtype;
  made timestamptz;
begin
  if uid is null then
    return jsonb_build_object('signed_in', false);
  end if;
  select u.created_at into made from auth.users u where u.id = uid;
  select * into s from public.subscriptions where user_id = uid;
  return jsonb_build_object(
    'signed_in', true,
    'entitled', public.has_active_entitlement(uid),
    'account_created', made,
    'row', case when s.user_id is null then null else jsonb_build_object(
      'tier', s.tier,
      'status', s.status,
      'current_period_end', s.current_period_end,
      'trial_ends_at', s.trial_ends_at,
      'updated_at', s.updated_at,
      'has_customer', s.stripe_customer_id is not null
    ) end
  );
end;
$$;

grant execute on function public.my_entitlement() to authenticated;


-- ============================================================
-- STEP 5. Check it before you trust it.
-- ============================================================
-- Every existing account should come back true here, because step 6 has not run
-- yet and any account older than 14 days is outside the trial window. Run this
-- again after step 6 and every row should be true.
select u.email, public.has_active_entitlement(u.id) as entitled
from auth.users u
order by u.created_at;


-- ============================================================
-- STEP 6. Grandfathering. Run this once, after step 5 looks right.
-- ============================================================
-- Everyone who already has an account gets complimentary access that behaves as
-- active forever. They signed up before there was anything to pay for.
insert into public.subscriptions (user_id, tier, status, updated_at)
select u.id, 'complimentary', 'complimentary', now()
from auth.users u
on conflict (user_id) do nothing;

-- Expect: every row true, every tier complimentary.
select u.email, s.tier, s.status, public.has_active_entitlement(u.id) as entitled
from auth.users u
left join public.subscriptions s on s.user_id = u.id
order by u.created_at;


-- ============================================================
-- ROLLBACK. Complete, and safe to run at any point.
-- ============================================================
-- Restores the own-rows-only policies this migration replaced and removes
-- everything it added. Nobody loses data: subscriptions is the only table
-- dropped and the only thing in it is billing status, which Stripe still holds.
--
-- do $$
-- declare
--   t text;
--   p record;
-- begin
--   foreach t in array array['cities', 'city_state', 'planahead', 'shares'] loop
--     if to_regclass('public.' || t) is null then continue; end if;
--     for p in select policyname from pg_policies
--              where schemaname = 'public' and tablename = t loop
--       execute format('drop policy %I on public.%I', p.policyname, t);
--     end loop;
--     execute format(
--       'create policy %I on public.%I for all using (user_id = auth.uid()) '
--       'with check (user_id = auth.uid())',
--       t || ' owner all', t);
--   end loop;
-- end $$;
--
-- drop function if exists public.my_entitlement();
-- drop function if exists public.has_active_entitlement(uuid);
-- drop table if exists public.subscriptions;
