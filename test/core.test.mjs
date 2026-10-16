import assert from "node:assert/strict";
import { test } from "node:test";
import { ZenFreeAllPlugin, KiloFreeAllPlugin } from "../index.mjs";
import { createDiscovery } from "../src/discovery.mjs";
import { buildZenModels, buildKiloModels, zenSnapshot, kiloSnapshot } from "../src/models.mjs";

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
  assert.equal(Object.keys(config.provider["zen-free-all"].models).length, 11);
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
