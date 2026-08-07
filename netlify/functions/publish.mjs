import { getStore } from "@netlify/blobs";

/**
 * Presenter → relay. Stores the whole session document (it is only a few KB).
 *
 * First publish for a code claims it with `token`; later publishes must present
 * the same token, so a stray viewer can't hijack a running session.
 *
 * POST /api/publish  { session, token, doc }
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra },
  });

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const session = String(body.session || "").trim().toUpperCase();
  const token = String(body.token || "").trim();
  const doc = body.doc;

  if (!/^[A-Z0-9]{4,12}$/.test(session)) return json({ error: "bad_session" }, 400);
  if (token.length < 8) return json({ error: "bad_token" }, 400);
  if (!doc || typeof doc !== "object") return json({ error: "bad_doc" }, 400);

  const store = getStore({ name: "spark-live", consistency: "strong" });
  const key = `s/${session}.json`;

  let existing = null;
  try {
    existing = await store.get(key, { type: "json" });
  } catch {
    existing = null;
  }

  if (existing && existing.token && existing.token !== token) {
    return json({ error: "session_taken" }, 409);
  }

  // Bound the payload so a very long session can't grow without limit.
  let lines = Array.isArray(doc.lines) ? doc.lines.slice(-120) : [];
  let live = !!doc.live;

  // Never let an idle announcement blank a running session.
  //
  // The presenter console publishes an "idle" document on every page load, and
  // its in-memory transcript is empty at that moment. So a refresh — or an iOS
  // tab the OS killed for memory, mid-sermon — replaced the room's transcript
  // with "not started" on every phone at once, and the monotonic `v` above
  // guaranteed the wipe was accepted rather than ignored. The presenter's own
  // screen looked fine throughout.
  //
  // Ending a service is `ended: true`, and starting a fresh one mints a new
  // code AND a new token, so neither legitimate reset reaches this branch.
  const wasLive = !!existing?.doc?.live;
  if (wasLive && !live && !doc.ended && !lines.length) {
    lines = Array.isArray(existing.doc.lines) ? existing.doc.lines : [];
    live = true;
  }

  const clean = {
    // The version must only ever move FORWARD for a session code. The
    // presenter's doc.v is per-page-load state and resets to 0 on every
    // reload, so a refresh used to republish v=1 over a stored v=40 — and
    // /api/feed answers 204 whenever stored.v <= the viewer's last seen
    // version, freezing every phone in the room permanently. The presenter
    // sees their own console updating fine and has no idea.
    //
    // The server is the only place that knows the previous value, so
    // monotonicity belongs here, not in the client.
    v: Math.max(Number(doc.v) || 0, (Number(existing?.doc?.v) || 0) + 1),
    title: String(doc.title || "").slice(0, 200),
    live,
    ended: !!doc.ended,
    draft: String(doc.draft || "").slice(0, 2000),
    interim: String(doc.interim || "").slice(0, 2000),
    langs: Array.isArray(doc.langs) ? doc.langs.slice(0, 3) : [],
    startedAt: Number(doc.startedAt) || Date.now(),
    updatedAt: Date.now(),
    lines,
  };

  await store.setJSON(key, { token, doc: clean });
  return json({ ok: true, v: clean.v, session });
};

export const config = { path: "/api/publish" };
