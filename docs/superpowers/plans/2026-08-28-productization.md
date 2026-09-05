# CityOps productization plan: clean URLs, public share, Stripe gate

Date: 2026-08-28
Owner: Rob Riggs
Status: Phase A approved to build. Phase B approved to build after A. Phase C
blocked on Rob's pricing and free-tier decisions.
Executor: Opus agents, one phase per agent run, recon-first. Each phase merges
independently and the product works between phases.

## Context for the executing agent

- Repo: github.com/robriggs3/cityops, public. Pages serves app.nomadding.com
  from main root. Every push to main deploys.
- Two surfaces, one shared header: `/` (cities app, from src/app-shell.html) and
  `/trip.html` (trip planner, from src/trip-shell.html). tools/assemble.js emits
  index.html, template.html, trip.html from src/, drift-guarded in CI.
  cities/example.json embeds to example.html and is also drift-guarded.
- Sync: raw-fetch Supabase (project ggscdbbvqmqiyguiccrf), magic-link auth,
  tables cities, city_state, planahead, profile (with stamped sidecars:
  apiKey, github, genmeta, removed). RLS own-rows everywhere, anon revoked.
  Session shared via localStorage cityops.auth.v1. The GoTrue redirect
  allowlist contains the app root only.
- Service worker sw.js: cache-first, precache list, bump cache version on
  every release. Users see a new build on their second open.
- The family share page today: trip surface's Publish button writes
  robs-travel-itinerary.html into the robriggs3/plan-ahead repo over the
  GitHub contents API using a synced PAT. wheres.robriggs.com serves it.
- House rules: no em-dash characters anywhere. Stage explicit paths, never
  git add -A. Never push the branch full-history. Commits in repo voice,
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>. Full local CI
  before push: assemble + git diff --exit-code, node tests/run.js
  (341 green at plan time), validate-city on cities/example.json, re-embed
  example.html after engine changes. Browser-verify at 390px and 1440px.
- Serialization: git fetch first; if the checkout has foreign uncommitted
  changes, wait until clean, then rebase. Rob also commits directly.

## Phase A: clean URLs, no .html

Goal: `/` and `/trip/` are the two pages. No behavior change.

1. Assembler emits `trip/index.html` instead of `trip.html`. Update the CI
   drift guard paths and any test asserting on trip.html bytes.
2. Keep `trip.html` as a tiny committed redirect stub (meta refresh + JS +
   visible link) to `/trip/` so old bookmarks and the retired github.io
   redirect keep working. The stub is NOT assembled; exclude it from the
   drift guard with a comment saying why it exists.
3. Sweep every internal reference: the shared header switch (`./trip.html`
   becomes `/trip/`; the Cities door from the trip side becomes `/`), stop
   cards' guide links, `#plan=` links back to the root, the footer, the
   README, sw.js precache list. Use root-absolute paths; the custom domain
   serves from root.
4. sw.js: precache `/trip/` (and keep `/`), bump cache version.
5. Verify live after deploy: `/trip/` serves 200 with the app bytes,
   `/trip.html` redirects, `/` unchanged, old github.io editor URL still
   lands correctly through its existing redirect chain.

Acceptance: address bar shows app.nomadding.com/trip/ with no .html
anywhere in normal navigation; all tests green; no other visible change.

## Phase B: public share from the profile

Goal: replace the GitHub-PAT publish with a database-backed share any user
can turn on, and delete the PAT from the product.

### Data

New table, DDL to be run by Rob in the dashboard SQL editor (agent puts the
exact block in its report; agent cannot run DDL):

```sql
create table public.shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  token text not null unique,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id)
);
alter table public.shares enable row level security;
create policy "shares owner all" on public.shares
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.shares from anon;
grant select, insert, update, delete on public.shares to authenticated;

create or replace function public.get_share(share_token text)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select data from public.shares where token = share_token
$$;
revoke all on function public.get_share(text) from public;
grant execute on function public.get_share(text) to anon, authenticated;
```

Anonymous readers get ONE door: get_share(token). No table grant to anon, so
enumeration is impossible; a wrong token returns null. NEVER grant anon
select on the table itself. Landmine reminder from the portal work: never
revoke EXECUTE from a SECURITY DEFINER function that a policy or public
path depends on after launch.

Token: generated client-side from crypto.getRandomValues, 32 hex chars
minimum. Rotate = new token + update row (old links die instantly).
Unpublish = delete row.

### App

1. Profile modal gains a Public share block: publish or update, copy link,
   rotate link, unpublish, and a picker for what the snapshot includes
   (trip only, or trip plus selected cities in read-only Share-view form).
   Publishing bakes a SNAPSHOT of chosen data at that moment; it is not
   live-updating. Say so in the UI copy.
2. The snapshot builder must exclude: credentials (structurally impossible
   already, keep it that way), genmeta private notes if they are private in
   spirit (recon what genmeta holds and decide field by field, list the
   decision in the report), booking payment status (the paid flag stays
   private, matching the family page decision from batch 3).
3. New static page `share/index.html` (assembled from src/share-shell.html,
   drift-guarded): reads `#<token>` or `?t=` from the URL, calls get_share
   over PostgREST rpc with the publishable key, renders the snapshot
   read-only in the existing Share-view idiom, works logged out, friendly
   empty state for a dead token. No service worker interference: precache
   the shell, never cache tokens or payloads.
