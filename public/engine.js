/**
 * Spark Live — capture → stabilise → correct → translate.
 *
 * The accuracy strategy, in one place:
 *
 *   1. Capture raw 16 kHz PCM (AudioWorklet). Raw PCM — not MediaRecorder —
 *      because we need to slice arbitrary OVERLAPPING windows, and webm/opus
 *      chunks after the first have no headers and can't be decoded alone.
 *
 *   2. Every tick, transcribe the whole *uncommitted* tail. Consecutive passes
 *      see overlapping audio, so we can apply LocalAgreement: only the words
 *      where two independent passes agree get committed. Two passes agreeing is
 *      a strong signal; everything after stays provisional and may still change.
 *      This is what makes the text visibly "sharpen" instead of just being wrong.
 *
 *   3. Committed words accumulate into sentences (punctuation or a silence gap).
 *      Whole sentences — never fragments — go to the LLM, which corrects ASR
 *      errors against the glossary AND translates to Dari in a single call
 *      (one round-trip, and the corrector's output is what gets translated, so
 *      errors don't compound).
 */

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const TICK_MS = 2200;        // confirm pass cadence — tighter = text lands sooner
const MIN_WINDOW_S = 1.2;
const MAX_WINDOW_S = 28;
const SILENCE_RMS = 0.012;
const SILENCE_FLUSH_MS = 700; // a pause this long ends a unit
const MAX_SENTENCE_CHARS = 150;
const MAX_UNIT_WAIT_MS = 6000;// never sit on committed text longer than this
const MIN_CLAUSE_CHARS = 26;  // a comma only ends a unit once it's worth sending

// Interim ("live tail") translation: cheap, fast, provisional. Only ONE line is
// ever in this state, so corrections never disturb text the audience already read.
const INTERIM_MODEL = "llama-3.1-8b-instant";
const INTERIM_MIN_MS = 2500;  // throttle
const INTERIM_MIN_CHARS = 8;
const INTERIM_MIN_DELTA = 4;  // don't re-spend on a 1-word change

