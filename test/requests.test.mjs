import assert from "node:assert/strict";
import { test } from "node:test";
import { ZenFreeAllPlugin, KiloFreeAllPlugin } from "../index.mjs";
import { createDiscovery } from "../src/discovery.mjs";

const zenList = { data: [
  { id: "jev-1.13-free" }, { id: "big-pickle" }, { id: "muse-spark-1.3-contributor-free" },
] };
const zenMetadata = { opencode: { npm: "@ai-sdk/openai-compatible", models: {
  "big-pickle": { cost: { input: 0, output: 0 }, interleaved: { field: "reasoning_content" } },
  "muse-spark-1.3-contributor-free": { cost: { input: 0, output: 0 }, provider: { npm: "@ai-sdk/openai" } },
} } };
const docs = "| Jev | jev-1.13-free | `https://opencode.ai/inference/systemone/v1/systemone` | - |\n";

function zenFetch(calls, listing = zenList) {
  return async (url, init = {}) => {
    if (!init.method) {
      if (url.endsWith("/models")) return Response.json(listing);
      if (url.endsWith("api.json")) return Response.json(zenMetadata);
      if (url.endsWith("models.mdx")) return new Response(docs);
    }
    calls.push({ url, init });
    throw new Error("sent upstream");
  };
}

test("Jev sends native state/questions without chat tools or streaming, and rejects chat", async () => {
  const calls = [];
  const hooks = await ZenFreeAllPlugin({}, { fetchImpl: zenFetch(calls) });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  const payload = { model: "jev-1.13-free", state: "broken order", questions: {
    replace: { type: "noul", instructions: "Was a replacement requested?" },
  } };
  await assert.rejects(loader.fetch("https://opencode.ai/inference/v1/systemone", {
    method: "POST", body: JSON.stringify(payload),
  }), /sent upstream/);
  assert.equal(calls[0].url, "https://opencode.ai/inference/systemone/v1/systemone");
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
  assert.equal(calls[0].init.headers.authorization, "Bearer public");
  await assert.rejects(loader.fetch("https://opencode.ai/inference/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "jev-1.13-free", messages: [] }),
  }), /classifier, not a chat model/);
  assert.equal(calls.length, 1);
});

test("Zen chat and Responses dispatch to their current native upstream paths", async () => {
  const calls = [];
  const hooks = await ZenFreeAllPlugin({}, { fetchImpl: zenFetch(calls) });
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "public" }));
  await assert.rejects(loader.fetch("https://opencode.ai/inference/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "Hi" }] }),
  }), /sent upstream/);
  await assert.rejects(loader.fetch("https://opencode.ai/inference/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "muse-spark-1.3-contributor-free", input: "Hi" }),
  }), /sent upstream/);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://opencode.ai/inference/openai/v1/chat/completions",
    "https://opencode.ai/inference/openai/v1/responses",
  ]);
  const models = await hooks.provider.models({}, { auth: { type: "api", key: "public" } });
  assert.deepEqual(models["big-pickle"].capabilities.interleaved, { field: "reasoning_content" });
});

test("Kilo anonymous omits Authorization, optional key adds it, and a charged model never posts", async () => {
  const calls = [];
  const list = { data: [
    { id: "kilo-auto/free", pricing: { prompt: "0", completion: "0", request: "0" } },
    { id: "charged:free", pricing: { prompt: "0", completion: "1" } },
  ] };
  const fetchImpl = async (url, init = {}) => {
    if (!init.method) return Response.json(list);
    calls.push({ url, init });
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  const hooks = await KiloFreeAllPlugin({}, { fetchImpl });
  const post = async (account, model = "kilo-auto/free") => {
    const loader = await hooks.auth.loader(async () => account);
    return loader.fetch("https://ai-gateway.kilo.ai/api/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }] }),
    });
  };
  assert.equal((await post({ type: "api", key: "anonymous", metadata: { mode: "anonymous" } })).status, 200);
  assert.equal(new Headers(calls[0].init.headers).has("authorization"), false);
  assert.equal((await post({ type: "api", key: "private-example" })).status, 200);
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer private-example");
  assert.equal((await post({ type: "api", key: "anonymous" }, "charged:free")).status, 404);
  assert.equal(calls.length, 2);
});

