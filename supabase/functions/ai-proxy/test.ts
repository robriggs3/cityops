// The ai-proxy edge function, tested against the file that actually deploys.
//
//   deno test --allow-env --allow-read supabase/functions/ai-proxy/test.ts
//
// Nothing here reaches Anthropic, Supabase, or the network at all. Deno.serve is
// stubbed before the module is imported so the request handler can be called
// directly, and globalThis.fetch is stubbed so the upstream and the database are
// scripted rather than real. That is the point: every refusal path, the
// streaming pipe, the usage accounting and the kill switch are provable without
// spending one token of anybody's money.
//
// What it cannot prove, and what only a live managed subscriber can: that a real
// Anthropic key on the other end returns a real guide. That is one call, made
// once, by hand, and written down in the build report.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// ---- the harness ----

type Handler = (req: Request) => Promise<Response> | Response;

let handler: Handler;
let anthropicCalls: Array<{ url: string; init: RequestInit; body: any }> = [];
let rpcCalls: Array<{ name: string; args: any }> = [];
let scripted: {
  user: any;
  reserve: any;
  upstream: () => Response;
} = { user: null, reserve: null, upstream: () => new Response("", { status: 200 }) };

const realFetch = globalThis.fetch;

// Deno.serve, captured rather than run. No port, no listener, no teardown.
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: Handler) => {
  handler = h;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};

Deno.env.set("SUPABASE_URL", "https://project.supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-not-a-real-key");
Deno.env.set("ANTHROPIC_API_KEY", "sk-ant-THE-SECRET-THAT-MUST-NOT-LEAK");

