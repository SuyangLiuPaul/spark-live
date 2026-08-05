import { withKeys, json, gateFails } from "./keys.mjs";

/**
 * Correction + translation proxy — POST /api/chat { sys, prompt, model? }.
 *
 * Counterpart to /api/asr: same reason (keys stay server-side), same rotation.
 * Only the models this app actually uses are accepted, so a stray caller can't
 * spend the pool on something expensive.
 */
const GROQ = "https://api.groq.com/openai/v1/chat/completions";
const ALLOWED = new Set(["openai/gpt-oss-120b", "groq/compound-mini", "llama-3.1-8b-instant"]);
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const MAX_CHARS = 24000;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const blocked = gateFails(req);
  if (blocked) return blocked;

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const sys = String(body.sys || "").slice(0, MAX_CHARS);
  const prompt = String(body.prompt || "").slice(0, MAX_CHARS);
  if (!prompt) return json({ error: "missing_prompt" }, 400);

  const model = ALLOWED.has(String(body.model)) ? String(body.model) : DEFAULT_MODEL;
  const payload = JSON.stringify({
    model,
    temperature: 0.15,
    max_tokens: 2048,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
  });

  const { res, error, status } = await withKeys((key) =>
    fetch(GROQ, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: payload,
    }), "chat");

  if (error) return json({ error }, status);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return json({ error: "upstream", status: res.status, detail: detail.slice(0, 300) }, res.status);
  }

  const data = await res.json();
  return json({ content: data?.choices?.[0]?.message?.content || "" });
};

export const config = { path: "/api/chat" };
