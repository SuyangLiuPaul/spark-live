import { getStore } from "@netlify/blobs";

/**
 * Audience → relay. Returns the current session document.
 *
 * Deliberately dumb + cacheable: netlify.toml puts `s-maxage=1` on this path so
 * the CDN answers nearly every viewer poll, and the function itself runs about
 * once per second regardless of how many people are in the room.
 *
 * GET /api/feed?s=CODE[&v=N]   → 200 doc | 204 (unchanged) | 404
 */
const CORS = { "Access-Control-Allow-Origin": "*" };

export default async (req) => {
  const url = new URL(req.url);
  const session = String(url.searchParams.get("s") || "").trim().toUpperCase();
  const since = Number(url.searchParams.get("v") || -1);

  if (!/^[A-Z0-9]{4,12}$/.test(session)) {
    return new Response(JSON.stringify({ error: "bad_session" }), {
      status: 400,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
    });
  }

  const store = getStore({ name: "spark-live", consistency: "strong" });
  let rec = null;
  try {
    rec = await store.get(`s/${session}.json`, { type: "json" });
  } catch {
    rec = null;
  }

  if (!rec || !rec.doc) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
    });
  }

  // Never leak the presenter's publish token to viewers.
  const doc = rec.doc;

  // The CDN can only collapse viewer polls if the FUNCTION says so.
  // netlify.toml's [[headers]] block does not apply to function responses, so
  // the s-maxage rule there never reached this endpoint and every poll from
  // every phone became its own invocation. `netlify-vary: query` keys the cache
  // on the query string, so viewers sitting at the same version share one
  // entry — which is exactly what the original design intended.
  const CACHE = "public, s-maxage=1, stale-while-revalidate=4";

  if (since >= 0 && Number(doc.v) <= since) {
    // A 204 MUST carry a null body — passing "" makes the runtime emit a 502.
    // Cached too: while nobody is speaking, these are the bulk of the traffic.
    return new Response(null, { status: 204, headers: { "cache-control": CACHE, ...CORS } });
  }

  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": CACHE, ...CORS },
  });
};

export const config = { path: "/api/feed" };
