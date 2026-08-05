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
 * Try each key in turn. A 429 (or 5xx) means "this key is spent right now",
 * which is exactly what the next key is for. Anything else is a real error and
 * is returned immediately rather than burning the rest of the pool on it.
 */
export async function withKeys(run) {
  const keys = keyPool();
  if (!keys.length) {
    return { error: "not_configured", status: 503 };
  }
  let last = null;
  for (const key of shuffled(keys)) {
    const res = await run(key);
    if (res.ok) return { res };
    last = res;
    if (res.status === 429 || res.status >= 500) continue;
    break;
  }
  return { res: last };
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