4. Trip surface: Publish to GitHub is REPLACED by publishing to the share
   (one Publish concept, one door). Remove the GitHub PAT field, the github
   sidecar write path, and the contents-API code. Migration: on first load
   after this ships, if a github sidecar exists, stop syncing it and delete
   it from the profile row and local storage (report exactly what gets
   deleted). The plan-ahead repo keeps serving the LAST published
   robs-travel-itinerary.html until Rob flips wheres.
5. wheres.robriggs.com: after Rob publishes his first share, he replaces
   robs-travel-itinerary.html in the plan-ahead repo with a redirect stub to
   his share URL (agent prepares the stub and exact steps; pushing it is a
   Rob decision because it changes what family bookmarks see).

Acceptance: a stranger with the link sees the read-only share with no
account; rotate kills the old link (verified live); no PAT anywhere in the
product or the synced rows; grep of the shipped bytes and a published
snapshot finds no credential material.

## Phase C: Stripe subscription gate (BLOCKED on Rob)

Blocked until Rob supplies: price point, billing interval(s), and the
free-versus-paid boundary. Recommended boundary, pending his call: free =
local single-device use and paste-driven cities; paid = cross-device sync,
one-tap Claude planning, public share. Standalone exported guides stay free.

Design, so the build is mechanical once unblocked:

1. Stripe: one product, Payment Link to start, client_reference_id set to
   the Supabase user id, success URL back to the app root with a thank-you
   hash. No card data ever touches the app.
2. New Supabase Edge Function stripe-webhook: verifies the Stripe signature
   (this IS the inbound auth gate; verify_jwt stays off), handles
   checkout.session.completed, customer.subscription.updated, and
   customer.subscription.deleted, and upserts a subscriptions table:
   user_id pk, stripe_customer_id, status, current_period_end, updated_at.
   Secrets (Stripe signing secret) live in Supabase function secrets, never
   in the repo. Deploy over the management API is possible from this
   machine; DDL again goes to Rob.
3. RLS enforcement, not UI enforcement: a security definer helper
   has_active_subscription(uid) checked in the WITH CHECK of write policies
   on cities, city_state, planahead, and shares. Reads stay own-rows so a
   lapsed subscriber keeps their data and can export; they lose write-sync
   and share publishing until renewed. Grace: status past_due counts as
   active for 7 days past current_period_end.
4. App UX: subscription state chip in Profile; gated actions show a clear
   why plus the Payment Link when inactive (never a dead control). Rob and
   comp users: a manual row with status complimentary; the helper treats it
   as active.
5. Grandfathering: existing rows are untouched; enforcement applies to
   writes after deploy.

Acceptance: a user without a subscription can use everything local, and
sees exactly which features want payment; flipping a test subscription in
Stripe test mode propagates through the webhook to gated writes within a
minute; Rob's own account is complimentary.

## Phase D: managed AI proxy (built 2026-09-04)

The 29 USD tier's server. `supabase/functions/ai-proxy` holds our Anthropic key,
checks the entitlement and the tier by calling the Phase C helper, enforces a
monthly output allowance, a rolling rate limit and a per-call ceiling atomically
in the database, and streams the reply back to the browser unchanged so the
existing progress UI never learned anything new. Deployed with verify_jwt ON.

Caps, named in both the function and the SQL: 350,000 output tokens a calendar
month (about 12 city guides), 5 generation-scale calls an hour and 60 small
ones, 1 in flight at a time, 32,000 max_tokens per call on the city path. The
whole call is HELD against the allowance up front and released when it closes,
because a run whose connection is abandoned never reports what it cost and would
otherwise be free.

The bring-your-own-key path is unchanged and uncapped: a traveler with a saved
key still calls api.anthropic.com from their own browser on their own bill, and
a saved key wins over the plan.

Still not sellable, and the tier flip is deliberately NOT in this batch. Two
things only Rob can do stand between here and a working 29 USD tier:

1. Run `docs/sql/2026-09-04-ai-usage.sql` in the SQL editor.
2. Set `ANTHROPIC_API_KEY` in the function secrets.

Then flip three lines: `BILLING_MANAGED_LIVE = false` to `true` in
`src/app-shell.html` and `src/trip-shell.html`, and `sellable: false` to `true`
on the managed plan in `src/cityops.js`, plus the two tests that pin them.

Kill switch: the secret `AI_PROXY_DISABLED=1` stops all spend on our key on the
next call, with no deploy and no code change.

## Open items ledger

- Rob action (Phase D): run the AI allowance SQL, set ANTHROPIC_API_KEY, then
  flip the managed tier live.
- Rob decision (Phase D): whether `AI_PROXY_TIERS` should include
  `complimentary`. It defaults to `managed` only, which means Rob's own
  grandfathered account cannot use the proxy until he widens it. Every
  grandfathered account is complimentary, so widening it hands them all managed
  AI on our key, capped at 350k output tokens each per month.
- Rob decision: Phase C pricing, interval, free-tier boundary.
- Rob decision: eventual product name and domain (robriggs.com subdomains
  and the personal free-tier Supabase org are fine until real customers).
- Rob action in Phase B: run the shares DDL; later flip wheres to the
  redirect stub.
- Deferred from earlier batches, unrelated: expanded-card control rows wrap
  on dense data at 390px; diacritic-tolerant stop-to-guide matching on the
  resolver side.
