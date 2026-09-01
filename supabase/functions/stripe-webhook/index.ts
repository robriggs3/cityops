// Supabase Edge Function: stripe-webhook
//
// Deploy with verify_jwt OFF. That is not an oversight and not a shortcut: Stripe
// does not hold a Supabase JWT and never will, so the platform gate would reject
// every real event and accept nothing. THE SIGNATURE CHECK BELOW IS THE INBOUND
// AUTH GATE. It runs before anything is parsed, it is the first thing this file
// does with the body, and no code path reaches the database without passing it.
//
// Secrets, all set with `supabase secrets set` and never in the repo:
//   STRIPE_WEBHOOK_SECRET   whsec_... from the webhook endpoint's signing secret
//   STRIPE_SECRET_KEY       sk_live_... or sk_test_..., used to read a subscription back
//   STRIPE_PRICE_BYOK       price_... for Bring your own key, 15 USD a month
//   STRIPE_PRICE_MANAGED    price_... for Everything included, 29 USD a month
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//
// What it maintains: one row per user in public.subscriptions. The service role
// bypasses RLS, which is the whole reason that table has no client write policy.

const STRIPE_API = "https://api.stripe.com/v1";
const TOLERANCE_SECONDS = 300;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error("missing secret: " + name);
  return v;
}

// ---- signature verification ----

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Length-independent, value-independent comparison. String equality on a secret
// leaks where the first difference is, one measurable microsecond at a time.
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256. The header carries
// the timestamp and one or more v1 signatures; more than one appears while a
// secret is being rotated, and any of them matching is a valid request.
async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!header) return { ok: false, why: "no stripe-signature header" };

  let timestamp = "";
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") candidates.push(v);
  }
  if (!timestamp || !candidates.length) return { ok: false, why: "malformed signature header" };

  // Replay window. Without this, a signature captured once stays valid forever.
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return { ok: false, why: "unparseable timestamp" };
  const age = Math.abs(Math.floor(Date.now() / 1000) - sent);
  if (age > TOLERANCE_SECONDS) return { ok: false, why: "timestamp outside tolerance" };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp + "." + rawBody),
  );
  const expected = hex(mac);

  // Every candidate is checked, and the loop is not short-circuited on the first
  // match, so the time this takes does not depend on which one matched.
  let matched = false;
  for (const c of candidates) {
    if (timingSafeEqual(expected, c)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, why: "signature mismatch" };
}

// ---- Stripe reads ----

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(STRIPE_API + path, {
    headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY") },
  });
  if (!res.ok) throw new Error("stripe GET " + path + " -> " + res.status);
  return await res.json();
}

function tierForPrice(priceId: string | null): "byok" | "managed" | null {
  if (!priceId) return null;
  if (priceId === Deno.env.get("STRIPE_PRICE_BYOK")) return "byok";
  if (priceId === Deno.env.get("STRIPE_PRICE_MANAGED")) return "managed";
  return null;
}

