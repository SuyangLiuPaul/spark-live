import { quotaEstimate, poolHealth, hydrate, lastHydrateError, json, gateFails } from "./keys.mjs";

/**
 * Pre-flight quota — GET /api/quota.
 *
 * Answers "will this pool get me through the service?", which is the only quota
 * question a presenter can act on, and only before they start. Deliberately not
 * a live gauge: mid-session the number moves on its own (the daily cap refills
 * continuously) and the only response to a low reading — rotate keys — already
 * happens automatically.
 *
 * Costs nothing: it reports rate-limit headers already returned on calls we
 * make anyway. It never triggers a request to Groq.
 */
export default async (req) => {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const blocked = gateFails(req);
  if (blocked) return blocked;

  await hydrate();          // pull in what the asr/chat functions observed
  const q = quotaEstimate();
  if (!q) return json({ error: "not_configured" }, 503);

  return json({ ...q, pool: poolHealth(), diag: lastHydrateError });
};

export const config = { path: "/api/quota" };
