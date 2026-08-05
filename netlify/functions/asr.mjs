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
    fetch(GROQ, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: build() }));

  if (error) return json({ error }, status);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return json({ error: "upstream", status: res.status, detail: detail.slice(0, 300) }, res.status);
  }
  return json(await res.json());
};

export const config = { path: "/api/asr" };