/* ────────────────────────── audio ────────────────────────── */

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('cap', Cap);
`;

/**
 * Audio inputs the browser will let us use. Labels are only populated once mic
 * permission has been granted — before that the OS returns anonymous entries,
 * so callers should say so rather than showing a list of blanks.
 */
export async function listInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return { devices: [], labelled: false };
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const devices = all.filter((d) => d.kind === "audioinput" && d.deviceId);
  return { devices, labelled: devices.some((d) => d.label) };
}

class Capture {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.ctx = null;
    this.node = null;
    this.src = null;
    this.stream = null;
  }

  async start() {
    const audio = {
      channelCount: 1,
      echoCancellation: false,   // we want the room, not a cleaned-up call
      noiseSuppression: false,   // NS eats quiet speech from a distant speaker
      autoGainControl: true,
    };
    // A laptop presenter is usually plugged into a sound desk or a USB mic, so
    // the OS default is often the wrong input. `exact` would throw if the saved
    // device is gone (unplugged between services), so prefer it and let the
    // browser fall back rather than refusing to start.
    if (this.deviceId) audio.deviceId = { ideal: this.deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.src = this.ctx.createMediaStreamSource(this.stream);

    if (this.ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, "cap");
      this.node.port.onmessage = (e) => this.onChunk(e.data, this.ctx.sampleRate);
    } else {
      // Safari fallback.
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = (e) =>
        this.onChunk(new Float32Array(e.inputBuffer.getChannelData(0)), this.ctx.sampleRate);
    }
    // iOS suspends the AudioContext whenever Safari goes to the background —
    // an app switch, an incoming call, a notification tapped. Nothing resumed it
    // afterwards, so capture stayed dead until the session was restarted. Retake
    // it on every return to the foreground, and whenever the context says it
    // changed state, so an iPad or iPhone recovers on its own.
    this._wake = () => {
      if (!this.ctx || this.ctx.state !== "suspended") return;
      this.ctx.resume().catch(() => {});
    };
    document.addEventListener("visibilitychange", this._wake);
    this.ctx.addEventListener?.("statechange", this._wake);

    this.src.connect(this.node);
    // Worklets need a sink to be pulled; a muted gain keeps it silent.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    return this.ctx.sampleRate;
  }

  stop() {
    // Detach the foreground listener too, or a stopped session keeps a closed
    // context alive through the document and leaks on every restart.
    if (this._wake) {
      document.removeEventListener("visibilitychange", this._wake);
      try { this.ctx?.removeEventListener?.("statechange", this._wake); } catch {}
      this._wake = null;
    }
    try { this.node && this.node.disconnect(); } catch {}
    try { this.src && this.src.disconnect(); } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.ctx && this.ctx.close(); } catch {}
  }
}

function resampleTo16k(input, rate) {
  if (rate === 16000) return input;
  const ratio = rate / 16000;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] || 0;
    const b = input[i0 + 1] != null ? input[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function rmsOf(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  // Stride: at 16 kHz every 4th sample is ample for a speech/silence decision.
  for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / Math.ceil(pcm.length / 4));
}

function encodeWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/* ─────────────────────── stabiliser ─────────────────────── */

const normWord = (w) => String(w || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * LocalAgreement: commit only the leading words that two consecutive
 * hypotheses agree on. Timestamps let us trim exactly the committed audio.
 */
class Agreement {
  constructor() { this.prev = []; }

  push(words) {
    const stable = [];
    const n = Math.min(this.prev.length, words.length);
    for (let i = 0; i < n; i++) {
      if (normWord(this.prev[i].w) && normWord(this.prev[i].w) === normWord(words[i].w)) {
        stable.push(words[i]);
      } else break;
    }
    const cut = stable.length ? stable[stable.length - 1].end : 0;
    this.prev = words.slice(stable.length).map((w) => ({ ...w, start: w.start - cut, end: w.end - cut }));
    return { stable, cut };
  }

  reset() { this.prev = []; }
  pendingText() { return this.prev.map((w) => w.w).join(" ").replace(/\s+([,.!?，。！？])/g, "$1").trim(); }
}

/* ────────────────────────── hosted proxy ────────────────────────── */

/**
 * When the site is deployed with a server-side key pool, the browser talks to
 * our own functions instead of Groq and never holds a key. Keys in the browser
 * are readable by whoever opens DevTools, so "hosted and ready to use" and
 * "keys in config.js" are mutually exclusive — this is the honest version.
 */
const PROXY_ASR = "/api/asr";
const PROXY_CHAT = "/api/chat";

function accessHeaders() {
  const code = (typeof window !== "undefined" && window.SPARK_LIVE_CONFIG?.accessCode) || "";
  return code ? { "x-spark-access": code } : {};
}

async function proxyFetch(url, init) {
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...accessHeaders() } });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.error === "not_configured" ? "server has no key pool configured"
          : j.error === "bad_access_code" ? "access code rejected"
          : `${j.error || res.status}${j.status ? " " + j.status : ""}`;
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ────────────────────────── key pool ────────────────────────── */

/**
 * Groq rate-limits PER KEY (~8k tokens/min for chat, ~7200 audio-sec/hr for
 * whisper), so N keys give N× headroom. We round-robin rather than
 * use-until-throttled: spreading calls evenly keeps every key comfortably
 * under its own budget instead of repeatedly slamming one into a 429.
 * A key that does 429 is benched briefly and the rotation skips it.
 */
export class KeyPool {
  constructor(keys) {
    this.keys = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || "").trim()).filter(Boolean);
    this.cool = new Map();
    this.i = 0;
  }
  get size() { return this.keys.length; }
  /** Next usable key, skipping any that are cooling down. */
  next() {
    if (!this.keys.length) return "";
    const now = Date.now();
    for (let n = 0; n < this.keys.length; n++) {
      const idx = (this.i + n) % this.keys.length;
      const k = this.keys[idx];
      if ((this.cool.get(k) || 0) <= now) { this.i = (idx + 1) % this.keys.length; return k; }
    }
    // Everything is benched — return the one that frees up soonest.
    return this.keys.reduce((a, b) => ((this.cool.get(a) || 0) <= (this.cool.get(b) || 0) ? a : b));
  }
  /** Bench a key after a 429. `retryAfter` is seconds, when the API tells us. */
  bench(key, retryAfter) {
    const ms = Math.min(120000, Math.max(5000, (Number(retryAfter) || 30) * 1000));
    this.cool.set(key, Date.now() + ms);
  }
  healthy() { const now = Date.now(); return this.keys.filter((k) => (this.cool.get(k) || 0) <= now).length; }
}

/* ─────────────────────────── ASR ─────────────────────────── */

async function transcribeGroq({ blob, pool, model, language, signal, proxy }) {
  if (proxy) {
    const fd = new FormData();
    fd.append("file", blob, "chunk.wav");
    fd.append("model", model || "whisper-large-v3");
    if (language && language !== "auto") fd.append("language", language);
    return shapeAsr(await proxyFetch(PROXY_ASR, { method: "POST", body: fd, signal }));
  }
  let lastErr = null;
  // One attempt per key: a 429 on this key just means try the next one.
  for (let attempt = 0; attempt < Math.max(1, pool.size); attempt++) {
    const key = pool.next();
    try {
      return await transcribeOnce({ blob, key, model, language, signal });
    } catch (e) {
      lastErr = e;
      if (e && e.status === 429) { pool.bench(key, e.retryAfter); continue; }
      throw e;
    }
  }
  const e = lastErr || new Error("all_keys_rate_limited");
  if (e.status === 429) e.exhausted = true;
  throw e;
}

async function transcribeOnce({ blob, key, model, language, signal }) {
  const fd = new FormData();
  fd.append("file", blob, "chunk.wav");
  fd.append("model", model || "whisper-large-v3-turbo");
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "word");
  fd.append("temperature", "0");
  if (language && language !== "auto") fd.append("language", language);

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`ASR ${res.status}: ${t.slice(0, 160)}`);
    err.status = res.status;
    err.retryAfter = res.headers.get("retry-after");
    throw err;
  }
  return shapeAsr(await res.json());
}

/** Groq's verbose_json -> the word list the stabiliser expects. */
function shapeAsr(data) {
  let words = [];
  if (Array.isArray(data.words) && data.words.length) {
    words = data.words.map((w) => ({ w: w.word, start: +w.start || 0, end: +w.end || 0 }));
  } else if (Array.isArray(data.segments)) {
    // Whisper sometimes omits word timings for CJK — fall back to segments.
    words = data.segments.map((s) => ({ w: String(s.text || "").trim(), start: +s.start || 0, end: +s.end || 0 }))
      .filter((s) => s.w);
  }
  return { words, text: String(data.text || "").trim(), language: data.language || "" };
}

/* ───────────────── correct + translate (one call) ───────────────── */

/**
 * Target languages the audience can be shown. `note` is fed to the model so it
 * gets register/variant right (Dari ≠ Iranian Farsi is the one that matters most).
 */
export const LANGS = {
  prs:       { label: "دری",      en: "Dari",      rtl: true,  note: "Dari (دری, Afghan Persian). Use Afghan vocabulary and idiom, NOT Iranian Farsi." },
  ps:        { label: "پښتو",     en: "Pashto",    rtl: true,  note: "Pashto." },
  fa:        { label: "فارسی",    en: "Farsi",     rtl: true,  note: "Iranian Persian (Farsi)." },
  ar:        { label: "العربية",  en: "Arabic",    rtl: true,  note: "Modern Standard Arabic." },
  ur:        { label: "اردو",     en: "Urdu",      rtl: true,  note: "Urdu." },
  en:        { label: "English",  en: "English",   rtl: false, note: "Natural English." },
  "zh-Hant": { label: "繁體中文",  en: "Chinese-T", rtl: false, note: "Traditional Chinese (繁體)." },
  "zh-Hans": { label: "简体中文",  en: "Chinese-S", rtl: false, note: "Simplified Chinese (简体)." },
  ko:        { label: "한국어",    en: "Korean",    rtl: false, note: "Korean." },
  ja:        { label: "日本語",    en: "Japanese",  rtl: false, note: "Japanese." },
  es:        { label: "Español",  en: "Spanish",   rtl: false, note: "Latin-American Spanish." },
  fr:        { label: "Français", en: "French",    rtl: false, note: "French." },
  id:        { label: "Indonesia",en: "Indonesian",rtl: false, note: "Bahasa Indonesia." },
  vi:        { label: "Tiếng Việt",en:"Vietnamese",rtl: false, note: "Vietnamese." },
  hi:        { label: "हिन्दी",     en: "Hindi",     rtl: false, note: "Hindi." },
  th:        { label: "ไทย",      en: "Thai",      rtl: false, note: "Thai." },
};

function buildSys(targets) {
  const list = targets.map((c) => `   - "${c}": ${(LANGS[c] || {}).note || c}`).join("\n");
  return `You are a professional live interpreter working in real time.