globalThis.fetch = ((input: any, init: any = {}) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.startsWith("https://project.supabase.test/auth/v1/user")) {
    return Promise.resolve(
      scripted.user
        ? new Response(JSON.stringify(scripted.user), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
        : new Response("{}", { status: 401 }),
    );
  }

  if (url.indexOf("/rest/v1/rpc/") !== -1) {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const args = init.body ? JSON.parse(init.body) : {};
    rpcCalls.push({ name, args });
    if (name === "ai_reserve") {
      return Promise.resolve(
        new Response(JSON.stringify(scripted.reserve), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  if (url.startsWith("https://api.anthropic.com/")) {
    anthropicCalls.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(scripted.upstream());
  }

  return realFetch(input, init);
  // deno-lint-ignore no-explicit-any
}) as any;

await import("./index.ts");

function reset() {
  anthropicCalls = [];
  rpcCalls = [];
  Deno.env.delete("AI_PROXY_DISABLED");
  Deno.env.delete("AI_PROXY_MESSAGE");
  Deno.env.delete("AI_PROXY_TIERS");
  scripted.user = { id: "11111111-1111-1111-1111-111111111111" };
  scripted.reserve = {
    ok: true,
    call_id: "22222222-2222-2222-2222-222222222222",
    output_tokens_used: 0,
    output_tokens_cap: 350000,
  };
  scripted.upstream = () => sse([]);
}

const GOOD_BODY = {
  model: "claude-opus-4-8",
  max_tokens: 32000,
  stream: true,
  thinking: { type: "adaptive" },
  messages: [{ role: "user", content: "Write me a guide to Ohrid." }],
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return handler(
    new Request("https://fn.test/ai-proxy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.nomadding.com",
        authorization: "Bearer a-session-token",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

// An Anthropic SSE stream, in the exact shape the app's own parser reads.
function sse(events: unknown[]) {
  const text = events.map((e) => "event: x\ndata: " + JSON.stringify(e) + "\n\n").join("");
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const GUIDE_STREAM = [
  { type: "message_start", message: { usage: { input_tokens: 4321, output_tokens: 1 } } },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "weighing it up" } },
  { type: "content_block_delta", delta: { type: "text_delta", text: '```json\n{"schema":1}' } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "\n```" } },
  { type: "message_delta", usage: { output_tokens: 28710 } },
  { type: "message_stop" },
];

async function bodyText(res: Response) {
  return await res.text();
}

// ---- the doors ----

Deno.test("an unauthenticated call never reaches the database or Anthropic", async () => {
  reset();
  const res = await handler(
    new Request("https://fn.test/ai-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GOOD_BODY),
    }),
  );
  assertEquals(res.status, 401);
  assertEquals(rpcCalls.length, 0);
  assertEquals(anthropicCalls.length, 0);
});

Deno.test("a token the project does not recognise is refused", async () => {
  reset();
  scripted.user = null;
  const res = await post(GOOD_BODY);
  assertEquals(res.status, 401);
  assertEquals(rpcCalls.length, 0);
  assertEquals(anthropicCalls.length, 0);
});

Deno.test("the user id comes from the verified token, never from the body", async () => {
  reset();
  // A body claiming to be somebody else. The id that reaches ai_reserve is the
  // one /auth/v1/user handed back, and the claim is refused outright as an
  // unknown key before it could even be ignored.
  const res = await post({ ...GOOD_BODY, user_id: "33333333-3333-3333-3333-333333333333" });
  assertEquals(res.status, 400);
  assertStringIncludes(await bodyText(res), "user_id");
  assertEquals(anthropicCalls.length, 0);
});

Deno.test("GET is refused", async () => {
  reset();
  const res = await handler(new Request("https://fn.test/ai-proxy", { method: "GET" }));
  assertEquals(res.status, 405);
});

Deno.test("the preflight answers only the app's own origins", async () => {
  reset();
  const ok = await handler(
    new Request("https://fn.test/ai-proxy", {
      method: "OPTIONS",
      headers: { origin: "https://app.nomadding.com" },
    }),
  );
  assertEquals(ok.status, 204);
  assertEquals(ok.headers.get("access-control-allow-origin"), "https://app.nomadding.com");

  const nope = await handler(
    new Request("https://fn.test/ai-proxy", {
      method: "OPTIONS",
      headers: { origin: "https://someone-elses-app.example" },
    }),
  );
  assertEquals(nope.headers.get("access-control-allow-origin"), null);
});

// ---- the kill switch ----

Deno.test("the kill switch refuses everything, before auth and before spend", async () => {
  reset();
  Deno.env.set("AI_PROXY_DISABLED", "1");
  const res = await post(GOOD_BODY);
  assertEquals(res.status, 503);
  const j = JSON.parse(await bodyText(res));
  assertEquals(j.error.paused, true);
  // Never a bare refusal: the free path is named in the sentence itself.
  assertStringIncludes(j.error.message, "free");
  assertEquals(rpcCalls.length, 0);
  assertEquals(anthropicCalls.length, 0);
});

Deno.test("the kill switch message can be set without a deploy", async () => {
  reset();
  Deno.env.set("AI_PROXY_DISABLED", "true");
  Deno.env.set("AI_PROXY_MESSAGE", "Back on Monday.");
  const res = await post(GOOD_BODY);
  assertStringIncludes(await bodyText(res), "Back on Monday.");
});

// ---- what it will and will not proxy ----

Deno.test("only the models this app calls are allowed through", async () => {
  reset();
  for (const model of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
    const res = await post({ ...GOOD_BODY, model, max_tokens: 100 });
    assertEquals(res.status, 200, model + " should be allowed");
  }
  for (const model of ["claude-3-5-sonnet-20241022", "gpt-4o", "", "claude-opus-4-8 "]) {
    reset();
    const res = await post({ ...GOOD_BODY, model, max_tokens: 100 });
    assertEquals(res.status, 400, JSON.stringify(model) + " should be refused");
    assertEquals(anthropicCalls.length, 0);
  }
});

Deno.test("a system prompt, tools, or metadata is refused outright", async () => {
  for (const extra of [
    { system: "You are a helpful pirate." },
    { tools: [{ name: "bash" }] },
    { tool_choice: { type: "any" } },
    { metadata: { user_id: "someone" } },
    { service_tier: "priority" },
    { top_p: 0.9 },
    { temperature: 0.7 },
    { container: "x" },
    { mcp_servers: [] },
  ]) {
    reset();
    const res = await post({ ...GOOD_BODY, ...extra });
    assertEquals(res.status, 400, JSON.stringify(extra) + " should be refused");
    assertEquals(anthropicCalls.length, 0, "nothing may reach Anthropic");
  }
});

Deno.test("a conversation is refused: one user message, text only", async () => {
  const bad = [
    { messages: [] },
    { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] },
    { messages: [{ role: "assistant", content: "a" }] },
    { messages: [{ role: "user", content: [{ type: "text", text: "a" }] }] },
    { messages: [{ role: "user", content: "a", cache_control: { type: "ephemeral" } }] },
    { messages: [{ role: "user", content: "" }] },
  ];
  for (const b of bad) {
    reset();
    const res = await post({ ...GOOD_BODY, ...b });
    assertEquals(res.status, 400, JSON.stringify(b) + " should be refused");
    assertEquals(anthropicCalls.length, 0);
  }
});

Deno.test("the per-call ceiling is enforced, and never silently lowered", async () => {
  reset();
  // What the app actually asks for on the city path passes untouched.
  const ok = await post({ ...GOOD_BODY, max_tokens: 32000 });
  assertEquals(ok.status, 200);
  assertEquals(anthropicCalls[0].body.max_tokens, 32000, "the real ask must not be trimmed");

  reset();
  const over = await post({ ...GOOD_BODY, max_tokens: 32001 });
  assertEquals(over.status, 400);
  assertStringIncludes(await bodyText(over), "32000");
  assertEquals(anthropicCalls.length, 0);

  // Per model, not one number for all three: a haiku geocode has no business
  // asking for a city guide's worth of output.
  reset();
  const haiku = await post({
    ...GOOD_BODY,
    model: "claude-haiku-4-5-20251001",
    max_tokens: 32000,
  });
  assertEquals(haiku.status, 400);
  assertEquals(anthropicCalls.length, 0);
});

Deno.test("only the two thinking shapes this app sends are accepted", async () => {
  for (const th of [{ type: "adaptive" }, { type: "disabled" }]) {
    reset();
    const res = await post({ ...GOOD_BODY, thinking: th });
    assertEquals(res.status, 200, JSON.stringify(th));
  }
  for (const th of [
    { type: "enabled", budget_tokens: 30000 },
    { type: "adaptive", budget_tokens: 30000 },
    { type: "whatever" },
    "adaptive",
    null,
  ]) {
    reset();
    const res = await post({ ...GOOD_BODY, thinking: th });
    assertEquals(res.status, 400, JSON.stringify(th) + " should be refused");
    assertEquals(anthropicCalls.length, 0);
  }
});

Deno.test("an oversized prompt is refused before it is forwarded", async () => {
  reset();
  const res = await post({
    ...GOOD_BODY,
    messages: [{ role: "user", content: "x".repeat(200001) }],
  });
  assertEquals(res.status, 400);
  assertEquals(anthropicCalls.length, 0);
});

// ---- the entitlement and the caps, as the database answers them ----

Deno.test("a caller the database refuses never reaches Anthropic", async () => {
  const cases: Array<[string, number]> = [
    ["not_entitled", 403],
    ["wrong_tier", 403],
    ["over_monthly_cap", 429],
    ["rate_limited", 429],
    ["busy", 429],
  ];
  for (const [reason, status] of cases) {
    reset();
    scripted.reserve = {
      ok: false,
      reason,
      message: "no",
      resets_at: "2026-10-01",
      output_tokens_used: 350000,
      output_tokens_cap: 350000,
    };
    const res = await post(GOOD_BODY);
    assertEquals(res.status, status, reason);
    const j = JSON.parse(await bodyText(res));
    // The REASON travels, which is what lets the app say the right sentence
    // rather than "Claude API returned 429".
    assertEquals(j.error.reason, reason);
    assertEquals(anthropicCalls.length, 0, reason + " must not spend anything");
  }
});

Deno.test("the tier list defaults to managed and is set by a secret, not by the caller", async () => {
  reset();
  await post(GOOD_BODY);
  assertEquals(rpcCalls[0].name, "ai_reserve");
  assertEquals(rpcCalls[0].args.allowed_tiers, ["managed"]);

  reset();
  Deno.env.set("AI_PROXY_TIERS", "managed, complimentary");
  await post(GOOD_BODY);
  assertEquals(rpcCalls[0].args.allowed_tiers, ["managed", "complimentary"]);
});

Deno.test("the caps the function enforces are the caps it tells the database", async () => {
  reset();
  await post(GOOD_BODY);
  const a = rpcCalls[0].args;
  assertEquals(a.monthly_output_cap, 350000);
  assertEquals(a.large_per_hour, 5);
  assertEquals(a.large_call_min_tokens, 8000);
  assertEquals(a.inflight_limit, 1);
  assertEquals(a.want_max_tokens, 32000);
  assertEquals(a.uid, "11111111-1111-1111-1111-111111111111");
});

// ---- the pipe ----

Deno.test("the stream is passed through byte for byte", async () => {
  reset();
  const expected = GUIDE_STREAM.map((e) => "event: x\ndata: " + JSON.stringify(e) + "\n\n").join("");
  scripted.upstream = () => sse(GUIDE_STREAM);
  const res = await post(GOOD_BODY);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(await bodyText(res), expected, "the app's own SSE parser is on the other end");
});

Deno.test("our key goes upstream and never comes back", async () => {
  reset();
  scripted.upstream = () => sse(GUIDE_STREAM);
  const res = await post(GOOD_BODY);
  const out = await bodyText(res);
  const headers = anthropicCalls[0].init.headers as Record<string, string>;
  assertEquals(headers["x-api-key"], "sk-ant-THE-SECRET-THAT-MUST-NOT-LEAK");
  assertEquals(out.indexOf("sk-ant-"), -1, "the key must never appear in a response body");
  for (const [, v] of res.headers) {
    assertEquals(String(v).indexOf("sk-ant-"), -1, "the key must never appear in a response header");
  }
  // And the request is REBUILT, not forwarded: nothing the caller sent that was
  // not read and checked above can ride along.
  assertEquals(Object.keys(anthropicCalls[0].body).sort(),
    ["max_tokens", "messages", "model", "stream", "thinking"]);
});

Deno.test("usage is recorded from what Anthropic reported, not from an estimate", async () => {
  reset();
  scripted.upstream = () => sse(GUIDE_STREAM);
  const res = await post(GOOD_BODY);
  await bodyText(res);
  const finish = rpcCalls.filter((c) => c.name === "ai_finish")[0];
  assert(finish, "the call has to be closed");
  assertEquals(finish.args.call_id, "22222222-2222-2222-2222-222222222222");
  assertEquals(finish.args.input_tokens, 4321);
  // The running output total is REPLACED by the last one reported, not summed:
  // message_start says 1 and message_delta says 28710, and the answer is 28710.
  // Thinking tokens are already inside that number, because that is how they
  // are billed.
  assertEquals(finish.args.output_tokens, 28710);
  assertEquals(finish.args.call_status, "done");
});

Deno.test("a non-streaming call records its usage too", async () => {
  reset();
  scripted.upstream = () =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: '{"lat":41.1,"lng":20.8}' }],
        usage: { input_tokens: 120, output_tokens: 34 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const res = await post({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{ role: "user", content: "Where is Ohrid?" }],
  });
  assertEquals(res.status, 200);
  assertEquals(JSON.parse(await bodyText(res)).usage.output_tokens, 34);
  const finish = rpcCalls.filter((c) => c.name === "ai_finish")[0];
  assertEquals(finish.args.input_tokens, 120);
  assertEquals(finish.args.output_tokens, 34);
});

