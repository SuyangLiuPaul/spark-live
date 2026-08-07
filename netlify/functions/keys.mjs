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

function bench(key, res, minMs = 0) {
  const secs = Number(res.headers?.get?.("retry-after"));
  const ms = Number.isFinite(secs) && secs > 0
    ? Math.min(3600000, Math.max(5000, secs * 1000))
    : 60000;
  cooldown.set(key, Date.now() + Math.max(ms, minMs));
}

/**
 * Statuses that condemn THIS KEY rather than the request itself.
 *
 * 429 is the obvious one, but 401 (revoked) and 403 (rejected at Groq's edge —
 * a blocked or flagged account shows up as a Cloudflare "Access denied") are
 * just as key-specific, and that is precisely what the other seven keys are
 * for. The original code `break`-ed on anything that wasn't a 429 or a 5xx, so
 * one bad key failed the whole request with the rest of the pool untouched.
 */
const KEY_FAULT = new Set([401, 403, 429]);

/**
 * Try each usable key in turn. A key-specific rejection moves on to the next
 * key; a request-level 4xx (400/413/422 — our payload is wrong) would fail
 * identically on every key, so it returns immediately rather than burning the
 * whole pool proving it.
 */
export async function withKeys(run, kind) {
  const keys = keyPool();
  if (!keys.length) {
    return { error: "not_configured", status: 503 };
  }
  let last = null;
  for (const key of usable(keys)) {
    const res = await run(key);
    if (kind) await recordLimits(kind, key, res);   // a 429 carries the header too
    if (res.ok) {
      cooldown.delete(key);
      return { res };
    }
    last = res;
    if (KEY_FAULT.has(res.status)) {
      // A revoked or blocked key won't recover in a minute the way a spent one
      // does, so keep it out of rotation for longer instead of paying a failed
      // round-trip for it on every request for the rest of the service.
      bench(key, res, res.status === 429 ? 0 : 15 * 60 * 1000);
      continue;
    }
    if (res.status >= 500) continue;
    break;
  }
  return { res: last };
}

/* ── quota observation ──────────────────────────────────────────────────
   Groq returns `x-ratelimit-remaining-requests` on every response and we were
   throwing it away. Recording it costs nothing and answers the only quota
   question worth asking: "will this pool get me through the service?"

   The daily caps are per key AND per model — speech is the binding one, so a
   remaining-hours estimate is driven by ASR. Chat is tracked too, to catch the
   case where translation runs out first (3 target languages, short sentences).

   Module scope, so it survives across invocations on a warm instance; a cold
   instance simply has no observations yet and falls back to a projection. */
import { getStore } from "@netlify/blobs";

const CAP = { asr: 2000, chat: 1000 };          // per key per day, measured
const ASR_SECONDS_PER_CALL = 2.65;              // measured real cadence, not the 2.2s nominal
const observed = new Map();                     // `${kind}:${key}` -> {remaining, at}

export function recordLimits(kind, key, res) {
  const raw = res?.headers?.get?.("x-ratelimit-remaining-requests");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return;
  const id = `${kind}:${key}`;
  const prev = observed.get(id);
  observed.set(id, { remaining: n, at: Date.now() });

  // Module scope is per-FUNCTION: /api/asr and /api/quota are separate
  // deployments with separate memory, so an in-process Map alone means the
  // quota endpoint never sees a single observation. Persist to the blob store
  // both already use — but sparingly. ASR fires every ~2.2s during a service,
  // so write only on a meaningful drop or once a minute, never per call.
  const moved = !prev || Math.abs(prev.remaining - n) >= 25;
  const stale = !prev || Date.now() - prev.at > 60000;
  // Returns a promise the caller MUST await. Fire-and-forget looks harmless but
  // a serverless instance is frozen once it responds, so an unawaited write
  // usually never lands — which is exactly why the first version of this
  // silently recorded nothing. Throttled above, so awaiting is rare.
  return (moved || stale) ? persist(id, n) : null;
}

const STORE = "spark-live";
const BLOB_KEY = "quota/observed.json";

export let lastPersistError = null;

async function persist(id, remaining) {
  try {
    const store = getStore({ name: STORE, consistency: "strong" });
    const cur = (await store.get(BLOB_KEY, { type: "json" }).catch(() => null)) || {};
    cur[id] = { remaining, at: Date.now() };
    await store.setJSON(BLOB_KEY, cur);
    lastPersistError = null;
  } catch (e) {
    // Never break a transcription over the quota display — but do not swallow
    // the reason either; a silent catch here hid a broken write for two deploys.
    lastPersistError = String(e && e.message || e).slice(0, 200);
  }
}

/** Merge persisted observations into this instance's memory. */
export let lastHydrateError = null;

export async function hydrate() {
  try {
    const store = getStore({ name: STORE, consistency: "strong" });
    const saved = await store.get(BLOB_KEY, { type: "json" });
    lastHydrateError = saved ? null : "no blob yet";
    if (!saved) return;
    const today = new Date().toISOString().slice(0, 10);
    for (const [id, v] of Object.entries(saved)) {
      // Daily caps reset, so an observation from a previous day says nothing
      // about today and would under-report the budget.
      if (new Date(v.at).toISOString().slice(0, 10) !== today) continue;
      const mine = observed.get(id);
      if (!mine || v.at > mine.at) observed.set(id, v);
    }
  } catch (e) {
    lastHydrateError = String(e && e.message || e).slice(0, 200);
  }
}

/**
 * Aggregate remaining budget. Keys we have not called yet are projected at
 * their full cap — honest for a fresh day, optimistic right after a cold start,
 * which is why `measured` reports how much of this is observation.
 */
export function quotaEstimate() {
  const keys = keyPool();
  if (!keys.length) return null;
  const sum = (kind) => keys.reduce((acc, k) => {
    const o = observed.get(`${kind}:${k}`);
    return acc + (o ? o.remaining : CAP[kind]);
  }, 0);
  const seen = (kind) => keys.filter((k) => observed.has(`${kind}:${k}`)).length;

  const asr = sum("asr"), chat = sum("chat");
  return {
    keys: keys.length,
    asr:  { remaining: asr,  total: keys.length * CAP.asr,  observedKeys: seen("asr") },
    chat: { remaining: chat, total: keys.length * CAP.chat, observedKeys: seen("chat") },
    // Speech is the binding bucket; report the hours it supports.
    hours: +(asr * ASR_SECONDS_PER_CALL / 3600).toFixed(1),
    measured: seen("asr") > 0,
  };
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