function isoOrNull(seconds: unknown): string | null {
  return typeof seconds === "number" && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

// Everything the database wants, read off a Stripe subscription object.
//
// current_period_end is read from the ITEM first and the subscription second.
// Stripe moved it onto subscription items in the 2025-03-31 API version and
// dropped it from the top level, so reading only `sub.current_period_end` gets
// null on any modern account. That null is not cosmetic: it is the date the
// 7 day grace window is measured from, so losing it shortens or removes the
// grace a past_due customer is owed. Both are read, newer shape first.
function readSubscription(sub: Record<string, any>) {
  const item = sub?.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  const periodEnd = item?.current_period_end ?? sub?.current_period_end ?? null;
  return {
    stripe_subscription_id: String(sub.id),
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    status: String(sub.status ?? "incomplete"),
    current_period_end: isoOrNull(periodEnd),
    trial_ends_at: isoOrNull(sub.trial_end),
    tier: tierForPrice(priceId),
    priceId,
  };
}

// ---- database writes ----

function dbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(env("SUPABASE_URL") + "/rest/v1" + path, {
    ...init,
    headers: dbHeaders(init.headers as Record<string, string> ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("db " + path + " -> " + res.status + " " + text);
  return text ? JSON.parse(text) : null;
}

// A complimentary row is a decision the owner made, not a state Stripe owns.
// Every Stripe-driven write below excludes it, so a comp account that happens to
// run a checkout for testing does not silently demote itself to a paid tier.
const NOT_COMP = "&tier=neq.complimentary";

async function upsertByUser(userId: string, patch: Record<string, unknown>) {
  await db("/subscriptions?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ user_id: userId, ...patch, updated_at: new Date().toISOString() }]),
  });
}

async function patchByCustomer(customerId: string, patch: Record<string, unknown>): Promise<number> {
  const rows = await db(
    "/subscriptions?stripe_customer_id=eq." + encodeURIComponent(customerId) + NOT_COMP,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    },
  );
  return Array.isArray(rows) ? rows.length : 0;
}

// ---- event handlers ----

// The authoritative mapping event: it is the only one that carries our user id.
// It also reads the subscription back from Stripe rather than trusting the
// session object, because the session says almost nothing about the period.
async function onCheckoutCompleted(session: Record<string, any>) {
  const userId = session.client_reference_id;
  if (!userId || typeof userId !== "string") {
    console.log("checkout.session.completed with no client_reference_id, session", session.id);
    return;
  }
  if (session.mode !== "subscription") {
    console.log("checkout.session.completed in mode", session.mode, "ignored");
    return;
  }
  const subId = typeof session.subscription === "string"
    ? session.subscription
    : session.subscription?.id;
  if (!subId) {
    console.log("checkout.session.completed with no subscription, session", session.id);
    return;
  }
  const sub = await stripeGet("/subscriptions/" + subId);
  const r = readSubscription(sub);
  if (!r.tier) {
    // An unmapped price is a configuration mistake, and guessing a tier for a
    // real payment is worse than refusing to. Loud, and no write.
    console.error("no tier for price", r.priceId, "on subscription", subId, "- check STRIPE_PRICE_* secrets");
    return;
  }

  // A complimentary account is a decision the owner made, and a checkout does
  // not overrule it. This matters in practice rather than in theory: the first
  // person to run a test purchase through this endpoint is the owner, whose own
  // row is complimentary, and an unguarded upsert would quietly demote him to a
  // paid tier as the reward for testing his own checkout. The customer id is
  // still recorded, so the billing portal can find them.
  const existing = await db(
    "/subscriptions?user_id=eq." + encodeURIComponent(userId) + "&select=tier",
  );
  if (Array.isArray(existing) && existing[0]?.tier === "complimentary") {
    console.log("user", userId, "is complimentary; recording the customer id and nothing else");
    await db("/subscriptions?user_id=eq." + encodeURIComponent(userId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        stripe_customer_id: r.stripe_customer_id,
        stripe_subscription_id: r.stripe_subscription_id,
        updated_at: new Date().toISOString(),
      }),
    });
    return;
  }

  await upsertByUser(userId, {
    stripe_customer_id: r.stripe_customer_id,
    stripe_subscription_id: r.stripe_subscription_id,
    tier: r.tier,
    status: r.status,
    current_period_end: r.current_period_end,
    trial_ends_at: r.trial_ends_at,
  });
  console.log("mapped user", userId, "to", r.tier, r.status);
}

