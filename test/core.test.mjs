import assert from "node:assert/strict";
import { test } from "node:test";
import { ZenFreeAllPlugin, KiloFreeAllPlugin } from "../index.mjs";
import { createDiscovery } from "../src/discovery.mjs";
import { buildZenModels, buildKiloModels, zenSnapshot, kiloSnapshot, zenZeroCost } from "../src/models.mjs";

test("entry exports two independent provider hooks and Jev decision metadata", async () => {
  const zen = await ZenFreeAllPlugin({});
  const kilo = await KiloFreeAllPlugin({});
  const config = {};
  await zen.config(config);
  await kilo.config(config);
  assert.equal(zen.auth.provider, "zen-free-all");
  assert.equal(kilo.auth.provider, "kilo-free-all");
  assert.equal(config.provider["zen-free-all"].decide, true);
  assert.equal(config.provider["zen-free-all"].models["jev-1.13-free"].decides, true);
  assert.equal(Object.keys(config.provider["zen-free-all"].models).length, 10);
  assert.ok(config.provider["zen-free-all"].models["beam-free"]);
  assert.ok(config.provider["zen-free-all"].models["glm-5.3-flash-free"]);
  assert.equal(config.provider["zen-free-all"].models["cat-jam-free"], undefined);
  assert.equal(Object.keys(config.provider["kilo-free-all"].models).length, 17);
});

test("live catalog is authoritative and a charged price excludes a free-looking ID", () => {
  const zen = buildZenModels({ data: [
    { id: "muse-spark-1.2-contributor-free" },
    { id: "jev-1.13-free" },
    { id: "paid-free" },
    { id: "test" },
  ] }, { models: {
    "muse-spark-1.2-contributor-free": { status: "deprecated", cost: { input: 0, output: 0 } },
    "paid-free": { cost: { input: 1, output: 0 } },
  } });
  assert.deepEqual(Object.keys(zen), ["muse-spark-1.2-contributor-free", "jev-1.13-free"]);
  assert.equal(zen["muse-spark-1.2-contributor-free"].status, "active");
  assert.equal(zen["jev-1.13-free"].decides, true);
  assert.equal(buildZenModels({ data: zenSnapshot.models })["big-pickle"], undefined);
  assert.equal(buildZenModels({ data: [{ id: "big-pickle" }] },
    { models: { "big-pickle": { cost: { input: 0, output: 0 } } } })["big-pickle"].free, true);
});

test("Kilo checks every cost field and accepts zero decimal strings", () => {
  const models = buildKiloModels({ data: [
    { id: "stealth/glyph-cluster", pricing: { prompt: "0.000000000000", completion: "0", request: "0" } },
    { id: "charged:free", pricing: { prompt: "0", completion: "0", image: "0.1" } },
  ] });
  assert.deepEqual(Object.keys(models), ["stealth/glyph-cluster"]);
  assert.equal(buildKiloModels({ data: kiloSnapshot.models })["kilo-auto/free"].free, true);
});

test("failed refresh keeps display models but cannot authorize an unverified request", async () => {
  const discovery = createDiscovery({ initial: { old: {} }, load: async () => { throw new Error("offline"); } });
  const shown = await discovery.forDisplay();
  assert.equal(shown.old !== undefined, true);
  assert.equal(shown[Symbol.for("magpie.fellBack")], true);
  await assert.rejects(discovery.requireModel("old"), /offline/);
});

test("nested Zen cost tiers require every rate to be zero", () => {
  assert.equal(zenZeroCost({ input: 0, output: 0, cache_read: 0, context_over_200k: {
    input: 0, output: 0, cache_read: 0,
  } }), true);
  assert.equal(zenZeroCost({ input: 0, output: 0, context_over_200k: {
    input: 1, output: 0,
  } }), false);
  assert.equal(zenZeroCost({ input: 0, output: 0, context_over_200k: null }), false);
  assert.equal(buildZenModels({ data: [{ id: "tiered-free" }] }, { models: {
    "tiered-free": { cost: { input: 0, output: 0, context_over_200k: {
      input: 0.1, output: 0,
    } } },
  } })["tiered-free"], undefined);
});
