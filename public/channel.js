/**
 * Spark Live — audience transport.
 *
 * Everything the app knows about "how text reaches the audience" lives in this
 * one file. Swapping to Supabase Realtime / Ably later means rewriting only
 * `publish()` and `subscribe()`; nothing else in the app touches the network.
 *
 * Current implementation: HTTP publish + CDN-collapsed polling.
 */

const API = "";              // same origin
// Viewers poll every 3s, not every 1s. Measured: at 1s polling a 40-person
// congregation costs ~194,000 function invocations for a single 3-hour service
// — more than a whole month's free-tier allowance (125,000). The CDN collapses
// only about half the traffic, because concurrent requests inside one cache
// window all miss before the first response is stored.
//
// 3s is invisible to a reader: a translated line stays on screen for many
// seconds, and the live tail already updates from the presenter's own stream.
const POLL_MS = 3000;

/** Presenter side: push the whole session document. */
export function createPublisher({ session, token }) {
  let inFlight = false;
  let queued = null;

  async function send(doc) {
    const res = await fetch(`${API}/api/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, token, doc }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `publish_failed_${res.status}`);
    }
    return res.json();
  }

  return {
    /**
     * Coalescing publish: while a request is in flight we keep only the most
     * recent document, so a burst of corrections never queues up a backlog.
     */
    async push(doc) {
      if (inFlight) { queued = doc; return; }
      inFlight = true;
      try {
        await send(doc);
        while (queued) {
          const next = queued; queued = null;
          await send(next);
        }
      } finally {
        inFlight = false;
      }
    },
  };
}

/** Audience side: poll for changes. Returns an unsubscribe function. */
export function subscribe({ session, onDoc, onStatus }) {
  let stopped = false;
  let version = -1;
  let misses = 0;

  async function tick() {
    if (stopped) return;
    try {
      const res = await fetch(`${API}/api/feed?s=${encodeURIComponent(session)}&v=${version}`, {
        cache: "no-store",
      });
      if (res.status === 204) {
        misses = 0;
        onStatus?.({ ok: true, waiting: true });
      } else if (res.status === 404) {
        onStatus?.({ ok: false, notFound: true });
      } else if (res.ok) {
        const doc = await res.json();
        version = Number(doc.v) || 0;
        misses = 0;
        onStatus?.({ ok: true });
        onDoc?.(doc);
      } else {
        throw new Error(String(res.status));
      }
    } catch {
      misses += 1;
      onStatus?.({ ok: false, offline: true });
    }
    // Back off gently while the network is unhappy so a flaky phone doesn't
    // hammer the relay, but recover to 1s as soon as it works again.
    const delay = misses > 0 ? Math.min(POLL_MS * (1 + misses), 6000) : POLL_MS;
    setTimeout(tick, delay);
  }

  tick();
  return () => { stopped = true; };
}
