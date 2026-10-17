import { createHash, randomBytes } from "node:crypto";
import {
  ZEN_ID as PROVIDER,
  ZEN_BASE,
  CHAT_SDK,
  RESPONSES_SDK,
  ANTHROPIC_SDK,
  zenSnapshot,
  buildZenModels,
  toConfigModels,
  parseZenProtocols,
  zenZeroCost,
} from "./models.mjs";
import { createDiscovery, readRemote } from "./discovery.mjs";
import { collapseResponse } from "./stream.mjs";
import { guardToolResponse } from "./tool-response.mjs";

// The Magpie-facing base is one URL. Every upstream protocol has its own
// current OpenCode endpoint and is dispatched below.
const DEFAULT_BASE = ZEN_BASE;
const CATALOG = "https://models.opencode.ai/api.json";
const DOCS =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/models.mdx";
const SDK = { chat: CHAT_SDK, responses: RESPONSES_SDK, anthropic: ANTHROPIC_SDK };
const SDK_PROTOCOL = Object.fromEntries(Object.entries(SDK).map(([protocol, npm]) => [npm, protocol]));
const PATHS = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages", systemone: "/systemone" };
const UPSTREAM = {
  chat: "https://opencode.ai/inference/openai/v1/chat/completions",
  responses: "https://opencode.ai/inference/openai/v1/responses",
  anthropic: "https://opencode.ai/inference/anthropic/v1/messages",
  systemone: "https://opencode.ai/inference/systemone/v1/systemone",
};
const CORE_TOOLS = ["bash", "edit", "glob", "grep", "read"];
// The parameter each stand-in takes, OpenCode's own first one: Zen's free
// tier answers 403 FreeTierError to bash or read offered with none.
const CORE_PARAMETER = {
  bash: "command",
  edit: "filePath",
  glob: "pattern",
  grep: "pattern",
  read: "filePath",
};
const OPENCODE_VERSION = "1.19.3";
// OpenCode 1.x release version. These AI SDK/Bun component versions were
// observed with 1.19.0 and must be verified against a current binary before
// being described as an exact fingerprint for a later release. OpenCode 2.x
// is a separate release line; changing a version string is not a V2 port.
const PROVIDER_UTILS = { chat: "4.0.23", responses: "4.0.40", anthropic: "4.0.46" };
export function userAgent(protocol) {
  return `opencode/${OPENCODE_VERSION} ai-sdk/provider-utils/${PROVIDER_UTILS[protocol]} runtime/bun/1.3.14`;
}
function httpURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function zenCredential(auth) {
  if (auth?.type !== "api" || typeof auth.key !== "string" ||
      !auth.key || auth.key !== auth.key.trim() || /[\r\n]/.test(auth.key)) {
    throw new Error("Sign in with public or an official OpenCode Console API key.");
  }
  return { key: auth.key, public: auth.key === "public" };
}

// A live catalog lists free model IDs, but the Zen server can separately
// restrict anonymous inference to first-party OpenCode clients. A provider
// plugin cannot grant or bypass that access. Preserve the HTTP failure and
// explain the restriction without incorrectly reporting a missing model.
async function explainFreeTierError(response) {
  if (response.status !== 403) return response;
  let raw;
  try { raw = await response.clone().text(); } catch { return response; }
  if (!/FreeTierError|free tier can only be used from within OpenCode/i.test(raw)) return response;
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "FreeTierError",
      message: "OpenCode Zen refused this free-tier request because it is not authorized from this client. " +
        "Magpie is a third-party app; updating a plugin or changing a User-Agent cannot grant access. " +
        "Use the official OpenCode app for its free tier, or try an official Console API key " +
        "for API access where permitted (billing and model restrictions may apply).",
    },
  }), {
    status: 403,
    headers: { "content-type": "application/json", "x-magpie-sign-in": "kept" },
  });
}

function normalizeTools(body, protocol, injectUnavailable = true) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("tools must be an array");
  }
  if (injectUnavailable) body.tools ??= [];
  const present = new Set(
    (body.tools ?? []).map((tool) => (protocol === "chat" ? tool?.function?.name : tool?.name)),
  );
  const declared = new Set([...present].filter((name) => typeof name === "string"));
  if (protocol === "chat" && Array.isArray(body.functions)) {
    for (const tool of body.functions) if (typeof tool?.name === "string") declared.add(tool.name);
  }
  // Only the historical anonymous adapter requires its old tool stubs.
  // Real Console API-key requests must preserve the agent's actual tools.
  if (!injectUnavailable) return { declared };
  for (const name of CORE_TOOLS) {
    if (present.has(name)) continue;
    const parameters = {
      type: "object",
      properties: { [CORE_PARAMETER[name]]: { type: "string" } },
      additionalProperties: false,
    };
    const definition = { name, description: "Not available. Never call this tool." };
    body.tools.push(
      protocol === "chat"
        ? { type: "function", function: { ...definition, parameters } }
        : protocol === "anthropic"
          ? { ...definition, input_schema: parameters }
          : { type: "function", ...definition, parameters },
    );
  }
  return { declared };
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let counter = 0;

