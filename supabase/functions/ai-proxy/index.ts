// Supabase Edge Function: ai-proxy
//
// The server the 29 USD tier is. A managed subscriber has no Anthropic key of
// their own, so the app sends its prompt here, this function adds OUR key, and
// the stream comes back to the browser byte for byte. The key never reaches a
// browser, never appears in a response, and never appears in a log line.
//
// Deploy with verify_jwt TRUE. That is the opposite of the stripe-webhook next
// door, and for the opposite reason: Stripe has no Supabase JWT and never will,
// while every caller here is a signed-in user of our own app who has one. The
// platform gate is the first door. It is NOT the only one: the user id is read
// back from /auth/v1/user with that same token rather than parsed out of the
// request, so a body claiming to be somebody else is not a thing that exists,
// and a day when verify_jwt gets flipped off by accident is a day this function
// still refuses everything unauthenticated.
//
// Secrets, set at
//   https://supabase.com/dashboard/project/ggscdbbvqmqiyguiccrf/functions/secrets
//   ANTHROPIC_API_KEY   REQUIRED. The key the whole tier runs on.
//   AI_PROXY_DISABLED   The kill switch. Set it to 1/true/on and every call is
//                       refused with a sentence, instantly, with no deploy.
//   AI_PROXY_MESSAGE    Optional. What the refusal says while it is disabled.
//   AI_PROXY_TIERS      Optional. Comma separated subscription tiers allowed
//                       through. Defaults to "managed" and nothing else.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//
// What it will NOT do, because a paid relay to a frontier model is worth more
// than 29 USD a month to the wrong buyer:
//   - one endpoint, /v1/messages, hardcoded, never taken from the request
//   - three models, the three this app actually calls, by exact string
//   - no `system`, no `tools`, no `tool_choice`: the app sends none of them,
//     so accepting them would only ever serve somebody else's product
//   - exactly one user message, string content, no images and no documents,
//     so there is no conversation to hold and every call starts cold
//   - a max_tokens ceiling, an input size ceiling, and an allowlist of the
//     top level keys, so a parameter Anthropic invents next month cannot ride
//     in before anyone here has decided what it costs
// What that still leaves a determined subscriber is written down in the build
// report rather than pretended away: one 32k-output single-turn question at a
// time, 5 an hour, until the monthly output allowance runs out.

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ---- the caps, in one place, in the same words the app and the SQL use ----
//
// 350,000 output tokens a month is about 12 city guides. A guide is the biggest
// thing this app asks for and the only thing that gets near the per-call
// ceiling, so it is the honest unit to size the allowance in.
const AI_MONTHLY_OUTPUT_TOKENS = 350000;
// Per call. The city generation path asks for exactly this and needs it; the
// point of the ceiling is a client asking for MORE, not this app asking for
// what it has always asked for.
const AI_MAX_TOKENS_CEILING = 32000;
// A generation-scale call. Below this line a call is one of the trip surface's
// small asks (a geocode is 100 tokens, a score is 1500), and charging those
// against a budget sized for whole city guides would make the trip page
// unusable for the people paying the most.
const AI_LARGE_CALL_MIN_TOKENS = 8000;
const AI_LARGE_CALLS_PER_HOUR = 5;
const AI_SMALL_CALLS_PER_HOUR = 60;
// One at a time. A city guide takes 2 to 4 minutes, and two of them at once is
// either two tabs or a script, and the answer to both is "finish the first".
const AI_INFLIGHT_LIMIT = 1;
// Roughly 50k input tokens. Every prompt this app builds is far under it.
const AI_MAX_PROMPT_CHARS = 200000;

// The models this app calls, by exact string. Anything else is refused before
// a single token is spent.
const ALLOWED_MODELS: Record<string, number> = {
  // The city guide, on the cities surface. The big one.
  "claude-opus-4-8": AI_MAX_TOKENS_CEILING,
  // Research, notes, scoring, on the trip surface.
  "claude-sonnet-4-6": 8000,
  // Geocoding, on the trip surface. A hundred tokens and a country code.
  "claude-haiku-4-5-20251001": 1000,
};