test("concurrent catalog refreshes coalesce and a TTL expiry refreshes again", async () => {
  let calls = 0;
  let clock = 10;
  const discovery = createDiscovery({ ttlMs: 30, now: () => clock, load: async () => {
    calls++;
    await Promise.resolve();
    return { free: { id: "free" } };
  } });
  await Promise.all([discovery.requireModel("free"), discovery.requireModel("free")]);
  assert.equal(calls, 1);
  clock = 41;
  await discovery.requireModel("free");
  assert.equal(calls, 2);
});

test("official Console API key can authenticate via third-party Magpie provider", async () => {
  const calls = [];
  const hooks = await ZenFreeAllPlugin({}, { fetchImpl: zenFetch(calls) });
  assert.equal(hooks.auth.methods.length, 2);
  const auth = { type: "api", key: "sk-console-example-key" };
  const loader = await hooks.auth.loader(async () => auth);
  assert.equal(loader.apiKey, auth.key);
  assert.ok((await hooks.provider.models({}, { auth }))["big-pickle"]);
  for (const [endpoint, payload] of [
    ["chat/completions", { model: "big-pickle", messages: [{ role: "user", content: "hi" }] }],
    ["responses", { model: "muse-spark-1.3-contributor-free", input: "hi" }],
    ["systemone", { model: "jev-1.13-free", state: "hi",
      questions: { ok: { type: "noul", instructions: "Is this a greeting?" } } }],
  ]) {
    await assert.rejects(loader.fetch("https://opencode.ai/inference/v1/" + endpoint, {
      method: "POST", body: JSON.stringify(payload),
    }), /sent upstream/);
  }
  assert.equal(calls.length, 3);
  for (const call of calls) {
    if (new URL(call.url).pathname.endsWith("/chat/completions") ||
        new URL(call.url).pathname.endsWith("/responses")) {
      const body = JSON.parse(call.init.body);
      assert.equal(body.tools, undefined, "no fabricated CLI tool definitions with Console API key");
    }
    const h = new Headers(call.init.headers);
    assert.equal(h.has("x-api-key") ? h.get("x-api-key") : h.get("authorization"),
      h.has("x-api-key") ? auth.key : "Bearer " + auth.key);
    assert.equal(h.get("user-agent"), "magpie-free-gateways/0.1.4");
    assert.equal(h.has("x-opencode-client"), false);
  }
});

test("Zen FreeTierError is explained without masking the upstream access refusal", async () => {
  const auth = { type: "api", key: "public" };
  const fetchImpl = async (url, init = {}) => {
    if (!init.method && url.endsWith("/models")) return Response.json(zenList);
    if (!init.method && url.endsWith("api.json")) return Response.json(zenMetadata);
    if (!init.method && url.endsWith("models.mdx")) return new Response(docs);
    return new Response(JSON.stringify({
      type: "error", error: {
        type: "FreeTierError",
        message: "OpenCode's free tier can only be used from within OpenCode",
      },
    }), { status: 403, headers: { "content-type": "application/json" } });
  };
  const hooks = await ZenFreeAllPlugin({}, { fetchImpl });
  const loader = await hooks.auth.loader(async () => auth);
  const reply = await loader.fetch("https://opencode.ai/inference/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "big-pickle",
      messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(reply.status, 403);
  assert.equal(reply.headers.get("x-magpie-sign-in"), "kept");
  const error = await reply.json();
  assert.equal(error.error.type, "FreeTierError");
  assert.match(error.error.message, /official OpenCode app/);
  assert.match(error.error.message, /Console API key/);
});
