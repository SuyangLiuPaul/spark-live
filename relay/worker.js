/**
 * Spark Live ASR relay — a WebSocket pass-through so the church site needs no
 * setup at all.
 *
 * WHY THIS EXISTS
 * Gemini Live is a WebSocket the browser must hold open. Netlify cannot hold
 * one (Edge Functions are HTTP-only; Functions are Lambda), and Google's own
 * answer — ephemeral tokens — was rejected by the Live endpoint in every
 * documented form on 2026-08-17 while the real key connected first try. So the
 * key has to live somewhere that CAN hold a socket. That is this.
 *
 * The whole point is that the browser never sees a key: the page opens a plain
 * `wss://<worker>/asr`, this opens the authenticated socket to Google, and
 * frames are forwarded verbatim in both directions.
 *
 * FORWARD VERBATIM, DELIBERATELY
 * Frames are passed straight through — no JSON.parse, no re-encode. Audio
 * arrives as an already-built JSON string ~10 times a second; parsing it here
 * would burn the one budget that actually matters (see below) to learn nothing.
 *
 * THE OPEN QUESTION, AND HOW THIS ANSWERS IT
 * The free plan allows 10 ms of CPU per request, and Cloudflare's docs do not
 * say whether that is charged per message or cumulatively across a connection's
 * whole life. A 40-minute sermon is ~24,000 frames; if it is cumulative, this
 * dies mid-service. Rather than guess, every session counts its frames and
 * reports them on close, and GET /health tells you what the longest session so
 * far managed. If sessions start dying around a consistent frame count, that is
 * the answer — move the relay to a host that bills wall-clock instead (Deno
 * Deploy, Fly, Railway all hold sockets happily); the client needs only a new
 * URL, nothing else changes.
 */

// NOTE the scheme: an outbound WebSocket from a Worker is a `fetch()` carrying
// `Upgrade: websocket`, and that fetch wants **https://**. Passing the wss://
// form the browser would use makes the fetch throw, and the only symptom the
// page sees is the socket closing with "cannot reach upstream".
const UPSTREAM = "https://generativelanguage.googleapis.com/ws/"
  + "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// Observability. IMPORTANT CAVEAT, learned the hard way: these live in module
// scope, which is per-ISOLATE, and Cloudflare freely serves /health from a
// different isolate than the one holding a socket — a completed 24k-frame
// session can and did read back as `sessions: 0`. Treat these as a LOWER BOUND
// only. The authoritative number is the line logged on close, visible with
// `npx wrangler tail`.
let peakFrames = 0;
let sessions = 0;
let lastClose = "";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        keyConfigured: !!env.GEMINI_API_KEY,
        // Length only, never any part of the value: enough to tell a
        // whitespace-padded paste from a different key, and useless to anyone
        // who reads it. A Google API key is 39 characters.
        keyLen: String(env.GEMINI_API_KEY || "").trim().length,
        originsAllowed: String(env.ALLOWED_ORIGINS || "").split(",").filter(Boolean).length || "any",
        // Lower bounds, not truth — see the caveat above the declarations.
        sessionsSeenByThisIsolate: sessions,
        peakFramesSeenByThisIsolate: peakFrames,
        lastClose,
      });
    }

    if (url.pathname !== "/asr") return new Response("not found", { status: 404 });

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (!env.GEMINI_API_KEY) {
      return new Response("relay not configured: set the GEMINI_API_KEY secret", { status: 503 });
    }
    // Origin is the only gate, deliberately. A shared access code was tried and
    // removed: it has to be embedded in the relay URL, which ships inside the
    // site's public config.js, so every visitor could read it — it protected
    // nothing while looking like it did. A browser sets Origin itself and a
    // page cannot forge it, so an allowlist genuinely stops another site from
    // spending this key. (A non-browser client CAN forge the header; this is a
    // quota guard, not an authentication system, and is not load-bearing —
    // the client falls back to Whisper if the relay refuses.)
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(origin)) {
      return new Response(`origin not allowed: ${origin || "(none)"}`, { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    // Gemini sends its JSON in BINARY frames, and a binary frame arrives here
    // as a Blob unless asked otherwise. `send()` does not take a Blob — it
    // coerces it, so every reply became the 13-byte string "[object Blob]" and
    // the entire transcript was silently destroyed in transit. Asking for
    // ArrayBuffer keeps the forward genuinely verbatim.
    server.binaryType = "arraybuffer";

    // Frames the page sends before the upstream handshake finishes would
    // otherwise be dropped on the floor — which for us means the opening
    // seconds of a sermon. Hold them and flush in order.
    let upstream = null;
    let queued = [];
    let frames = 0;
    let closed = false;

    const shut = (code, reason) => {
      if (closed) return;
      closed = true;
      peakFrames = Math.max(peakFrames, frames);
      lastClose = `${code} ${String(reason || "").slice(0, 80)} after ${frames} frames`;
      // The one reliable record: module state may be read from another isolate,
      // a log line cannot be missed. `npx wrangler tail` to watch a service.
      console.log(`session end: code=${code} frames=${frames} reason=${String(reason || "").slice(0, 80)}`);
      try { server.close(code >= 1000 && code <= 4999 ? code : 1011, String(reason || "").slice(0, 120)); } catch {}
      try { upstream && upstream.close(); } catch {}
    };

    server.addEventListener("message", (e) => {
      frames++;
      if (!upstream || upstream.readyState !== WebSocket.READY_STATE_OPEN) {
        // Bounded: a page that keeps talking to a dead upstream must not grow
        // this without limit. 600 frames is ~60 s of audio.
        if (queued.length < 600) queued.push(e.data);
        return;
      }
      try { upstream.send(e.data); } catch (err) { shut(1011, "upstream send failed"); }
    });
    server.addEventListener("close", () => shut(1000, "client closed"));
    server.addEventListener("error", () => shut(1011, "client error"));

    // The key is attached HERE and only here. It is trimmed because a key
    // pasted into `wrangler secret put` easily carries a trailing newline, and
    // Google's only reply to that is a flat "API key not valid" — a wrong
    // answer to look at for an hour when the key itself is fine.
    const target = `${UPSTREAM}?key=${encodeURIComponent(String(env.GEMINI_API_KEY).trim())}`;
    let res;
    try {
      res = await fetch(target, { headers: { Upgrade: "websocket" } });
    } catch (err) {
      // Carry the reason across — debugging this blind cost a deploy cycle.
      shut(1011, `cannot reach upstream: ${String(err && err.message || err).slice(0, 60)}`);
      return new Response(null, { status: 101, webSocket: client });
    }
    upstream = res.webSocket;
    if (!upstream) {
      // Google refused the upgrade — almost always a bad or unauthorised key.
      // Say so on the socket, because the page has no other way to find out.
      shut(1011, `upstream refused (${res.status})`);
      return new Response(null, { status: 101, webSocket: client });
    }
    upstream.accept();
    upstream.binaryType = "arraybuffer";  // see the note on server.binaryType

    upstream.addEventListener("message", (e) => {
      try { server.send(e.data); } catch { shut(1011, "client send failed"); }
    });
    upstream.addEventListener("close", (e) => shut(e.code || 1000, e.reason || "upstream closed"));
    upstream.addEventListener("error", () => shut(1011, "upstream error"));

    for (const f of queued) { try { upstream.send(f); } catch {} }
    queued = [];
    sessions++;

    return new Response(null, { status: 101, webSocket: client });
  },
};

function json(body) {
  return new Response(JSON.stringify(body, null, 1), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
