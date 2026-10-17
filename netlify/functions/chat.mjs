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

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash"];

function geminiKeys() {
  return String(process.env.GEMINI_API_KEY || process.env.SPARK_GEMINI_API_KEY || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function askGeminiFallback(sys, prompt) {
  const keys = geminiKeys();
  if (!keys.length) return null;
  for (const key of keys) {
    for (const m of GEMINI_MODELS) {
      const genCfg = {
        temperature: 0.15,
        responseMimeType: "application/json",
        maxOutputTokens: 4096,
        ...(m.includes("lite") ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
      };
      try {
        const r = await fetch(`${GEMINI_URL}/${m}:generateContent?key=${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sys }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: genCfg,
          }),
        });
        if (!r.ok) continue;
        const data = await r.json();
        const text = (data?.candidates?.[0]?.content?.parts || [])
          .filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("")
          .trim();
        if (text) return { content: text, usage: null, via: m };
      } catch {
        continue;
      }
    }
  }
  return null;
}

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
  // gpt-oss thinks before it answers, and every thinking token counts against the
  // key's per-minute AND per-day allowance — the same allowance the translations
  // themselves need. For correct-and-translate of ONE sentence that thinking buys
  // almost nothing, so keep it short. (Other models reject the field, hence the guard.)
  const payload = JSON.stringify({
    model,
    temperature: 0.15,
    max_tokens: 2048,
    ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
  });

  const { res, error, status } = await withKeys((key) =>
    fetch(GROQ, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: payload,
    }), "chat");

  if (error || !res || !res.ok) {
    const gem = await askGeminiFallback(sys, prompt);
    if (gem) return json(gem);
    if (error) return json({ error }, status);
    const detail = await res.text().catch(() => "");
    return json({ error: "upstream", status: res.status, detail: detail.slice(0, 300) }, res.status);
  }

  // Groq answering 200 with a body that isn't JSON is rare but real (an edge
  // error page in front of the API). Parsing it unguarded throws, and an
  // exception here is another 502 for the room to look at.
  let data;
  try {
    data = await res.json();
  } catch (e) {
    const gem = await askGeminiFallback(sys, prompt);
    if (gem) return json(gem);
    return json({ error: "bad_upstream_json", detail: String(e.message || e).slice(0, 160) }, 502);
  }
  // `usage` is returned so a replay can total what a service actually costs; nothing in
  // the page depends on it.
  return json({ content: data?.choices?.[0]?.message?.content || "", usage: data?.usage || null });
};

export const config = { path: "/api/chat" };