You receive raw speech-recognition output from a talk that may mix English and Chinese.

1. CORRECT the source: fix ASR errors ONLY (homophones, mis-heard proper nouns,
   missing punctuation, word-boundary mistakes). Use GLOSSARY as ground truth.
   NEVER add, remove, summarise or reorder content.

2. Translate the corrected text into each language below. Translate meaning, not
   word-for-word — natural and speakable, as a live interpreter would say it.
   Never leave words from another language untranslated inside a translation.
${list}

Reply with JSON only: {"corrected":"...","tr":{${targets.map((c) => `"${c}":"..."`).join(",")}}}`;
}

/**
 * Re-sending a long glossary on every sentence is the single biggest input-token
 * cost, and Groq's limit here is tokens-per-minute. So send only the entries
 * whose source term actually appears in this sentence (plus nothing if none do).
 */
function relevantGlossary(glossary, text) {
  if (!glossary) return "";
  const lines = glossary.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 8) return glossary;            // short list: just send it
  const low = text.toLowerCase();
  const hits = lines.filter((l) => {
    const term = l.split(/[=:｜|]/)[0].trim().toLowerCase();
    return term && low.includes(term);
  });
  return hits.join("\n");
}

function buildPrompt({ text, glossary, context, prior }) {
  const parts = [];
  if (context) parts.push(`SESSION CONTEXT:\n${context}`);
  const g = relevantGlossary(glossary, text);
  if (g) parts.push(`GLOSSARY (authoritative spellings / renderings):\n${g}`);
  if (prior) parts.push(`PRIOR CONTEXT (already delivered — for continuity only, do not re-translate):\n${prior}`);
  parts.push(`SOURCE TEXT (correct, then translate):\n${text}`);
  return parts.join("\n\n");
}

async function askGemini({ key, model, prompt, sys, signal }) {
  const res = await fetch(`${GEMINI_URL}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.15, responseMimeType: "application/json", maxOutputTokens: 4096,
        // Gemini 2.5 "thinking" silently eats the output budget and truncates the
        // JSON mid-string. For a live interpreter we want speed, not deliberation.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
}

