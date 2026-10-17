import { withKeys, json, gateFails } from "./keys.mjs";

/**
 * Speech-recognition proxy — POST /api/asr, multipart with a `file` field.
 *
 * Exists so the hosted site works with no key entry: the browser sends audio,
 * this adds a key from the server-side pool. Nothing secret is ever shipped to
 * the client.
 *
 * The form is re-built rather than forwarded verbatim so the model and options
 * are ours, not the caller's — otherwise anyone could point our keys at any
 * model on the account.
 */
const GROQ = "https://api.groq.com/openai/v1/audio/transcriptions";
const ALLOWED = new Set(["whisper-large-v3", "whisper-large-v3-turbo"]);
const MAX_BYTES = 5 * 1024 * 1024;   // our windows are <1 MB; this is a sanity bound

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent";

function geminiKeys() {
  return String(process.env.GEMINI_API_KEY || process.env.SPARK_GEMINI_API_KEY || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function transcribeViaGemini(file, language) {
  const keys = geminiKeys();
  if (!keys.length) return null;
  const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const mime = file.type || "audio/wav";
  const langHint = language && language !== "auto" ? ` (language: ${language})` : "";
  const body = JSON.stringify({
    contents: [{
      parts: [
        { inlineData: { mimeType: mime, data: b64 } },
        { text: `Transcribe this audio verbatim${langHint}.` },
      ],
    }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 4096 },
  });
  for (const key of keys) {
    try {
      const r = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!r.ok) continue;
      const data = await r.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts
        .filter((p) => !p.thought)
        .map((p) => p?.audioTranscription?.text || p?.text || "")
        .join(" ")
        .trim();
      if (text) return { text };
    } catch {
      continue;
    }
  }
  return null;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const blocked = gateFails(req);
  if (blocked) return blocked;

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "bad_form" }, 400);
  }

  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "missing_file" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "file_too_large" }, 413);

  const model = ALLOWED.has(String(form.get("model"))) ? String(form.get("model")) : "whisper-large-v3";
  const language = String(form.get("language") || "").trim();

  const build = () => {
    const fd = new FormData();
    fd.append("file", file, "chunk.wav");
    fd.append("model", model);
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "word");
    fd.append("temperature", "0");
    if (language && language !== "auto") fd.append("language", language);
    return fd;
  };

  const { res, error, status } = await withKeys((key) =>
    fetch(GROQ, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: build() }), "asr");

  if (error || !res || !res.ok) {
    const gem = await transcribeViaGemini(file, language);
    if (gem) return json(gem);
    if (error) return json({ error }, status);
    const detail = await res.text().catch(() => "");
    return json({ error: "upstream", status: res.status, detail: detail.slice(0, 300) }, res.status);
  }
  try {
    return json(await res.json());
  } catch (e) {
    const gem = await transcribeViaGemini(file, language);
    if (gem) return json(gem);
    return json({ error: "bad_upstream_json", detail: String(e.message || e).slice(0, 160) }, 502);
  }
};

export const config = { path: "/api/asr" };