// The only top level keys a request may carry. Not "the ones we read": the ones
// it may CONTAIN. An unknown key is a refusal, because the next parameter
// Anthropic ships is one nobody here has priced yet.
const ALLOWED_BODY_KEYS = ["model", "max_tokens", "messages", "stream", "thinking"];

const CORS_ORIGINS = [
  "https://app.nomadding.com",
  "https://nomadding.com",
  "https://robriggs3.github.io",
];

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error("missing secret: " + name);
  return v;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

// A localhost port is a developer on this machine, holding a real session token
// for a real account, spending that account's own allowance. Any other origin
// gets no CORS headers, which is a browser-level refusal on top of every other
// door below.
function corsOrigin(req: Request): string {
  const origin = req.headers.get("origin") || "";
  if (CORS_ORIGINS.indexOf(origin) !== -1) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return "";
}

function corsHeaders(req: Request): Record<string, string> {
  const o = corsOrigin(req);
  if (!o) return {};
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

// Every refusal is a sentence a person can read, because the app shows it as-is.
// None of them ever carries a key, a header or an upstream error verbatim.
function refuse(req: Request, status: number, message: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ error: { message: message, ...extra } }), {
    status: status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

// ---- who is calling ----

// The token, verified by asking the project who it belongs to. This is the
// authoritative read: not the request body, not a decoded claim we trusted
// ourselves. It also costs one round trip, which on a call that runs for
// minutes is not a number worth optimising against being sure.
async function whoIs(token: string): Promise<{ id: string } | null> {
  const res = await fetch(env("SUPABASE_URL") + "/auth/v1/user", {
    headers: {
      apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: "Bearer " + token,
    },
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  const id = j && typeof j.id === "string" ? j.id : "";
  return id ? { id } : null;
}

// ---- the database ----

function dbHeaders(): Record<string, string> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(env("SUPABASE_URL") + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: dbHeaders(),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("rpc " + name + " -> " + res.status + " " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// ---- request validation ----
//
// Everything here runs BEFORE the database is touched and long before Anthropic
// is, so a malformed or over-reaching request costs one CPU millisecond and no
// money at all.

type Checked = {
  model: string;
  maxTokens: number;
  stream: boolean;
  body: Record<string, unknown>;
};

function check(raw: unknown): { ok: true; value: Checked } | { ok: false; why: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, why: "The request body has to be a JSON object." };
  }
  const body = raw as Record<string, unknown>;

  for (const k of Object.keys(body)) {
    if (ALLOWED_BODY_KEYS.indexOf(k) === -1) {
      // Named, so a future change to this app gets a clear failure rather than
      // a silent one, and a stranger learns only which key we do not take.
      return { ok: false, why: 'This service does not accept "' + k + '" on a request.' };
    }
  }

  const model = typeof body.model === "string" ? body.model : "";
  const ceiling = Object.prototype.hasOwnProperty.call(ALLOWED_MODELS, model)
    ? ALLOWED_MODELS[model]
    : null;
  if (ceiling === null) {
    return { ok: false, why: "That model is not one this service runs." };
  }

  const maxTokens = typeof body.max_tokens === "number" ? Math.floor(body.max_tokens) : 0;
  if (!(maxTokens > 0)) {
    return { ok: false, why: "max_tokens has to be a positive whole number." };
  }
  if (maxTokens > ceiling) {
    // The ask is refused rather than quietly lowered. Trimming it would hand
    // back a guide that stops mid-sentence and look like the model's fault.
    return {
      ok: false,
      why: "max_tokens of " + maxTokens + " is over this service's ceiling of " + ceiling +
        " for that model.",
    };
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1) {
    return { ok: false, why: "This service takes exactly one message per call." };
  }
  const m0 = messages[0] as Record<string, unknown>;
  if (!m0 || typeof m0 !== "object" || m0.role !== "user") {
    return { ok: false, why: "The one message has to be a user message." };
  }
  if (typeof m0.content !== "string") {
    // A string, not a block array: no images, no documents, no cached prefix,
    // and no way to smuggle a system prompt in as a content block.
    return { ok: false, why: "Message content has to be text." };
  }
  if (!m0.content.length) {
    return { ok: false, why: "The prompt is empty." };
  }
  if (m0.content.length > AI_MAX_PROMPT_CHARS) {
    return { ok: false, why: "That prompt is longer than this service accepts." };
  }
  for (const k of Object.keys(m0)) {
    if (k !== "role" && k !== "content") {
      return { ok: false, why: 'A message may not carry "' + k + '".' };
    }
  }

  if (body.thinking !== undefined) {
    // The two shapes this app sends, and no third. `enabled` with an explicit
    // budget is a knob nobody here needs, and every knob is a thing somebody
    // else can turn.
    const th = body.thinking as Record<string, unknown>;
    if (!th || typeof th !== "object" || Array.isArray(th) ||
      (th.type !== "adaptive" && th.type !== "disabled") ||
      Object.keys(th).length !== 1) {
      return { ok: false, why: "thinking has to be adaptive or disabled." };
    }
  }

  return {
    ok: true,
    value: { model: model, maxTokens: maxTokens, stream: body.stream === true, body: body },
  };
}

// ---- usage, read off what Anthropic reports and nothing else ----
//
// Never an estimate and never a character count. Thinking tokens are billed as
// output and Anthropic already counts them inside output_tokens, so the number
// on the wire is the number recorded.

type Usage = { input: number; output: number };

function addUsage(into: Usage, u: any) {
  if (!u || typeof u !== "object") return;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
  // message_start carries the input count and a first output count;
  // message_delta carries the final output count. Input is additive across the
  // cache fields, output is a running total that is REPLACED, not summed.
  const inp = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
  if (inp) into.input += inp;
  const out = n(u.output_tokens);
  if (out > into.output) into.output = out;
}

// ---- entry point ----

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return refuse(req, 405, "This endpoint takes POST.");
  }

  // The kill switch, first, before anything else costs anything. Set the secret
  // and the next invocation refuses; no deploy, no code change, no wait.
  if (truthy(Deno.env.get("AI_PROXY_DISABLED"))) {
    return refuse(req, 503,
      Deno.env.get("AI_PROXY_MESSAGE") ||
      "AI on our key is paused right now. Copy the prompt and run it in your own Claude or " +
      "ChatGPT: that path is free and it is right here. Everything you have made is untouched.",
      { paused: true });
  }

  const auth = req.headers.get("authorization") || "";
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() || "";
  if (!token) {
    return refuse(req, 401, "Sign in to use AI on our key.");
  }

  let user: { id: string } | null = null;
  try {
    user = await whoIs(token);
  } catch (e) {
    console.error("auth lookup failed:", e instanceof Error ? e.message : String(e));
    return refuse(req, 503, "Could not check your account just now. Try again in a moment.");
  }
  if (!user) {
    return refuse(req, 401, "That session is not valid any more. Sign in again.");
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return refuse(req, 400, "That request body is not JSON.");
  }
  const checked = check(raw);
  if (!checked.ok) {
    return refuse(req, 400, checked.why);
  }
  const { model, maxTokens, stream, body } = checked.value;

  // ONE atomic call: entitlement, tier, monthly allowance, rolling window, and
  // the in-flight count, all decided under a row lock, and a reservation handed
  // back. Two tabs pressing Generate on the same second cannot both pass it,
  // which is the entire reason this is a database function and not five reads.
  const tiers = (Deno.env.get("AI_PROXY_TIERS") || "managed")
    .split(",").map((s) => s.trim()).filter(Boolean);
  let reservation: any;
  try {
    reservation = await rpc("ai_reserve", {
      uid: user.id,
      want_max_tokens: maxTokens,
      allowed_tiers: tiers,
      large_call_min_tokens: AI_LARGE_CALL_MIN_TOKENS,
      monthly_output_cap: AI_MONTHLY_OUTPUT_TOKENS,
      large_per_hour: AI_LARGE_CALLS_PER_HOUR,
      small_per_hour: AI_SMALL_CALLS_PER_HOUR,
      inflight_limit: AI_INFLIGHT_LIMIT,
    });
  } catch (e) {
    console.error("reserve failed:", e instanceof Error ? e.message : String(e));
    return refuse(req, 503, "Could not check your allowance just now. Try again in a moment.");
  }
  if (!reservation || reservation.ok !== true) {
    const reason = String(reservation?.reason || "refused");
    const status = reason === "not_entitled" || reason === "wrong_tier" ? 403 : 429;
    return refuse(req, status, String(reservation?.message || "This call was not allowed."), {
      reason: reason,
      resets_at: reservation?.resets_at ?? null,
      output_tokens_used: reservation?.output_tokens_used ?? null,
      output_tokens_cap: reservation?.output_tokens_cap ?? null,
    });
  }
  const callId = String(reservation.call_id);

  const usage: Usage = { input: 0, output: 0 };
  let settled = false;
  async function settle(status: string) {
    if (settled) return;
    settled = true;
    try {
      await rpc("ai_finish", {
        call_id: callId,
        input_tokens: usage.input,
        output_tokens: usage.output,
        call_status: status,
      });
    } catch (e) {
      // The reservation still expires on its own (see the stale window in the
      // SQL), so a lost finish costs one slot for a few minutes, not forever.
      console.error("finish failed for", callId, e instanceof Error ? e.message : String(e));
    }
  }

  // The upstream call. The key goes on here and nowhere else, and the abort
  // controller is what stops us paying for tokens a traveler cancelled.
  const upstreamAbort = new AbortController();
  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      signal: upstreamAbort.signal,
      headers: {
        "x-api-key": env("ANTHROPIC_API_KEY"),
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      // Rebuilt from the checked values rather than forwarded, so nothing that
      // was not read above can ride along into the upstream request.
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: (body.messages as any)[0].content }],
        ...(stream ? { stream: true } : {}),
        ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
      }),
    });
  } catch (e) {
    await settle("error");
    console.error("upstream fetch failed:", e instanceof Error ? e.message : String(e));
    return refuse(req, 502, "Claude could not be reached just now. Try again in a moment.");
  }

  if (!upstream.ok || !upstream.body) {
    // The upstream body is read for the log and NOT handed back: an upstream
    // error message is the one place a key or an account detail could surface.
    const detail = await upstream.text().catch(() => "");
    console.error("upstream", upstream.status, detail.slice(0, 300));
    await settle("error");
    const msg = upstream.status === 429
      ? "Claude is rate limiting us right now. Try again in a minute."
      : "Claude returned an error (" + upstream.status + "). Nothing was charged to your allowance.";
    return refuse(req, upstream.status === 429 ? 429 : 502, msg);
  }

  if (!stream) {
    const text = await upstream.text();
    try {
      addUsage(usage, JSON.parse(text)?.usage);
    } catch { /* an unparseable success body records nothing, which is honest */ }
    await settle("done");
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders(req) },
    });
  }

  // The transparent pipe. Bytes go out exactly as they came in, because the
  // app's own SSE parser is on the other end and has been since before this
  // function existed. The usage sniffing reads the same bytes on the way past
  // and changes none of them.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sniff = "";

  const out = new ReadableStream({
    async pull(controller) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        controller.error(e);
        await settle("error");
        return;
      }
      if (r.done) {
        controller.close();
        await settle("done");
        return;
      }
      controller.enqueue(r.value);

      // Read-only sniffing, on a bounded buffer: usage lives in message_start
      // and message_delta, both small and both early or last, so the buffer is
      // trimmed rather than grown across a 32k-token guide.
      sniff += decoder.decode(r.value, { stream: true });
      let idx: number;
      while ((idx = sniff.indexOf("\n\n")) !== -1) {
        const chunk = sniff.slice(0, idx);
        sniff = sniff.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (line.indexOf("data:") !== 0) continue;
          try {
            const p = JSON.parse(line.slice(5).trim());
            if (p?.usage) addUsage(usage, p.usage);
            if (p?.message?.usage) addUsage(usage, p.message.usage);
          } catch { /* a partial or non-JSON data line tells us nothing */ }
        }
      }
      if (sniff.length > 65536) sniff = sniff.slice(-4096);
    },
    async cancel() {
      // The traveler pressed Cancel, or closed the tab. Stop Anthropic
      // generating rather than paying for an answer nobody will read, and
      // record what was actually produced up to here.
      upstreamAbort.abort();
      try { await reader.cancel(); } catch { /* already gone */ }
      await settle("canceled");
    },
  });

  return new Response(out, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      ...corsHeaders(req),
    },
  });
});