async function askOpenAICompat({ key, base, model, prompt, sys, signal }) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    signal,
    body: JSON.stringify({
      model,
      temperature: 0.15,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = new Error(`${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    err.status = res.status; err.retryAfter = res.headers.get("retry-after");
    throw err;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/**
 * Provider table. Measured on real sermon audio (2026-07-02, 25 s window):
 *   groq  openai/gpt-oss-120b   2.4 s  clean Dari                ← primary
 *   groq  llama-3.3-70b         1.0 s  BROKEN — leaks Chinese into the Dari
 *   gemini-2.5-flash-lite       —      503 (transient "high demand")
 *   gemini-2.5-flash            —      429 (free tier ≈20/day)
 *   glm-5.2                    43.8 s  good quality, far too slow for live
 * Order = fast-and-good first, reliable-but-slow last.
 */
export const LLM_PROVIDERS = {
  proxy:  { label: "Hosted (no key needed)", kind: "proxy", model: "openai/gpt-oss-120b" },
  groq:   { label: "Groq · gpt-oss-120b", kind: "openai", base: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  // Same key, 70k TPM vs 8k — the escape hatch when a long service out-paces
  // gpt-oss-120b's token budget. Measured 3.2 s, Dari quality comparable.
  groqHi: { label: "Groq · compound-mini", kind: "openai", base: "https://api.groq.com/openai/v1", model: "groq/compound-mini" },
  gemini: { label: "Gemini Flash-Lite",   kind: "gemini", model: "gemini-2.5-flash-lite" },
  kimi:   { label: "Kimi (Moonshot)",     kind: "openai", base: "https://api.moonshot.ai/v1", model: "kimi-latest" },
  glm:    { label: "GLM 5.2",             kind: "openai", base: "https://api.z.ai/api/coding/paas/v4", model: "glm-5.2" },
};

/** Walk the chain until one provider answers. Returns {raw, via}. */
async function askChain(chain, prompt, sys) {
  const errors = [];
  for (const step of chain) {
    const def = LLM_PROVIDERS[step.id];
    if (!def || !(def.kind === "proxy" || step.key || (step.pool && step.pool.size))) continue;
    const tries = step.pool ? Math.max(1, step.pool.size) : 1;
    for (let a = 0; a < tries; a++) {
      const key = step.pool ? step.pool.next() : step.key;
      try {
        const raw = def.kind === "proxy"
          ? (await proxyFetch(PROXY_CHAT, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ sys, prompt, model: step.model || def.model }),
            })).content
          : def.kind === "gemini"
          ? await askGemini({ key, model: step.model || def.model, prompt, sys })
          : await askOpenAICompat({ key, base: step.base || def.base, model: step.model || def.model, prompt, sys });
        if (raw && raw.trim()) return { raw, via: step.id };
        errors.push(`${step.id}: empty`);
        break;
      } catch (e) {
        errors.push(`${step.id}: ${e.message}`);
        if (e && e.status === 429 && step.pool) { step.pool.bench(key, e.retryAfter); continue; }
        break;
      }
    }
  }
  throw new Error(errors.join(" · ") || "no_provider_configured");
}

function parseJson(raw) {
  const s = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/* ───────────────────────── engine ───────────────────────── */

export class LiveEngine {
  constructor(opts = {}) {
    this.cfg = {
      // large-v3 over turbo: measured on real sermon audio it fixed a homophone
      // (當日→當然), avoided a garbled run, and ADDS PUNCTUATION (which the
      // sentence splitter below depends on) for ~0.1 s more on a 25 s window.
      groqKey: "", groqKeys: [], proxy: false, deviceId: "", groqModel: "whisper-large-v3", language: "auto",
      llmChain: [],            // ordered [{id, key, model?, base?}]; groq steps get the pool
      targets: ["prs"],        // audience languages, first = primary
      interim: true,           // cheap provisional translation of the live tail
      glossary: "", context: "",
      ...opts,
    };
    this.on = { draft: () => {}, interim: () => {}, line: () => {}, status: () => {}, error: () => {}, level: () => {} };

    this.buf = [];             // Float32Array chunks, 16 kHz mono, uncommitted tail
    this.bufLen = 0;
    this.rate = 16000;
    this.agree = new Agreement();
    this.sentence = "";
    this.prior = [];           // last few delivered sentences, for continuity
    this.running = false;
    this.busy = false;
    this.lastVoiceAt = 0;
    this.seq = 0;
    this.translateQueue = Promise.resolve();
    this.pendingSince = 0;
    this._interimAt = 0; this._interimSrc = ""; this._interimBusy = false;
    this.archive = [];         // full-session PCM, for the post-event archive
  }

  events(map) { Object.assign(this.on, map); return this; }

  async start() {
    if (this.running) return;
    const groqKeys = (this.cfg.groqKeys && this.cfg.groqKeys.length) ? this.cfg.groqKeys : [this.cfg.groqKey];
    // Two pools over the same keys: Groq meters speech and chat separately, so a
    // chat 429 must not bench a key that still has audio budget (and vice versa).
    this.pool = new KeyPool(groqKeys);
    const chatPool = new KeyPool(groqKeys);
    for (const step of this.cfg.llmChain || []) {
      if ((step.id === "groq" || step.id === "groqHi") && !step.pool && chatPool.size) step.pool = chatPool;
    }
    if (!this.cfg.proxy && !this.pool.size) throw new Error("missing_asr_key");
    if (!this.cfg.llmChain || !this.cfg.llmChain.length) throw new Error("missing_llm_key");

    this.cap = new Capture((chunk, rate) => this._audio(chunk, rate));
    this.cap.deviceId = this.cfg.deviceId || "";
    this.rate = await this.cap.start();
    this.running = true;
    this.lastVoiceAt = Date.now();
    this.lastTickAt = Date.now();
    this.lastAudioAt = Date.now();
    this.stallWarned = false;
    // Background tabs throttle setInterval to about once a MINUTE, which would
    // silently stall a live session the moment the presenter checks a message.
    // The AudioWorklet keeps delivering while hidden, so audio is the reliable
    // clock; the interval stays only as a safety net and as the stall detector.
    this.timer = setInterval(() => {
      this._watchdog();
      this._maybeTick();
    }, TICK_MS);
    this.on.status({ running: true });
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.cap && this.cap.stop();
    this.on.status({ running: false });
  }

  _audio(chunk, rate) {
    if (!this.running) return;
    this.lastAudioAt = Date.now();
    if (this.stallWarned) {                 // recovered (e.g. mic reconnected)
      this.stallWarned = false;
      this.on.status({ running: true, stalled: false });
    }
    const pcm = resampleTo16k(chunk, rate);
    this.buf.push(pcm);
    this.bufLen += pcm.length;
    this.archive.push(pcm);

    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    this.on.level(Math.min(1, rms * 8));
    if (rms > SILENCE_RMS) this.lastVoiceAt = Date.now();
    this._maybeTick();
  }

  /** Fire a confirm pass when one is due, whatever woke us. */
  _maybeTick() {
    if (!this.running || this.busy) return;
    if (Date.now() - this.lastTickAt < TICK_MS) return;
    this.lastTickAt = Date.now();
    this._tick().catch((e) => this.on.error(e));
  }

  /**
   * Audio silently stopping is a real failure mode — a Bluetooth mic drops, or
   * the OS hands the device to another app. Without this the UI keeps saying
   * "Live" while nothing is being captured.
   */
  _watchdog() {
    if (!this.running || this.stallWarned) return;
    // A hidden page has its audio suspended by the OS on purpose — that's not a
    // broken microphone, and warning about it would cry wolf every time the
    // presenter glances at another app. Only judge a stall while visible.
    if (document.visibilityState !== "visible") { this.lastAudioAt = Date.now(); return; }
    if (Date.now() - this.lastAudioAt < 5000) return;
    this.stallWarned = true;
    this.on.status({ running: true, stalled: true });
    this.on.error(new Error("audio_stalled"));
  }

  /** Whole-buffer loudness — decides whether a window is worth transcribing. */
  _flat() {
    const out = new Float32Array(this.bufLen);
    let o = 0;
    for (const c of this.buf) { out.set(c, o); o += c.length; }
    return out;
  }

  _trim(seconds) {
    if (seconds <= 0) return;
    let drop = Math.floor(seconds * 16000);
    while (drop > 0 && this.buf.length) {
      const head = this.buf[0];
      if (head.length <= drop) { drop -= head.length; this.bufLen -= head.length; this.buf.shift(); }
      else { this.buf[0] = head.subarray(drop); this.bufLen -= drop; drop = 0; }
    }
  }

  async _tick() {
    if (!this.running || this.busy) return;
    this.lastTickAt = Date.now();
    const seconds = this.bufLen / 16000;
    if (seconds < MIN_WINDOW_S) return;

    // Groq meters speech recognition in requests PER DAY, so a pass over pure
    // silence is not just latency — it permanently spends budget. If the whole
    // buffer is below the voice floor and the stabiliser has nothing pending,
    // there is no text to recover: drop the silence and skip the call.
    const pcm = this._flat();
    if (!this.agree.pendingText() && rmsOf(pcm) < SILENCE_RMS) {
      this._trim(seconds - MIN_WINDOW_S / 2);
      this.skipped = (this.skipped || 0) + 1;
      return;
    }

    this.busy = true;
    try {
      const wav = encodeWav(pcm, 16000);
      this.asrCalls = (this.asrCalls || 0) + 1;
      const { words } = await transcribeGroq({
        blob: wav, pool: this.pool, proxy: this.cfg.proxy,
        model: this.cfg.groqModel, language: this.cfg.language,
      });

      const { stable, cut } = this.agree.push(words);
      if (stable.length) {
        this._trim(cut);
        this._commit(stable.map((w) => w.w).join(" "));
      } else if (seconds > MAX_WINDOW_S) {
        // Agreement never settled (music, crosstalk). Take the hypothesis as-is
        // rather than let the buffer grow forever.
        if (words.length) this._commit(words.map((w) => w.w).join(" "));
        this.buf = []; this.bufLen = 0; this.agree.reset();
      }

      // What the audience sees as "being said right now" = committed-but-unsent
      // text + the unstable tail. Cheap model, throttled, one line only.
      const tail = ((this.sentence || "") + " " + this.agree.pendingText()).replace(/\s+/g, " ").trim();
      this.on.draft(tail);
      this._interim(tail);

      const quiet = Date.now() - this.lastVoiceAt > SILENCE_FLUSH_MS;
      if (quiet && this.sentence.trim()) this._flushSentence();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Provisional translation of the live tail. Deliberately a small fast model:
   * it is replaced by the quality translation the moment the unit settles, so
   * paying 120b prices for text that is about to be thrown away is waste.
   */
  _interim(tail) {
    if (!this.cfg.interim) return;
    const now = Date.now();
    if (this._interimBusy) return;
    if (tail.length < INTERIM_MIN_CHARS) { if (!tail) this.on.interim(""); return; }
    if (now - this._interimAt < INTERIM_MIN_MS) return;
    if (Math.abs(tail.length - this._interimSrc.length) < INTERIM_MIN_DELTA && tail === this._interimSrc) return;

    const step = (this.cfg.llmChain || [])[0];
    if (!step) return;
    const viaProxy = step.id === "proxy";
    const ikey = step.pool ? step.pool.next() : step.key;
    if (!viaProxy && !ikey) return;
    this._interimBusy = true; this._interimAt = now; this._interimSrc = tail;
    const primary = this.cfg.targets[0];
    const sys = `Translate the fragment into ${(LANGS[primary] || {}).note || primary}
It is an INCOMPLETE live utterance — translate what is there, do not invent an ending.
Reply with JSON only: {"t":"..."}`;
    (viaProxy
      ? proxyFetch(PROXY_CHAT, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sys, prompt: tail, model: INTERIM_MODEL }),
        }).then((r) => r.content)
      : askOpenAICompat({ key: ikey, base: LLM_PROVIDERS.groq.base, model: INTERIM_MODEL, prompt: tail, sys }))
      .then((raw) => { const o = parseJson(raw) || {}; if (o.t) this.on.interim(String(o.t).trim()); })
      .catch(() => {})
      .finally(() => { this._interimBusy = false; });
  }

  _commit(text) {
    const t = String(text || "").replace(/\s+/g, " ").replace(/\s+([,.!?;:，。！？；：])/g, "$1").trim();
    if (!t) return;
    if (!this.sentence) this.pendingSince = Date.now();
    this.sentence = (this.sentence ? this.sentence + " " : "") + t;

    // Prefer a real sentence boundary; fall back to length so an unpunctuated
    // speaker still gets delivered in readable pieces.
    const m = this.sentence.match(/^([\s\S]*?[.!?。！？…]+["'”’)\]]?)\s*([\s\S]*)$/);
    if (m) { const done = m[1].trim(); this.sentence = m[2] || ""; if (done) this._send(done); return; }
    if (this.sentence.length >= MAX_SENTENCE_CHARS) this._flushSentence();
  }

  _flushSentence() {
    const s = this.sentence.trim();
    this.sentence = ""; this.pendingSince = 0;
    if (s) this._send(s);
  }

  _send(source) {
    this.on.interim(""); this._interimSrc = "";
    const id = ++this.seq;
    this.on.line({ id, src: source, tr: {}, pending: true, t: Date.now() });
    // Serial queue: translations land in the order they were spoken, and each
    // one can see the previous sentences as context.
    this.translateQueue = this.translateQueue.then(async () => {
      try {
        const prompt = buildPrompt({
          text: source,
          glossary: this.cfg.glossary,
          context: this.cfg.context,
          prior: this.prior.slice(-3).join("\n"),
        });
        const { raw, via } = await askChain(this.cfg.llmChain, prompt, buildSys(this.cfg.targets));
        const out = parseJson(raw) || {};
        const corrected = String(out.corrected || source).trim();
        this.prior.push(corrected);
        if (this.prior.length > 6) this.prior.shift();
        const tr = {};
        for (const c of this.cfg.targets) tr[c] = String((out.tr && out.tr[c]) || "").trim();
        this.on.line({ id, src: corrected, tr, pending: false, via, t: Date.now() });
      } catch (e) {
        this.on.error(e);
        // Never drop a line: show the uncorrected source rather than nothing.
        this.on.line({ id, src: source, tr: {}, pending: false, failed: true, t: Date.now() });
      }
    });
  }

  /** Finish the current sentence and wait for the queue to drain. */
  async drain() {
    this._flushSentence();
    await this.translateQueue;
  }

  /** How many keys are currently not benched — surfaced in the console. */
  keyHealth() {
    return {
      ok: this.pool ? this.pool.healthy() : 0,
      total: this.pool ? this.pool.size : 0,
      asrCalls: this.asrCalls || 0,
      skipped: this.skipped || 0,        // silent windows that cost nothing
    };
  }

  /** Full-session WAV, for pushing through the Mac pipeline afterwards. */
  archiveWav() {
    let len = 0;
    for (const c of this.archive) len += c.length;
    const all = new Float32Array(len);
    let o = 0;
    for (const c of this.archive) { all.set(c, o); o += c.length; }
    return encodeWav(all, 16000);
  }
}

export { encodeWav };
