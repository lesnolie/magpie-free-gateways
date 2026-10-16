import { createDiscovery, readRemote } from "./discovery.mjs";
import {
  KILO_ID, KILO_BASE, CHAT_SDK, kiloSnapshot, buildKiloModels, toConfigModels,
} from "./models.mjs";

function checkedURL(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Expected a plain HTTP(S) base URL");
  return url.href.replace(/\/+$/, "");
}

function authMode(auth) {
  if (auth?.type !== "api" || !auth.key) throw new Error("Kilo Free requires an anonymous login or API key");
  return auth.metadata?.mode === "anonymous" || auth.key === "anonymous" ? "anonymous" : "key";
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status, headers: { "content-type": "application/json" },
  });
}

export async function KiloFreeAllPlugin(_input, options = {}) {
  const baseURL = checkedURL(options.baseURL ?? KILO_BASE);
  const listURL = checkedURL(options.listURL ?? `${baseURL}/models`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const initial = buildKiloModels({ data: kiloSnapshot.models }, baseURL);
  const discovery = createDiscovery({
    initial,
    ttlMs: options.ttlMs ?? 30_000,
    load: async () => buildKiloModels(await readRemote(listURL, { fetchImpl }), baseURL),
  });

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[KILO_ID] ??= {
        name: "Kilo Gateway Free (All)",
        npm: CHAT_SDK,
        api: baseURL,
        models: toConfigModels(discovery.current),
      };
    },
    auth: {
      provider: KILO_ID,
      icon: "https://kilo.ai/favicon.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: "匿名免费访问（输入 anonymous）",
          placeholder: "anonymous",
          async authorize() {
            return { type: "success", key: "anonymous", metadata: { mode: "anonymous" } };
          },
        },
        { type: "api", label: "Kilo API Key（可选）", placeholder: "API key" },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        authMode(auth);
        return {
          baseURL,
          apiKey: auth.key,
          async fetch(input, init) {
            const account = await getAuth();
            const mode = authMode(account);
            const request = new Request(input, init);
            if (request.url !== `${baseURL}/chat/completions` || request.method !== "POST")
              throw new Error("Unsupported Kilo endpoint or method");
            const body = await request.json();
            if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string")
              return jsonError(400, "Expected a chat request with a model ID");
            try {
              await discovery.requireModel(body.model);
            } catch (error) {
              const absent = error.message.includes("absent from the current free catalog");
              return jsonError(absent ? 404 : 503, absent
                ? `Model ${body.model} is absent from Kilo's current zero-price catalog`
                : `Could not verify Kilo's current zero-price catalog: ${error.message}`);
            }
            const headers = new Headers({ "content-type": "application/json" });
            if (mode === "key") headers.set("authorization", `Bearer ${account.key}`);
            for (const name of ["x-kilocode-mode", "x-kilocode-taskid"]) {
              const value = request.headers.get(name);
              if (value) headers.set(name, value);
            }
            return fetchImpl(`${baseURL}/chat/completions`, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: "error",
            });
          },
        };
      },
      async usage() { return { plan: "Kilo Gateway Free", windows: [] }; },
    },
    provider: {
      id: KILO_ID,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        authMode(auth);
        return discovery.forDisplay();
      },
    },
  };
}
