import assert from "node:assert/strict";
import { test } from "node:test";
import { ZenFreeAllPlugin, KiloFreeAllPlugin } from "../index.mjs";

const zenAuth = { type: "api", key: "public" };
const kiloAuth = { type: "api", key: "anonymous", metadata: { mode: "anonymous" } };
const zero = { input: 0, output: 0 };

test("Zen hooks add, remove and reprice live models; stale prices cannot authorize calls", async () => {
  let clock = 0;
  let listing = ["jev-1.13-free", "muse-spark-1.3-contributor-free", "big-pickle"];
  let costs = { "big-pickle": zero };
  // Synthetic Responses fixture; the model is no longer in the live catalog.
  let otherMetadata = { "muse-spark-1.3-contributor-free": { provider: { npm: "@ai-sdk/openai" } } };
  let listingFails = false;
  let metadataFails = false;
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (!init.method && url.endsWith("/models")) {
      if (listingFails) throw new Error("listing offline");
      return Response.json({ data: listing.map((id) => ({ id })) });
    }
    if (!init.method && url.endsWith("api.json")) {
      if (metadataFails) throw new Error("metadata offline");
      return Response.json({ opencode: {
        npm: "@ai-sdk/openai-compatible",
        models: Object.fromEntries([...new Set([...Object.keys(costs), ...Object.keys(otherMetadata)])]
          .map((id) => [id, { ...(costs[id] ? { cost: costs[id] } : {}), ...otherMetadata[id] }])),
      } });
    }
    if (!init.method && url.endsWith("models.mdx")) return new Response("| Jev | jev-1.13-free | `https://opencode.ai/inference/systemone/v1/systemone` | - |\n");
    posts.push(url);
    throw new Error("posted to upstream");
  };
  const hooks = await ZenFreeAllPlugin({}, { fetchImpl, now: () => clock, ttlMs: 30 });
  const loader = await hooks.auth.loader(async () => zenAuth);
  const models = () => hooks.provider.models({}, { auth: zenAuth });
  const send = (model, path = "chat/completions", extra = {}) => loader.fetch(
    `https://opencode.ai/inference/v1/${path}`,
    { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], ...extra }) },
  );

  assert.deepEqual(Object.keys(await models()), listing);
  assert.equal((await models())["jev-1.13-free"].decides, true);
  clock = 31;
  listing.push("new-chat-free", "google-free");
  otherMetadata["google-free"] = { provider: { npm: "@ai-sdk/google" } };
  assert.ok((await models())["new-chat-free"]);
  assert.equal((await models())["google-free"], undefined);
  assert.equal((await send("google-free")).status, 404);
  await assert.rejects(send("new-chat-free"), /posted to upstream/);
  assert.equal(posts.at(-1), "https://opencode.ai/inference/openai/v1/chat/completions");
  await assert.rejects(send("jev-1.13-free"), /classifier, not a chat model/);
  await assert.rejects(send("muse-spark-1.3-contributor-free", "responses", { input: "Hi" }),
    /posted to upstream/);
  assert.equal(posts.at(-1), "https://opencode.ai/inference/openai/v1/responses");

  clock = 62;
  listing = listing.filter((id) => id !== "new-chat-free");
  assert.equal((await models())["new-chat-free"], undefined);
  assert.equal((await send("new-chat-free")).status, 404);

  clock = 93;
  listing.push("new-chat-free");
  costs["new-chat-free"] = { input: 1, output: 0 };
  assert.equal((await models())["new-chat-free"], undefined);
  assert.equal((await send("new-chat-free")).status, 404);

  clock = 124;
  listing.push("next-chat-free", "jev-2-free");
  metadataFails = true;
  const afterFailure = await models();
  assert.ok(afterFailure["next-chat-free"]);
  assert.equal(afterFailure["new-chat-free"], undefined);
  assert.equal(afterFailure["google-free"], undefined);
  assert.equal(afterFailure["jev-2-free"], undefined);
  assert.equal(afterFailure["big-pickle"], undefined);
  assert.equal(afterFailure["muse-spark-1.3-contributor-free"].api.npm, "@ai-sdk/openai");
  await assert.rejects(send("next-chat-free"), /posted to upstream/);
  assert.equal((await send("new-chat-free")).status, 404);
  assert.equal((await send("google-free")).status, 404);
  assert.equal((await send("big-pickle")).status, 404);

  clock = 155;
  metadataFails = false;
  delete costs["new-chat-free"];
  delete otherMetadata["google-free"];
  assert.equal((await models())["new-chat-free"], undefined);
  assert.equal((await models())["google-free"], undefined);
  assert.equal((await send("new-chat-free")).status, 404);
  assert.equal((await send("google-free")).status, 404);

  clock = 186;
  costs["new-chat-free"] = zero;
  assert.ok((await models())["new-chat-free"]);
  await assert.rejects(send("new-chat-free"), /posted to upstream/);

  clock = 217;
  listing = [];
  assert.deepEqual(await models(), {});
  assert.equal((await send("next-chat-free")).status, 404);

  clock = 248;
  listingFails = true;
  const stale = await models();
  assert.deepEqual(Object.keys(stale), []);
  assert.equal(stale[Symbol.for("magpie.fellBack")], true);
  assert.equal((await send("next-chat-free")).status, 503);
  assert.equal(posts.length, 4);
});

test("Kilo hooks follow a changing zero-price catalog and fail closed on outages", async () => {
  let clock = 0;
  let listing = [{ id: "kilo-auto/free", pricing: { prompt: "0", completion: "0" } }];
  let fails = false;
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (!init.method) {
      if (fails) throw new Error("listing offline");
      return Response.json({ data: listing });
    }
    posts.push(url);
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  const hooks = await KiloFreeAllPlugin({}, { fetchImpl, now: () => clock, ttlMs: 30 });
  const loader = await hooks.auth.loader(async () => kiloAuth);
  const models = () => hooks.provider.models({}, { auth: kiloAuth });
  const send = (model) => loader.fetch("https://ai-gateway.kilo.ai/api/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }] }),
  });

  assert.deepEqual(Object.keys(await models()), ["kilo-auto/free"]);
  clock = 31;
  listing.push({ id: "vendor/new:free", pricing: { prompt: "0", completion: "0", request: "0" } });
  assert.ok((await models())["vendor/new:free"]);
  assert.equal((await send("vendor/new:free")).status, 200);

  clock = 62;
  listing = listing.filter((entry) => entry.id !== "vendor/new:free");
  assert.equal((await models())["vendor/new:free"], undefined);
  assert.equal((await send("vendor/new:free")).status, 404);

  clock = 93;
  listing.push({ id: "vendor/new:free", pricing: { prompt: "0", completion: "0", image: "0.1" } });
  assert.equal((await models())["vendor/new:free"], undefined);
  assert.equal((await send("vendor/new:free")).status, 404);

  clock = 124;
  listing = [];
  assert.deepEqual(await models(), {});
  assert.equal((await send("kilo-auto/free")).status, 404);

  clock = 155;
  fails = true;
  const stale = await models();
  assert.deepEqual(Object.keys(stale), []);
  assert.equal(stale[Symbol.for("magpie.fellBack")], true);
  assert.equal((await send("kilo-auto/free")).status, 503);
  assert.deepEqual(posts, ["https://ai-gateway.kilo.ai/api/v1/chat/completions"]);
});