// An id the way OpenCode makes one (packages/schema/src/identifier.ts):
// 12 hex of Date.now() * 0x1000 + a per-millisecond counter (bit-inverted
// for a session, so newer sorts first), then 14 random base62 characters.
// Zen's free tier checks a session id has this shape, a small counter
// included, and answers 403 FreeTierError to one that doesn't (#100).
export function opencodeID(prefix, descending, now = Date.now()) {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter++;
  const current = BigInt(now) * 0x1000n + BigInt(counter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  const random = randomBytes(14);
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 62];
  return `${prefix}_${value.toString(16).padStart(12, "0")}${tail}`;
}

// A session id OpenCode itself could have made: its counter (the low 12
// bits, inverted) is small. A hash cut to the same shape isn't one.
export function realSessionID(value) {
  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(value ?? "");
  return !!match && 0xfff - Number.parseInt(match[1], 16) < 16;
}

// One made-up session per conversation, so its turns keep one session.
const SESSIONS = new Map();
const KEEP_SESSIONS = 1000;

export function sessionID(headers, body) {
  let signal;
  for (const name of [
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
    "conversation-id",
  ]) {
    if (headers.get(name)) {
      signal = headers.get(name);
      break;
    }
  }
  if (!signal && typeof body.metadata?.session_id === "string") signal = body.metadata.session_id;
  if (realSessionID(signal)) return signal;
  if (!signal) {
    const messages = body.messages ?? body.input;
    const first = Array.isArray(messages)
      ? messages.find((message) => message.role === "user")?.content
      : messages;
    if (!first) return opencodeID("ses", true);
    signal = JSON.stringify(first);
  }
  const key = createHash("sha256").update(`ses\0${signal}`).digest("hex");
  let session = SESSIONS.get(key);
  if (session) {
    SESSIONS.delete(key);
  } else {
    session = opencodeID("ses", true);
    if (SESSIONS.size >= KEEP_SESSIONS) SESSIONS.delete(SESSIONS.keys().next().value);
  }
  SESSIONS.set(key, session);
  return session;
}

