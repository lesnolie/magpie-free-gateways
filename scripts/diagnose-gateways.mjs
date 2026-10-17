import { ZenFreeAllPlugin, KiloFreeAllPlugin } from "../index.mjs";

async function probe(name, plugin, auth, url, model, streaming = false) {
  try {
    const hooks = await plugin({}, { ttlMs: 0 });
    const loader = await hooks.auth.loader(async () => auth);
    const response = await loader.fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(40000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, messages: [{ role: "user", content: "Respond with OK." }],
        max_tokens: 512, stream: streaming,
      }),
    });
    const raw = await response.text();
    let visible = false;
    if (response.ok && !streaming) {
      try {
        const data = JSON.parse(raw);
        visible = Boolean(data.choices?.some((c) => c.message?.content?.trim()));
      } catch { /* classify content below */ }
    }
    if (response.ok && streaming) {
      visible = /"content"\s*:\s*"[^"]+?"/.test(raw);
    }
    let reason = "Check upstream response";
    if (response.status === 403 && /FreeTierError|only be used from within OpenCode/i.test(raw))
      reason = "Free-tier client policy: catalog listing is NOT an inference authorization";
    else if (response.status === 401) reason = "Authentication required or rejected";
    else if (response.status === 404) reason = "Model unavailable in the live free catalog";
    else if (response.status === 429) reason = "Upstream rate limit or quota";
    else if (response.status === 503) reason = "Live price/model verification failed";
    else if (response.ok) reason = visible ? "HTTP success with visible model output" : "HTTP success, but no visible model output";
    console.log(JSON.stringify({
      provider: name, model, status: response.status, diagnosis: reason,
      visible, streaming, response: raw.slice(0, 600).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"),
    }));
  } catch (error) {
    console.log(JSON.stringify({ provider: name, model, error: String(error).slice(0, 300) }));
  }
}

await probe("Zen", ZenFreeAllPlugin, { type: "api", key: "public" },
  "https://opencode.ai/inference/v1/chat/completions", "deepseek-v4.1-flash-free");
await probe("Zen-stream", ZenFreeAllPlugin, { type: "api", key: "public" },
  "https://opencode.ai/inference/v1/chat/completions", "deepseek-v4.1-flash-free", true);
await probe("Kilo", KiloFreeAllPlugin,
  { type: "api", key: "anonymous", metadata: { mode: "anonymous" } },
  "https://ai-gateway.kilo.ai/api/v1/chat/completions", "kilo-auto/free");
