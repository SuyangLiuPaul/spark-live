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
        keyConfigured: keysFrom(env).length > 0,
        // Lengths only, never any part of a value: enough to tell a
        // whitespace-padded paste from a different key, and useless to anyone
        // who reads it. A Google API key is 39 characters.
        keyCount: keysFrom(env).length,
        benchedKeys: keysFrom(env).filter((k) => isBenched(k)).length,
        keyLens: keysFrom(env).map((k) => k.length),
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
    // One service = one key. The page sends a random `sid` that stays the same
    // across its reconnects, and it picks which key goes FIRST, so a sermon keeps
    // the account its session-resumption handle was issued under, while different
    // services land on different keys — that is the rotation. No sid (an old page,
    // a probe) just gets a random start.
    const allKeys = keysFrom(env);
    const { keys, preferred } = orderKeys(allKeys, url.searchParams.get("sid") || "");
    // Name a key by where it sits in the secret (#1 is the first one pasted), so a
    // log line says WHICH account is failing without ever containing a key. The
    // order tried is rotated per session, so "the 2nd attempt" identifies nothing.
    const nameOf = (k) => `#${allKeys.indexOf(k) + 1}/${allKeys.length}(len ${k.length})`;
    if (!keys.length) {
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
    // True once an upstream has ANSWERED. Until then every frame the page sends
    // is kept (see the message handler) so a failed key can be replayed onto the
    // next one — the setup frame above all, without which no session can start.
    let established = false;
    // The key the live socket is using. A session-resumption handle is issued by
    // ONE key's session; presenting it under another key is, at best, rejected —
    // which would make a failover useless exactly when it is needed. So when the
    // key in use is not the one this session started on, the handle is removed
    // from the setup frame (the one frame this ever touches) and the session
    // simply starts fresh: the transcript carries on, only the server-side context
    // is lost. Audio frames never contain the string and pass through untouched.
    let currentKey = null;
    const prep = (data) => {
      if (currentKey === preferred || typeof data !== "string" || !data.includes('"handle"')) return data;
      try {
        const m = JSON.parse(data);
        if (m && m.setup && m.setup.sessionResumption && m.setup.sessionResumption.handle) {
          delete m.setup.sessionResumption.handle;
          return JSON.stringify(m);
        }
      } catch { /* not JSON we understand: forward it verbatim */ }
      return data;
    };

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
      // Keep everything until a key has answered, whether or not a socket is
      // open right now. Google ACCEPTS the socket of a spent key and only then
      // closes it, so "open" proves nothing — the setup frame has often already
      // gone out on a socket that is about to die, and the next key needs it
      // again. Bounded: 600 frames is ~60 s of audio.
      if (!established && queued.length < 600) queued.push(e.data);
      if (!upstream || upstream.readyState !== WebSocket.READY_STATE_OPEN) return;
      try { upstream.send(prep(e.data)); } catch (err) { shut(1011, "upstream send failed"); }
    });
    server.addEventListener("close", () => shut(1000, "client closed"));
    server.addEventListener("error", () => shut(1011, "client error"));

    // The key is attached HERE and only here. It is trimmed because a key
    // pasted into `wrangler secret put` easily carries a trailing newline, and
    // Google's only reply to that is a flat "API key not valid" — a wrong
    // answer to look at for an hour when the key itself is fine.
    //
    // WHY THERE IS MORE THAN ONE. A spent key does not refuse the upgrade; it
    // accepts the socket and then closes it, and on 2026-10-04 that close read:
    //
    //   1011 "Your prepayment credits are depleted. Please go to AI Studio…"
    //
    // With a single key that ends the session — the page gives up on streaming
    // and the service finishes on Whisper. So GEMINI_API_KEY may hold SEVERAL
    // keys, comma- or whitespace-separated, and a key that dies this way hands
    // over to the next one instead of taking the relay down. One key still
    // works exactly as before.
    //
    // Note what is NOT claimed here: Google meters the free tier per PROJECT,
    // so extra keys on the SAME project add no quota — they only add
    // resilience. Keys from separate accounts do add quota, and Google's API
    // terms §2.d say you "will not attempt to circumvent" their limits, so
    // that is the operator's call to make knowingly, not a default this code
    // quietly assumes.
    const FATAL_KEY = /credit|billing|quota|exhaust|deplet|insufficient|balance|payment|api[ _]?key[ _]?(not[ _]?valid|invalid)|unauthenticated|unregistered|permission/i;

    // Which upstream socket is the live one. A failed socket raises BOTH `close`
    // and `error`, and an old socket can still deliver a message after its
    // successor has taken over — measured against a stand-in Google: one spent
    // key produced four connections to the good key and four setupComplete
    // replies to the page, because each event started its own failover chain.
    // So every socket carries its own number, handles at most ONE failure, and
    // is ignored once superseded.
    let generation = 0;

    const connect = async (i) => {
      if (closed || i >= keys.length) return false;
      const mine = ++generation;
      const key = keys[i];
      let failed = false;
      const live = () => mine === generation && !closed;

      // This socket is finished: move to the next key, or end the session with
      // the reason Google gave if there is none left. Runs once per socket.
      const failOver = (code, reason, keyFault) => {
        if (failed || !live()) return;
        failed = true;
        if (keyFault) bench(key);
        if (!established && i + 1 < keys.length) {
          console.log(`key ${nameOf(key)} failed: ${String(reason).slice(0, 80)} — trying the next`);
          upstream = null;
          connect(i + 1).then((ok) => { if (!ok) shut(code, reason); });
          return;
        }
        shut(code, reason);
      };

      let res;
      try {
        res = await fetch(`${env.UPSTREAM_URL || UPSTREAM}?key=${encodeURIComponent(key)}`,
                          { headers: { Upgrade: "websocket" } });
      } catch (err) {
        // Carry the reason across — debugging this blind cost a deploy cycle.
        const why = `cannot reach upstream: ${String(err && err.message || err).slice(0, 60)}`;
        if (i + 1 < keys.length && live()) return connect(i + 1);
        shut(1011, why);
        return false;
      }
      const ws = res.webSocket;
      if (!ws) {
        // Google refused the upgrade — almost always a bad or unauthorised key.
        if (i + 1 < keys.length && live()) { bench(key); return connect(i + 1); }
        shut(1011, `upstream refused (${res.status})`);
        return false;
      }
      ws.accept();
      ws.binaryType = "arraybuffer";  // see the note on server.binaryType

      ws.addEventListener("message", (e) => {
        if (!live()) return;                       // a superseded socket's late reply
        // The first reply is proof this key works: stop holding frames for a
        // replay that will now never happen.
        if (!established) { established = true; queued = []; console.log(`key ${nameOf(key)} answered — session established`); }
        try { server.send(e.data); } catch { shut(1011, "client send failed"); }
      });
      ws.addEventListener("close", (e) => {
        const reason = e.reason || "upstream closed";
        if (!established) console.log(`key ${nameOf(key)} closed before answering: ${e.code} ${String(reason).slice(0, 80)}`);
        // Closed before it ever answered, for a reason that is about the KEY
        // rather than the audio: the next key may well be fine.
        failOver(e.code || 1000, reason, !established && FATAL_KEY.test(reason));
      });
      ws.addEventListener("error", () => failOver(1011, "upstream error", false));

      currentKey = key;
      upstream = ws;
      // Replay everything the page has sent so far, in order.
      for (const f of queued) { try { ws.send(prep(f)); } catch {} }
      return true;
    };

    await connect(0);
    if (closed) return new Response(null, { status: 101, webSocket: client });

    sessions++;

    return new Response(null, { status: 101, webSocket: client });
  },
};

