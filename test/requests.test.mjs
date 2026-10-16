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