async function server(_input, options = {}) {
  const baseURL = httpURL(options.baseURL ?? DEFAULT_BASE);
  const listingURL = httpURL(options.listingURL ?? `${baseURL}/models`);
  const catalogURL = httpURL(options.catalogURL ?? CATALOG);
  const docsURL = httpURL(options.docsURL ?? DOCS);
  const fetchImpl = options.fetchImpl ?? fetch;
  const initial = buildZenModels(
    { data: zenSnapshot.models }, { models: { "big-pickle": { cost: { input: 0, output: 0 } } } },
    Object.fromEntries(zenSnapshot.models.map((model) => [model.id, model.protocol])), baseURL,
  );
  let documentedProtocols = Object.fromEntries(zenSnapshot.models.map((model) => [model.id, model.protocol]));
  let sdkProtocols = {};
  let previouslyCharged = new Set();
  const discovery = createDiscovery({ initial, ttlMs: options.ttlMs ?? 30_000, now: options.now ?? Date.now, load: async () => {
    const headers = { authorization: "Bearer public", "x-opencode-client": "cli" };
    const [listing, catalog, docs] = await Promise.allSettled([
      readRemote(listingURL, { headers, fetchImpl }),
      readRemote(catalogURL, { fetchImpl }),
      readRemote(docsURL, { as: "text", fetchImpl }),
    ]);
    // Never reuse old prices: an unpriced ID such as big-pickle needs
    // a zero-cost record from this refresh before any request is sent.
    const metadata = catalog.status === "fulfilled" && catalog.value?.opencode?.models
      ? catalog.value.opencode : { models: {} };
    if (catalog.status === "fulfilled" && metadata === catalog.value?.opencode) {
      for (const [id, raw] of Object.entries(metadata.models)) {
        if (raw?.cost) {
          if (zenZeroCost(raw.cost)) previouslyCharged.delete(id);
          else previouslyCharged.add(id);
        }
        if (raw?.provider?.npm)
          sdkProtocols[id] = SDK_PROTOCOL[raw.provider.npm] ?? "unsupported";
      }
    }
    if (docs.status === "fulfilled") documentedProtocols = { ...documentedProtocols, ...parseZenProtocols(docs.value) };
    if (listing.status !== "fulfilled") throw listing.reason;
    return buildZenModels(listing.value, metadata, { ...sdkProtocols, ...documentedProtocols },
      baseURL, previouslyCharged);
  }});

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "OpenCode Zen Free (All)",
        npm: SDK.chat,
        api: baseURL,
        decide: true,
        models: toConfigModels(discovery.current),
      };
    },
    auth: {
      provider: PROVIDER,
      icon: "https://opencode.ai/favicon-v3.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: "Zen 免费访问（密钥填写 public）",
          placeholder: "public",
          async authorize() {
            return { type: "success", key: "public" };
          },
        },
        {
          type: "api",
          label: "官方 Console API Key（第三方客户端，可能计费）",
          placeholder: "OpenCode Console API key",
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        const credential = zenCredential(auth);
        return {
          baseURL,
          apiKey: credential.key,
          async fetch(input, init) {
            const account = zenCredential(await getAuth());
            const request = new Request(input, init);
            const protocol = Object.keys(PATHS).find(
              (key) => request.url === `${baseURL}${PATHS[key]}`,
            );
            if (!protocol || request.method !== "POST")
              throw new Error("Unsupported Zen endpoint or method");
            request.signal.throwIfAborted();
            const body = await request.json();
            if (!body || typeof body !== "object" || Array.isArray(body))
              throw new Error("Expected a JSON request object");
            let model;
            try {
              model = await discovery.requireModel(body.model);
            } catch (error) {
              const absent = error.message.includes("absent from the current free catalog");
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: absent ? "not_found_error" : "service_unavailable_error",
                    message: absent
                      ? `Model ${body.model} is absent from the current OpenCode free catalog.`
                      : `Could not verify the current OpenCode free catalog: ${error.message}`,
                  },
                }),
                { status: absent ? 404 : 503, headers: { "content-type": "application/json" } },
              );
            }
            if (protocol === "systemone") {
              if (!model.decides || !Object.hasOwn(body, "state") || !body.questions ||
                  typeof body.questions !== "object" || Array.isArray(body.questions))
                return new Response(JSON.stringify({ error: { message: "Jev requires state and a questions object" } }),
                  { status: 400, headers: { "content-type": "application/json" } });
              const response = await fetchImpl(UPSTREAM.systemone, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${account.key}`,
                  "content-type": "application/json",
                  ...(!account.public ? { "user-agent": "magpie-free-gateways/0.1.4" } : {}),
                },
                body: JSON.stringify(body),
                signal: request.signal,
                redirect: "error",
              });
              return explainFreeTierError(response);
            }
            if (model.decides) throw new Error("Jev is a System One classifier, not a chat model");
            if (model.api.npm !== SDK[protocol]) {
              throw new Error(
                "Model is not an available free model for this protocol. Refresh the model list.",
              );
            }
            const streaming = body.stream === true;
            body.stream = true;
            const toolPolicy = normalizeTools(body, protocol, account.public);
            if (protocol === "chat")
              body.stream_options = { ...body.stream_options, include_usage: true };
            // Forward the supported OpenCode 1.x request headers, so a
            // caller's own headers (an agent's User-Agent, x-stainless-*,
            // x-session-affinity, ...) never mark the request as not
            // OpenCode's (packages/opencode/src/session/llm/request.ts).
            const given = request.headers;
            const session = sessionID(given, body);
            const project = _input?.project;
            const headers = new Headers({
              "content-type": "application/json",
              accept: "*/*",
              "user-agent": account.public ? userAgent(protocol) : "magpie-free-gateways/0.1.4",
            });
            // Preserve the historical public adapter for existing installs.
            // A genuine Console API key is instead sent as a third-party
            // client without claiming to be the official OpenCode CLI.
            if (account.public) {
              headers.set("x-opencode-project",
                given.get("x-opencode-project") ||
                (project?.vcs === "git" && project.id ? project.id : "global"));
              headers.set("x-opencode-session", session);
              headers.set("x-opencode-request", opencodeID("msg", false));
              headers.set("x-opencode-client", "cli");
              headers.set("x-opencode-session-id", session);
            }
            if (protocol === "anthropic") {
              headers.set("x-api-key", account.key);
              headers.set("anthropic-version", given.get("anthropic-version") || "2023-06-01");
              if (given.get("anthropic-beta")) headers.set("anthropic-beta", given.get("anthropic-beta"));
            } else {
              headers.set("authorization", `Bearer ${account.key}`);
            }
            const response = await fetchImpl(UPSTREAM[protocol], {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: "error",
            });
            const checked = await explainFreeTierError(response);
            if (!checked.ok) return checked;
            const guarded = await guardToolResponse(checked, protocol, toolPolicy, {
              endCutShort: streaming,
            });
            return streaming ? guarded : collapseResponse(guarded, protocol);
          },
        };
      },
      async usage() {
        return { plan: "OpenCode Zen Free", windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        zenCredential(auth);
        return discovery.forDisplay();
      },
    },
    async "chat.headers"(input, output) {
      if (![PROVIDER, `${PROVIDER}-plugin`].includes(input.model?.providerID) || !input.sessionID)
        return;
      output.headers["x-session-id"] = input.sessionID;
      output.headers["x-opencode-session"] = input.sessionID;
      output.headers["x-session-affinity"] = input.sessionID;
    },
  };
}

export const ZenFreeAllPlugin = server;
