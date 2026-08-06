/**
 * Spark Live — the bits that decide whether a three-hour session survives.
 *
 * None of this is visible when things go well, which is exactly why it was
 * missing: every failure here happens mid-service, in front of a room, to
 * someone who cannot debug it.
 */

/* ── screen wake lock ─────────────────────────────────────────────────
   A phone left alone sleeps in 30 s. For the presenter that ends the
   session; for an audience member it means unlocking the phone every
   time they want to read. The OS also drops the lock whenever the page
   is hidden, so it must be re-acquired on every return to visibility —
   requesting it once is the usual bug. */
export function createWakeLock() {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  let lock = null;
  let want = false;

  async function acquire() {
    if (!supported || !want || lock || document.visibilityState !== "visible") return;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => { lock = null; });
    } catch {
      // Denied (often a low-battery mode). Not fatal — just don't retry hard.
    }
  }

  document.addEventListener("visibilitychange", () => { if (want) acquire(); });

  return {
    supported,
    get held() { return !!lock; },
    async on() { want = true; await acquire(); },
    async off() {
      want = false;
      try { await lock?.release(); } catch {}
      lock = null;
    },
  };
}

/* ── connection state ─────────────────────────────────────────────────
   `navigator.onLine` only knows about the network interface, not whether
   anything is reachable, so treat it as a hint and let callers report
   real request outcomes too. */
export function createConnection({ onChange } = {}) {
  let online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  let failures = 0;

  // Report the composite, not the raw flag: `online` alone is still true when a
  // run of failed requests has just tripped the threshold, so listeners would be
  // told "online" at the very moment they should show the offline banner.
  const emit = () => onChange?.({ online: online && failures < 3, failures });

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => { online = true; failures = 0; emit(); });
    window.addEventListener("offline", () => { online = false; emit(); });
  }

  return {
    get online() { return online && failures < 3; },
    /** Called on every real network outcome — more truthful than navigator.onLine. */
    report(ok) {
      const was = online && failures < 3;
      failures = ok ? 0 : failures + 1;
      if (ok) online = true;
      if ((online && failures < 3) !== was) emit();
    },
  };
}

/* ── transient status messages ───────────────────────────────────────
   Actions like "copied" or "code saved" previously wrote into a label
   that may be off-screen. A toast is anchored to the viewport, so
   feedback is seen wherever the user happens to be scrolled. */
export function createToast() {
  let el = null;
  let timer = null;

  return function toast(message, kind = "ok") {
    if (!message) return;
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), kind === "bad" ? 5200 : 2600);
  };
}

/**
 * Turn a getUserMedia rejection into something a presenter can act on.
 * The raw names ("NotAllowedError") tell a non-technical user nothing.
 */
export function micErrorMessage(err, t) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") return t("micDenied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("micNotFound");
  if (name === "NotReadableError" || name === "AbortError") return t("micBusy");
  return (err?.message || String(err)).slice(0, 200);
}

/* ── incident reporting ───────────────────────────────────────────────
   Sends only service-affecting failures to /api/errorReport, which emails
   them. Fire-and-forget and never awaited by a caller: a broken reporter
   must not become a second visible failure on top of the first.

   The server caps hard (5 per session, same kind once per 10 min) because
   the worst outcome here is an inbox flood during a live sermon. This side
   also refuses to report the same kind twice in one session, so a wedged
   microphone firing every 2 s produces exactly one request. */
export function createReporter({ session, hosted }) {
  const sentKinds = new Set();
  const startedAt = Date.now();
  let quota = "";

  return {
    setQuota(q) { quota = q || ""; },
    report(kind, message, detail) {
      if (sentKinds.has(kind)) return;      // once per kind per session
      sentKinds.add(kind);
      try {
        const body = JSON.stringify({
          kind, session, hosted,
          message: String(message || "").slice(0, 1000),
          detail: String(detail || "").slice(0, 4000),
          langs: (window.__sparkTargets || []),
          elapsedS: (Date.now() - startedAt) / 1000,
          quota,
          url: location.href,
          ua: navigator.userAgent,
        });
        // keepalive so the report still goes out if the tab is closing —
        // which is exactly when an uncaught error tends to happen.
        fetch("/api/errorReport", {
          method: "POST", headers: { "content-type": "application/json" },
          body, keepalive: true,
        }).catch(() => {});
      } catch { /* never let reporting throw into the caller */ }
    },
  };
}