/**
 * Keys for the upstream, in order. One key is the ordinary case and behaves
 * exactly as it always did; several are separated by commas or whitespace.
 * Trimmed per key — see the note at the connection site on trailing newlines.
 */
// A key that was just rejected for a KEY reason (spent, over quota, revoked) is
// tried last for ten minutes, so a dead first key does not cost every new
// session a wasted round-trip. Per-isolate memory, like the counters above —
// it is an optimisation only, and a cold isolate simply relearns.
const BENCH_MS = 10 * 60 * 1000;
const benchedUntil = new Map();
const bench = (k) => benchedUntil.set(k, Date.now() + BENCH_MS);
const isBenched = (k) => (benchedUntil.get(k) || 0) > Date.now();
// FNV-1a: tiny, stable, and good enough to spread session ids over a few keys.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Rotate the key list to start at this session's key, then move any key that was
 * just rejected to the back. `preferred` is the key the session STARTS on, before
 * any cooldown reshuffling — it is what the resumption handle was issued under.
 */
function orderKeys(keys, sid) {
  if (!keys.length) return { keys, preferred: null };
  const start = sid ? hash(sid) % keys.length : Math.floor(Math.random() * keys.length);
  const rotated = keys.map((_, i) => keys[(start + i) % keys.length]);
  return {
    keys: [...rotated.filter((k) => !isBenched(k)), ...rotated.filter((k) => isBenched(k))],
    preferred: rotated[0],
  };
}

function keysFrom(env) {
  return String(env.GEMINI_API_KEY || "")
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function json(body) {
  return new Response(JSON.stringify(body, null, 1), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
