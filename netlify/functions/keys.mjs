/**
 * Server-side Groq key pool, shared by the ASR and chat proxies.
 *
 * The whole point of the proxy is that these keys never reach the browser, so
 * they live in the `GROQ_KEY_POOL` environment variable (comma-separated) and
 * are only ever read here.
 *
 * Rotation differs from the client's KeyPool: a function invocation is
 * stateless, so there is no counter to advance between requests. Shuffling per
 * request spreads load evenly across the pool in aggregate, and failing over
 * within the invocation covers the case where the chosen key is exhausted.
 */
export function keyPool() {
  return String(process.env.GROQ_KEY_POOL || process.env.SPARK_GROQ_API_KEY || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Fisher-Yates — an unbiased shuffle, so no key is favoured over time. */
export function shuffled(keys) {
  const a = keys.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Cooldowns, remembered at module scope so they survive between invocations on
 * a warm instance. Without this an exhausted key was retried on *every* request
 * — a guaranteed failed round-trip in front of real work, repeatedly, for as
 * long as it stayed spent. A cold instance simply starts with an empty map and
 * relearns, which costs one request per key at worst.
 */
const cooldown = new Map();

function usable(keys) {
  const now = Date.now();
  const free = keys.filter((k) => (cooldown.get(k) || 0) <= now);
  // Everything is benched: rather than fail outright, try the one that frees up
  // soonest — the cap refills continuously, so it may already be good again.
  if (free.length) return shuffled(free);
  return [keys.reduce((a, b) => ((cooldown.get(a) || 0) <= (cooldown.get(b) || 0) ? a : b))];
}

function bench(key, res) {
  const secs = Number(res.headers?.get?.("retry-after"));
  const ms = Number.isFinite(secs) && secs > 0
    ? Math.min(3600000, Math.max(5000, secs * 1000))
    : 60000;
  cooldown.set(key, Date.now() + ms);
}

/**
 * Try each usable key in turn. A 429 means "this key is spent right now", which
 * is exactly what the next key is for. Anything else is a real error and is
 * returned immediately rather than burning the rest of the pool on it.
 */
export async function withKeys(run) {
  const keys = keyPool();
  if (!keys.length) {
    return { error: "not_configured", status: 503 };
  }
  let last = null;
  for (const key of usable(keys)) {
    const res = await run(key);
    if (res.ok) {
      cooldown.delete(key);
      return { res };
    }
    last = res;
    if (res.status === 429) { bench(key, res); continue; }
    if (res.status >= 500) continue;
    break;
  }
  return { res: last };
}

/** How many keys are not currently benched — surfaced for diagnostics. */
export function poolHealth() {
  const keys = keyPool();
  const now = Date.now();
  return { total: keys.length, ready: keys.filter((k) => (cooldown.get(k) || 0) <= now).length };
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Optional shared gate. If `SPARK_ACCESS_CODE` is set, callers must present it;
 * if it is unset the proxy is open. Open is a defensible default here because
 * the pool is free-tier — the worst case is a drained daily quota, not a bill —
 * but set the variable if the URL gets shared beyond the people you intend.
 */
export function gateFails(req) {
  const want = String(process.env.SPARK_ACCESS_CODE || "").trim();
  if (!want) return null;
  const got = String(req.headers.get("x-spark-access") || "").trim();
  return got === want ? null : json({ error: "bad_access_code" }, 401);
}
