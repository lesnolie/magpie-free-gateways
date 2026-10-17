import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSnapshot, updateVersions } from "../scripts/sync-opencode.mjs";

const prior = {
  source: "live",
  captured_at: "2026-10-17",
  models: [
    { id: "old-free", name: "Old", protocol: "chat",
      limit: { context: 10000, output: 1000 },
      modalities: { input: ["text"], output: ["text"] },
      reasoning: false, tool_call: false, interleaved: false,
      reasoning_options: [], upstream_status: "active" },
  ],
};
const zeros = { input: 0, output: 0, cache_read: 0, context_over_200k: { input: 0, output: 0 } };

test("sync includes only live zero-cost models and respects endpoint protocols", () => {
  const listing = { data: [
    { id: "new-free" }, { id: "gev-free" }, { id: "zero-without-suffix" },
    { id: "charged-free" }, { id: "untyped-free" }, { id: "test" },
  ] };
  const metadata = { opencode: { npm: "@ai-sdk/openai-compatible", models: {
    "new-free": { name: "New", provider: { npm: "@ai-sdk/openai" }, cost: zeros,
      limit: { context: 8192, output: 512 }, tool_call: true },
    "gev-free": { cost: zeros },
    "zero-without-suffix": { cost: zeros },
    "charged-free": { cost: { input: 0, output: 0, context_over_200k: { input: 1, output: 0 } } },
    "untyped-free": { provider: { npm: "@ai-sdk/google" }, cost: zeros },
  } } };
  const result = buildSnapshot({
    listing, metadata, previous: prior, old: prior, date: "2026-10-18",
  });
  assert.deepEqual(result.models.map((m) => m.id), [
    "new-free", "gev-free", "zero-without-suffix",
  ]);
  assert.equal(result.models[0].protocol, "responses");
  assert.equal(result.models[1].protocol, "chat");
  assert.equal(result.models[0].tool_call, true);
  assert.equal(result.captured_at, "2026-10-18");
});

test("sync preserves snapshot timestamp when upstream models are identical", () => {
  const metadata = { opencode: { npm: "@ai-sdk/openai-compatible", models: {
    "old-free": { cost: zeros, name: "Old" },
  } } };
  const result = buildSnapshot({
    listing: { data: [{ id: "old-free" }] },
    metadata, old: prior, date: "2026-10-19",
  });
  assert.deepEqual(result, prior);
});

test("sync refuses an outage or an implausible empty catalog", () => {
  assert.throws(() => buildSnapshot({
    listing: { data: [] }, metadata: { opencode: { models: {} } }, old: prior,
  }), /empty/);
  assert.throws(() => buildSnapshot({
    listing: { data: [{ id: "old-free" }] }, metadata: {}, old: prior,
  }), /pricing/);
  assert.throws(() => buildSnapshot({
    listing: { data: [{ id: "paid" }] },
    metadata: { opencode: { models: { paid: { cost: { input: 0, output: 1 } } } } },
    old: prior,
  }), /Implausible/);
});

test("v1 update does not claim v2 API compatibility", () => {
  const initial = {
    current: { opencode1: "1.19.3", opencode2: "2.0.31" },
    zenSource: 'const OPENCODE_VERSION = "1.19.3";\n',
  };
  const result = updateVersions({ ...initial, v1: "1.19.4", v2: "2.0.33" });
  assert.deepEqual(result.state, { opencode1: "1.19.4", opencode2: "2.0.33" });
  assert.match(result.zenSource, /OPENCODE_VERSION = "1\.19\.4"/);
  assert.throws(() => updateVersions({ ...initial, v1: "2.0.4" }), /v1/);
});
