// Spark Live error reporter — mirrors YsWords' netlify/functions/errorReport.mjs
// (same Resend account, same 204-always contract) with the differences a LIVE
// service demands.
//
// Endpoint: POST /api/errorReport
//
// Env:
//   RESEND_API_KEY  — required to actually send; without it we log and 204.
//   FEEDBACK_TO     — destination (default lsy95112@gmail.com)
//
// The hard design constraint here is NOT capturing everything — it is never
// flooding the inbox during a service. A three-hour sermon with a wedged
// microphone would otherwise send an email every couple of seconds. So:
//
//   * only service-affecting kinds are accepted (see KINDS); a single 429 that
//     rotation already absorbed is not an incident and never reaches this,
//   * the same (session, kind) is sent at most once every 10 minutes,
//   * and a session is capped at 5 emails total, ever.
//
// Beyond that a report is worthless if it arrives without the state that
// explains it, so each one carries the session code, how long it had been
// running, the target languages, and the quota at the time.
const TO_DEFAULT = "lsy95112@gmail.com";
const FROM_DEFAULT = "Spark Live <onboarding@resend.dev>";

// Only things that actually degrade what the room sees.
const KINDS = new Set([
  "mic_denied",        // presenter never got a microphone
  "mic_stalled",       // audio stopped mid-session (bluetooth drop, device grab)
  "quota_exhausted",   // every key hit its daily cap
  "asr_failed",        // speech recognition failing repeatedly
  "translate_failed",  // correction/translation failing repeatedly
  "publish_failed",    // audience stopped receiving — they see a frozen screen
  "uncaught",          // an unhandled exception in the console
]);

const DEDUPE_MS = 10 * 60 * 1000;   // same session+kind: once per 10 min
const MAX_PER_SESSION = 5;          // hard ceiling per session, ever

/**
 * The caps have to be shared across function instances, not held in one.
 *
 * They used to live in module-scope Maps, which sound global but are per warm
 * Lambda: with the audience view reporting too, seventy phones hitting the same
 * bug land on however many instances Netlify has warm, and each one believes it
 * is sending the first email. The whole point of these limits is that a bad
 * service cannot flood the inbox, so they belong in shared storage.
 *
 * The blob store is already used by the relay. A read-modify-write race here
 * costs at most one duplicate email, which is a far better failure than the
 * flood — so it is deliberately not locked.
 */
import { getStore } from "@netlify/blobs";

const STORE = "spark-live";
const LEDGER = "incidents/ledger.json";
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

async function ledger() {
  try {
    const store = getStore({ name: STORE, consistency: "strong" });
    const cur = (await store.get(LEDGER, { type: "json" }).catch(() => null)) || {};
    return { store, cur };
  } catch {
    return { store: null, cur: {} };
  }
}

/** Returns true when this report should be sent, and records it if so. */
async function claim(session, kind) {
  const { store, cur } = await ledger();
  const now = Date.now();

  // Sessions are single-day events; drop anything older so the ledger cannot
  // grow forever.
  for (const [k, v] of Object.entries(cur)) {
    if (now - (v.last || 0) > LEDGER_TTL_MS) delete cur[k];
  }

  const e = cur[session] || { count: 0, kinds: {}, last: 0 };
  if (e.count >= MAX_PER_SESSION) return false;
  if (e.kinds[kind] && now - e.kinds[kind] < DEDUPE_MS) return false;

  e.kinds[kind] = now;
  e.count += 1;
  e.last = now;
  cur[session] = e;
  // A serverless instance freezes the moment it responds, so this must be
  // awaited or the ledger silently never updates and every cap is off.
  if (store) { try { await store.setJSON(LEDGER, cur); } catch {} }
  return true;
}

const clamp = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const noContent = () => new Response(null, { status: 204, headers: CORS });

export default async (req) => {
  if (req.method === "OPTIONS") return noContent();
  // Always 204, even on junk input: the client is already in a bad state and a
  // failing error-reporter must never become a second visible failure.
  if (req.method !== "POST") return noContent();

  let b;
  try { b = await req.json(); } catch { return noContent(); }

  const kind = clamp(b?.kind || "", 32);
  if (!KINDS.has(kind)) return noContent();          // not service-affecting

  const session = clamp(b?.session || "?", 16);

  if (!(await claim(session, kind))) return noContent();

  const message  = clamp(b?.message || "", 1000);
  const detail   = clamp(b?.detail || "", 4000);
  const langs    = clamp(Array.isArray(b?.langs) ? b.langs.join(", ") : "", 100);
  const elapsed  = Number.isFinite(b?.elapsedS) ? Math.round(b.elapsedS) : null;
  const hosted   = b?.hosted === true;
  const quota    = clamp(b?.quota || "", 100);
  const ua       = clamp(b?.ua || req.headers.get("user-agent") || "", 300);
  const url      = clamp(b?.url || "", 300);

  const mins = elapsed == null ? "—" : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const subject = `[Spark Live] ${kind} — session ${session}`;
  const rows = [
    ["Kind", kind], ["Session", session], ["Running for", mins],
    ["Languages", langs || "—"], ["Mode", hosted ? "hosted (server keys)" : "own key"],
    ["Quota at error", quota || "—"], ["URL", url || "—"], ["User agent", ua || "—"],
  ];

  const text = [
    `Spark Live incident: ${kind}`, "",
    ...rows.map(([k, v]) => `${(k + ":").padEnd(16)}${v}`),
    "", "Message:", message || "(none)",
    "", "Detail:", detail || "(none)",
    "", `(Capped: max ${MAX_PER_SESSION} emails per session, same kind at most once per 10 min.)`,
  ].join("\n");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font:14px/1.6 -apple-system,'Segoe UI',sans-serif;color:#222">
<h2 style="margin:0 0 12px;font-size:16px;color:#b91c1c">Spark Live — ${esc(kind)}</h2>
<table style="border-collapse:collapse;font-size:13px">
${rows.map(([k, v]) => `<tr><td style="padding:2px 14px 2px 0;color:#666">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
</table>
<h3 style="margin:18px 0 6px;font-size:13px;color:#444">Message</h3>
<pre style="background:#f5f5f5;padding:10px;border-radius:4px;font:11px/1.4 Menlo,monospace;white-space:pre-wrap">${esc(message || "(none)")}</pre>
<h3 style="margin:18px 0 6px;font-size:13px;color:#444">Detail</h3>
<pre style="background:#f5f5f5;padding:10px;border-radius:4px;font:11px/1.4 Menlo,monospace;white-space:pre-wrap">${esc(detail || "(none)")}</pre>
<p style="color:#999;font-size:11px">Capped at ${MAX_PER_SESSION} emails per session; same kind at most once per 10 minutes.</p>
</body></html>`;

  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const to = (process.env.FEEDBACK_TO || TO_DEFAULT).trim() || TO_DEFAULT;
  if (!apiKey) {
    console.error("[errorReport] no RESEND_API_KEY — logging only\n" + text);
    return noContent();
  }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_DEFAULT, to, subject, text, html }),
    });
    if (!r.ok) console.error("[errorReport] resend", r.status, (await r.text().catch(() => "")).slice(0, 400));
  } catch (e) {
    console.error("[errorReport] threw", String(e?.message || e).slice(0, 300));
  }
  return noContent();
};

export const config = { path: "/api/errorReport" };