// Keyed by customer, because that is all a subscription event carries.
//
// An event for a customer we have never mapped is dropped with a 200 rather than
// retried. It is either an out-of-order delivery that checkout.session.completed
// is about to correct with a full read from the Stripe API, or a subscription
// made outside our checkout, which has no user to attribute it to anyway. Asking
// Stripe to retry those forever would only fill the log.
async function onSubscriptionChanged(sub: Record<string, any>) {
  const r = readSubscription(sub);
  if (!r.stripe_customer_id) return;
  const patch: Record<string, unknown> = {
    stripe_subscription_id: r.stripe_subscription_id,
    status: r.status,
    current_period_end: r.current_period_end,
    trial_ends_at: r.trial_ends_at,
  };
  // Only move the tier when the price is one we recognise. A plan change to an
  // unknown price leaves the tier alone rather than blanking it.
  if (r.tier) patch.tier = r.tier;
  const n = await patchByCustomer(r.stripe_customer_id, patch);
  console.log(n ? "updated " + n + " row to " + r.status : "no mapped row for customer " + r.stripe_customer_id);
}

// The row stays. It carries which tier they had and when it ended, which is what
// makes "subscribe again" a sentence the app can say to the right person.
async function onSubscriptionDeleted(sub: Record<string, any>) {
  const r = readSubscription(sub);
  if (!r.stripe_customer_id) return;
  const n = await patchByCustomer(r.stripe_customer_id, {
    status: "canceled",
    current_period_end: r.current_period_end,
  });
  console.log(n ? "canceled " + n + " row" : "no mapped row for customer " + r.stripe_customer_id);
}

// past_due starts the 7 day grace window the database helper measures from
// current_period_end. Stripe also sends customer.subscription.updated for this,
// and both landing on the same value is the point: whichever arrives first is
// correct and the second is a no-op.
//
// A canceled row is never dragged back to past_due, because a failed invoice on
// a subscription that already ended is history, not a state.
async function onPaymentFailed(invoice: Record<string, any>) {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;
  // Subscription invoices only. A failed one-off charge to the same customer is
  // not a lapsed subscription, and marking one past_due over it would start a
  // 7 day countdown on an account that is paid up.
  const subId = invoice.subscription ??
    invoice.parent?.subscription_details?.subscription ??
    invoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ?? null;
  if (!subId) {
    console.log("invoice.payment_failed with no subscription, ignored");
    return;
  }
  const rows = await db(
    "/subscriptions?stripe_customer_id=eq." + encodeURIComponent(customerId) +
      NOT_COMP + "&status=neq.canceled",
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "past_due", updated_at: new Date().toISOString() }),
    },
  );
  const n = Array.isArray(rows) ? rows.length : 0;
  console.log(n ? "marked " + n + " row past_due" : "no live row for customer " + customerId);
}

// ---- entry point ----

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // The raw body, byte for byte, BEFORE any parsing. Re-serialising parsed JSON
  // would change whitespace and key order and every signature would fail.
  const raw = await req.text();

  const verified = await verifyStripeSignature(
    raw,
    req.headers.get("stripe-signature"),
    env("STRIPE_WEBHOOK_SECRET"),
  );
  if (!verified.ok) {
    // No detail to the caller. An unsigned request learns nothing about why.
    console.warn("rejected webhook:", verified.why);
    return new Response("bad signature", { status: 400 });
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("bad body", { status: 400 });
  }

  const type = String(event.type ?? "");
  const object = event?.data?.object ?? {};

  try {
    switch (type) {
      case "checkout.session.completed":
        await onCheckoutCompleted(object);
        break;
      // created is handled alongside updated: it is the same object, it can
      // arrive first, and treating it as an update costs one statement.
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await onSubscriptionChanged(object);
        break;
      case "customer.subscription.deleted":
        await onSubscriptionDeleted(object);
        break;
      case "invoice.payment_failed":
        await onPaymentFailed(object);
        break;
      default:
        console.log("ignoring", type);
    }
  } catch (e) {
    // A 500 asks Stripe to retry, which is right for a database or network
    // fault and harmless for the rest: every handler above is idempotent.
    console.error("handler failed for", type, e instanceof Error ? e.message : String(e));
    return new Response("handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