Deno.test("cancelling stops the upstream and still records what was produced", async () => {
  reset();
  // The abort signal the function hands the upstream fetch. If this never
  // fires, a traveler who presses Cancel keeps paying for a guide nobody will
  // read, all the way to 32,000 tokens.
  let aborted = false;
  const beforeUpstream = scripted.upstream;
  scripted.upstream = () => {
    const call = anthropicCalls[anthropicCalls.length - 1];
    const signal = (call.init as RequestInit).signal;
    if (signal) signal.addEventListener("abort", () => { aborted = true; });
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          "event: x\ndata: " +
            JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 900, output_tokens: 1 } } }) +
            "\n\n",
        ));
        // and then never finishes, exactly like a guide mid-generation
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const res = await post(GOOD_BODY);
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  // The cancel path is async; give it the turn of the loop it needs.
  await new Promise((r) => setTimeout(r, 20));
  assert(aborted, "cancelling must abort the upstream, or we keep paying for it");
  const finish = rpcCalls.filter((c) => c.name === "ai_finish")[0];
  assert(finish, "a cancelled call must still be closed, or the in-flight slot wedges");
  assertEquals(finish.args.call_status, "canceled");
  assertEquals(finish.args.input_tokens, 900);
  scripted.upstream = beforeUpstream;
});

Deno.test("an upstream failure is closed out and told plainly", async () => {
  reset();
  scripted.upstream = () =>
    new Response(JSON.stringify({ error: { message: "your credit balance is too low" } }), {
      status: 400,
    });
  const res = await post(GOOD_BODY);
  assertEquals(res.status, 502);
  const said = await bodyText(res);
  // The upstream message is logged, never handed back: it is the one place an
  // account detail or a key could surface to a stranger.
  assertEquals(said.indexOf("credit balance"), -1);
  const finish = rpcCalls.filter((c) => c.name === "ai_finish")[0];
  assertEquals(finish.args.call_status, "error");
  assertEquals(finish.args.output_tokens, 0);
});
