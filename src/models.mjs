import { readFileSync } from "node:fs";

export const ZEN_ID = "zen-free-all";
export const KILO_ID = "kilo-free-all";
export const CHAT_SDK = "@ai-sdk/openai-compatible";
export const RESPONSES_SDK = "@ai-sdk/openai";
export const ANTHROPIC_SDK = "@ai-sdk/anthropic";
export const ZEN_BASE = "https://opencode.ai/inference/v1";
export const KILO_BASE = "https://ai-gateway.kilo.ai/api/v1";

export const zenSnapshot = JSON.parse(readFileSync(new URL("./zen-snapshot.json", import.meta.url), "utf8"));
export const kiloSnapshot = JSON.parse(readFileSync(new URL("./kilo-snapshot.json", import.meta.url), "utf8"));

const endpointProtocol = {
  "chat/completions": "chat",
  responses: "responses",
  messages: "anthropic",
  systemone: "systemone",
};

export function parseZenProtocols(text) {
  const found = {};
  const pattern = /\|[^|]+\|\s*`?([^|`\s]+)`?\s*\|\s*`https:\/\/opencode\.ai\/inference\/[^/]+\/v1\/(chat\/completions|responses|messages|systemone)`/g;
  for (const match of text.matchAll(pattern)) found[match[1]] = endpointProtocol[match[2]];
  return found;
}

function modalities(values = ["text"]) {
  return Object.fromEntries(["text", "image", "audio", "video", "pdf"].map((name) => [name, values.includes(name)]));
}

function sdkFor(protocol) {
  return protocol === "responses" ? RESPONSES_SDK : protocol === "anthropic" ? ANTHROPIC_SDK : CHAT_SDK;
}

function modelShape({ id, providerID, name, npm, baseURL, limit, input, output, reasoning, toolcall, interleaved = false, variants = {}, decides = false }) {
  return {
    id,
    providerID,
    name,
    api: { id, url: baseURL, npm },
    limit: { context: 32768, output: 4096, ...limit },
    capabilities: {
      temperature: !decides,
      reasoning: !!reasoning,
      attachment: input.some((value) => value !== "text"),
      toolcall: !!toolcall,
      input: modalities(input),
      output: modalities(output),
      interleaved,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants,
    options: {},
    headers: {},
    status: "active",
    release_date: "",
    free: true,
    ...(decides ? { decides: true } : {}),
  };
}

function zeroNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number === 0;
}

export function isZeroPricing(pricing) {
  if (!pricing || !zeroNumber(pricing.prompt) || !zeroNumber(pricing.completion)) return false;
  return Object.entries(pricing).every(([key, value]) => key === "discount" || zeroNumber(value));
}

function allZeroCostFields(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const fields = Object.values(value);
    return fields.length > 0 && fields.every(allZeroCostFields);
  }
  return zeroNumber(value);
}

export function zenZeroCost(cost) {
  if (!cost || !zeroNumber(cost.input) || !zeroNumber(cost.output)) return false;
  // Newer catalogs can express extended-context costs as nested objects.
  // All tiers and cache rates must be explicitly zero: never infer "free"
  // from the main input/output price alone.
  return allZeroCostFields(cost);
}

export function buildZenModels(listing, metadata = {}, protocols = {}, baseURL = ZEN_BASE, blockedIDs = new Set()) {
  if (!Array.isArray(listing?.data)) throw new Error("Invalid OpenCode model list");
  const fallback = Object.fromEntries(zenSnapshot.models.map((model) => [model.id, model]));
  const result = {};
  for (const entry of listing.data) {
    const id = entry?.id;
    if (typeof id !== "string" || !id || id === "__proto__" || id === "test" || blockedIDs.has(id)) continue;
    const raw = metadata.models?.[id];
    const known = fallback[id];
    const cost = raw?.cost;
    const namedFree = id.endsWith("-free");
    // A nonzero catalog price always overrides a free-looking model name.
    if (cost && !zenZeroCost(cost)) continue;
    if (!namedFree && !zenZeroCost(cost)) continue;
    // Jev uses System One. A newly listed Jev cannot be routed safely
    // until the live endpoint documentation identifies its protocol.
    if (id.startsWith("jev-") && !protocols[id] && known?.protocol !== "systemone") continue;
    const npm = raw?.provider?.npm ?? metadata.npm;
    const protocol = protocols[id] ?? known?.protocol ??
      (npm === RESPONSES_SDK ? "responses" :
        npm === ANTHROPIC_SDK ? "anthropic" :
          npm === CHAT_SDK ? "chat" :
            // Zen's provider default is OpenAI-compatible Chat Completions.
            // A new Jev ID needs an explicit System One route before use.
            npm || id.startsWith("jev-") ? undefined : "chat");
    if (!protocol || !["chat", "responses", "anthropic", "systemone"].includes(protocol)) continue;
    const decides = protocol === "systemone";
    const input = raw?.modalities?.input ?? known?.modalities?.input ?? ["text"];
    const output = raw?.modalities?.output ?? known?.modalities?.output ?? ["text"];
    const efforts = (raw?.reasoning_options ?? known?.reasoning_options ?? [])
      .filter((option) => option.type === "effort").flatMap((option) => option.values ?? []);
    result[id] = modelShape({
      id, providerID: ZEN_ID, name: raw?.name ?? known?.name ?? id,
      npm: sdkFor(protocol), baseURL,
      limit: raw?.limit ?? known?.limit,
      input, output,
      reasoning: !decides && (raw?.reasoning ?? known?.reasoning),
      toolcall: !decides && (raw?.tool_call ?? known?.tool_call),
      interleaved: !decides && (raw?.interleaved ?? known?.interleaved ?? false),
      variants: Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }])),
      decides,
    });
  }
  return result;
}

export function buildKiloModels(listing, baseURL = KILO_BASE) {
  if (!Array.isArray(listing?.data)) throw new Error("Invalid Kilo model list");
  const result = {};
  for (const raw of listing.data) {
    const id = raw?.id;
    if (typeof id !== "string" || !id || id === "__proto__" || !isZeroPricing(raw.pricing)) continue;
    const input = raw.architecture?.input_modalities ?? ["text"];
    const output = raw.architecture?.output_modalities ?? ["text"];
    const supported = raw.supported_parameters ?? [];
    result[id] = modelShape({
      id, providerID: KILO_ID, name: raw.name ?? id, npm: CHAT_SDK, baseURL,
      limit: {
        context: raw.context_length ?? raw.top_provider?.context_length ?? 32768,
        output: raw.top_provider?.max_completion_tokens ?? 4096,
      },
      input, output,
      reasoning: supported.includes("reasoning") || supported.includes("reasoning_effort"),
      toolcall: supported.includes("tools"),
    });
  }
  return result;
}

export function toConfigModels(models) {
  return Object.fromEntries(Object.entries(models).map(([id, model]) => [id, {
    id,
    name: model.name,
    provider: { npm: model.api.npm, api: model.api.url },
    limit: model.limit,
    reasoning: model.capabilities.reasoning,
    tool_call: model.capabilities.toolcall,
    attachment: model.capabilities.attachment,
    modalities: {
      input: Object.keys(model.capabilities.input).filter((key) => model.capabilities.input[key]),
      output: Object.keys(model.capabilities.output).filter((key) => model.capabilities.output[key]),
    },
    cost: { input: 0, output: 0 },
    variants: model.variants,
    interleaved: model.capabilities.interleaved,
    free: true,
    ...(model.decides ? { decides: true } : {}),
  }]));
}
