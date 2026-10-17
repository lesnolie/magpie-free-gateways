import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseZenProtocols, zenZeroCost } from "../src/models.mjs";

const snapshot = new URL("../src/zen-snapshot.json", import.meta.url);
const state = new URL("../src/upstream-versions.json", import.meta.url);
const client = new URL("../src/zen.mjs", import.meta.url);
const urls = {
  list: "https://opencode.ai/inference/v1/models",
  meta: "https://models.opencode.ai/api.json",
  docs: "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/models.mdx",
  v1: "https://registry.npmjs.org/opencode-ai/latest",
  v2: "https://registry.npmjs.org/@opencode%2Fcli/latest",
};
const sdks = {
  "@ai-sdk/openai-compatible": "chat",
  "@ai-sdk/openai": "responses",
  "@ai-sdk/anthropic": "anthropic",
};
async function fetchUpstream(url, impl = fetch, text = false) {
  const result = await impl(url, {
    headers: { accept: text ? "text/plain" : "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!result.ok) throw new Error("Upstream " + new URL(url).host + " HTTP " + result.status);
  return text ? result.text() : result.json();
}
async function optional(url, impl, text = false) {
  try { return await fetchUpstream(url, impl, text); }
  catch (error) {
    console.warn("Optional upstream unavailable: " + error.message);
    return undefined;
  }
}
export function buildSnapshot({ listing, metadata, docs = "", old, date }) {
  if (!Array.isArray(listing?.data) || !listing.data.length)
    throw new Error("Invalid or empty Zen listing");
  if (!metadata?.opencode?.models || typeof metadata.opencode.models !== "object")
    throw new Error("Zen pricing unavailable: refusing to update");
  const former = Object.fromEntries(old.models.map((m) => [m.id, m]));
  const documented = parseZenProtocols(docs);
  const models = [];
  const seen = new Set();
  for (const entry of listing.data) {
    const id = entry?.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(id) ||
        id === "test" || seen.has(id)) continue;
    seen.add(id);
    const data = metadata.opencode.models[id];
    if (!data || !zenZeroCost(data.cost)) continue;
    const previous = former[id];
    const sdk = data.provider?.npm ?? metadata.opencode.npm;
    const protocol = documented[id] ?? (sdk ? sdks[sdk] : previous?.protocol);
    if (!["chat", "responses", "anthropic", "systemone"].includes(protocol)) continue;
    if (id.startsWith("jev-") && protocol !== "systemone") continue;
    const modalities = (key) => {
      const list = data.modalities?.[key];
      return Array.isArray(list) && list.length && list.every((v) =>
        ["text","image","audio","video","pdf"].includes(v))
        ? list : previous?.modalities?.[key] ?? ["text"];
    };
    const limit = data.limit;
    const correctLimit = limit && Number.isSafeInteger(limit.context) && limit.context > 0 &&
      Number.isSafeInteger(limit.output) && limit.output > 0;
    models.push({
      id,
      name: typeof data.name === "string" && data.name ? data.name : previous?.name ?? id,
      protocol,
      limit: correctLimit ? limit : previous?.limit ?? { context: 32768, output: 4096 },
      modalities: { input: modalities("input"), output: modalities("output") },
      reasoning: protocol !== "systemone" && (data.reasoning ?? previous?.reasoning ?? false),
      tool_call: protocol !== "systemone" && (data.tool_call ?? previous?.tool_call ?? false),
      interleaved: protocol === "systemone" ? false : data.interleaved ?? previous?.interleaved ?? false,
      reasoning_options: Array.isArray(data.reasoning_options) ? data.reasoning_options :
        previous?.reasoning_options ?? [],
      upstream_status: typeof data.status === "string" ? data.status :
        previous?.upstream_status ?? "active",
    });
  }
  if (!models.length || models.length > 200)
    throw new Error("Implausible free catalog, refusing changes");
  if (JSON.stringify(models) === JSON.stringify(old.models)) return old;
  return { ...old, models, captured_at: date };
}

export function updateVersions({ current, zenSource, v1, v2 }) {
  if (typeof v1 !== "string" || !/^1\.\d+\.\d+$/.test(v1)) throw new Error("Invalid v1 version");
  if (v2 !== undefined && (typeof v2 !== "string" || !/^2\.\d+\.\d+$/.test(v2)))
    throw new Error("Invalid v2 version");
  const pattern = /const OPENCODE_VERSION = "\d+\.\d+\.\d+";/;
  if (!pattern.test(zenSource)) throw new Error("OpenCode 1.x marker missing");
  return {
    state: { opencode1: v1, opencode2: v2 ?? current.opencode2 },
    zenSource: zenSource.replace(pattern, 'const OPENCODE_VERSION = "' + v1 + '";'),
  };
}

export async function sync({ fetchImpl = fetch, write = true, date = new Date().toISOString().slice(0, 10) } = {}) {
  const [old, current, zenSource] = await Promise.all([
    readFile(snapshot, "utf8").then(JSON.parse),
    readFile(state, "utf8").then(JSON.parse),
    readFile(client, "utf8"),
  ]);
  const [listing, metadata, docs, v1, v2] = await Promise.all([
    fetchUpstream(urls.list, fetchImpl),
    fetchUpstream(urls.meta, fetchImpl),
    optional(urls.docs, fetchImpl, true),
    fetchUpstream(urls.v1, fetchImpl),
    optional(urls.v2, fetchImpl),
  ]);
  const changedSnapshot = buildSnapshot({ listing, metadata, docs, old, date });
  const changedVersion = updateVersions({
    current, zenSource, v1: v1.version, v2: v2?.version,
  });
  const outputs = [
    [snapshot, JSON.stringify(changedSnapshot, null, 2) + "\n"],
    [state, JSON.stringify(changedVersion.state, null, 2) + "\n"],
    [client, changedVersion.zenSource],
  ];
  const changed = [];
  for (const [url, content] of outputs) {
    if ((await readFile(url, "utf8")) === content) continue;
    changed.push(fileURLToPath(url));
    if (write) await writeFile(url, content);
  }
  console.log(changed.length ? "Updated: " + changed.join(", ") : "No upstream changes");
  return changed;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sync({ write: !process.argv.includes("--check") }).catch((error) => {
    console.error("Sync failed: " + error.message);
    process.exitCode = 1;
  });
}
