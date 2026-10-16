// A failed refresh preserves the last display list. Requests require a recent
// successful catalog read, so an outage cannot turn a stale free price into a call.
export function createDiscovery({ load, initial = {}, ttlMs = 30_000, now = Date.now }) {
  let current = initial;
  let verifiedAt;
  let pending;

  async function refresh(force = false) {
    if (!force && verifiedAt !== undefined && now() - verifiedAt < ttlMs) return current;
    if (pending) return pending;
    pending = (async () => {
      const next = await load();
      // An empty, successfully read catalog means there are no free models.
      // A failed read throws in load() and keeps the last display list.
      if (!next || typeof next !== "object" || Array.isArray(next))
        throw new Error("Invalid live free-model catalog");
      current = next;
      verifiedAt = now();
      return current;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  }

  return {
    get verifiedAt() { return verifiedAt; },
    get current() { return current; },
    refresh,
    async forDisplay() {
      try {
        return await refresh();
      } catch {
        if (verifiedAt === undefined && !Object.keys(current).length)
          throw new Error("Free model discovery failed with no cached list");
        const fallback = { ...current };
        fallback[Symbol.for("magpie.fellBack")] = true;
        return fallback;
      }
    },
    async requireModel(id) {
      // Fail closed when a stale or never-verified catalog cannot be refreshed.
      const models = await refresh();
      if (!Object.hasOwn(models, id))
        throw new Error(`Model ${JSON.stringify(id)} is absent from the current free catalog`);
      return models[id];
    },
  };
}

export async function readRemote(url, { headers, timeoutMs = 8_000, as = "json", fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Catalog ${url} returned HTTP ${response.status}`);
  }
  return as === "text" ? response.text() : response.json();
}
