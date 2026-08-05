# Spark Live — HANDOFF

Live transcription + **Dari (دری)** translation shown to an audience on their own
phones. Separate from the main Spark Transcribe app (which is batch: upload →
local Whisper → PDF). Deployed **standalone** so it can never disturb production.

- Dev site: **<your-netlify-site>** — site id the supplied key
- Presenter console: `/`   ·   Audience: `/join/<CODE>` (or `/view.html?s=<CODE>`)
- Deploy: `cd live && netlify deploy --prod --dir=public --functions=netlify/functions --site=<site-id>…`

## Why it's built this way

Live transcription trades accuracy against latency. The fix is **rolling
refinement** — show fast text, then visibly upgrade it:

1. **Capture** — raw 16 kHz PCM via AudioWorklet. *Not* MediaRecorder: we need to
   slice arbitrary overlapping windows, and webm/opus chunks after the first have
   no headers and cannot be decoded on their own.
2. **Stabilise (LocalAgreement)** — every ~3.5 s the whole *uncommitted tail* is
   re-transcribed. Consecutive passes overlap, so only the leading words where two
   independent passes **agree** are committed; the rest stay provisional. Word
   timestamps then tell us exactly how much audio to trim. This is the
   "self-correction" — principled, not guesswork.
3. **Correct + translate in ONE call** — whole sentences only (never fragments).
   The LLM fixes ASR errors against the glossary *and* translates, so errors don't
   compound the way they do when you translate raw ASR output.

## Accuracy levers, in order of impact
1. **Glossary** — names, places, scripture books, 雅偉, jargon + their Dari forms.
   Worth more than a bigger model. Injected into every call.
2. Pin the source language when the session is monolingual (auto-detect flips on
   short windows).
3. Session context ("sermon on Romans 8, speaker …").
4. Rolling prior-sentence context keeps pronouns/terminology consistent.

## Pieces
| File | Role |
|---|---|
| `public/engine.js` | capture · LocalAgreement · ASR · correct+translate |
| `public/channel.js` | **the only networking** — swap this one file for Supabase/Ably |
| `public/presenter.js` / `index.html` | operator console, session code, QR, glossary |
| `public/viewer.js` / `view.html` | audience: big RTL Dari + small source |
| `netlify/functions/publish.mjs` | presenter → Netlify Blobs (token-claimed session) |
| `netlify/functions/feed.mjs` | audience ← doc; `204` when unchanged |

## Cost / scale
- ASR: Groq `whisper-large-v3` — roughly **US$0.11/hour** of audio (turbo is
  ~$0.04 but measurably worse; see the benchmark below).
- LLM: Groq `openai/gpt-oss-120b`, one call per sentence ≈ **US$0.2/hour**.
- **All-in ≈ US$0.30 per hour of live translated speech, on a single Groq key.**
- Audience: `netlify.toml` puts `s-maxage=1` on `/api/feed`, so the **CDN collapses
  every viewer's 1 s poll into ~1 function invocation per second** regardless of
  how many people are watching. This is what keeps a full room on the free tier.

## Measured on real sermon audio (2026-07-02, `sermon.wav`, 3×25 s windows)

**ASR — use `whisper-large-v3`, not turbo.** Same latency class, clearly better:

| window | turbo | large-v3 |
|---|---|---|
| t=360s | 當**日**好像說 ❌ | 當**然**好像說 ✅ |
| t=1500s | 很熟**血氣** (garbled) ❌ | 很熟**悉** ✅ |
| punctuation | none | adds ，。 ✅ |
| latency | 0.66–0.78 s | 0.73–0.88 s |

large-v3's punctuation matters twice over: the sentence splitter uses it to decide
translation units.

**LLM — `openai/gpt-oss-120b` on Groq.**

| provider | latency | verdict |
|---|---|---|
| groq `openai/gpt-oss-120b` | **2.4 s** | clean Dari — **primary** |
| groq `llama-3.3-70b` | 1.0 s | ❌ leaks Chinese *into* the Dari |
| groq `qwen/qwen3.6-27b` | 4.3 s | ❌ fails JSON validation |
| `gemini-2.5-flash-lite` | — | 503 (transient "high demand") |
| `gemini-2.5-flash` | — | 429 (free tier ≈20/day) |
| `glm-5.2` | 43.8 s | good quality, far too slow for live |

End-to-end: **75 s of audio → ASR + 3-language translation in 9.7 s** (~7.7× realtime).

**Why not OpenAI:** `whisper-1` is the older large-v2 at ~3× Groq's price;
`gpt-4o-transcribe` returns **no word timestamps**, which breaks LocalAgreement
(it needs them to know how much audio to trim).

## Latency architecture (why it should beat MS Translator)

MS Translator re-translates a *growing partial* every tick → constant flicker, and
no glossary. Waiting for whole sentences (our v1) → accurate but feels slow.
We do neither. **Two zones with different update policies:**

- **Settled lines** — translated exactly ONCE by the quality model, then never
  touched. Cost is linear in words spoken, not quadratic. Nothing the audience has
  already read ever moves.
- **Live tail (one line, amber)** — the in-progress utterance. Raw ASR source
  updates every ~2.2 s (free), plus a *provisional* translation from
  `llama-3.1-8b-instant` (cheap/fast), throttled to ≥2.5 s and only when the text
  actually changed. Replaced by the quality translation when the unit settles.

Unit boundaries: sentence-final punctuation → emit. Clause punctuation → emit only
once the clause is ≥26 chars (Dari/Persian word order translates fragments badly).
Otherwise force-emit after 6 s so committed text is never held hostage.

## Rate limits — the real live-service constraint

Groq (measured via response headers, 2026-07-02):

| model | TPM | note |
|---|---|---|
| `openai/gpt-oss-120b` | **8,000** | best quality, 2.4 s — *will* throttle on a long service |
| `groq/compound-mini` | **70,000** | 3.2 s, comparable Dari — the escape hatch |
| `llama-3.3-70b` | 12,000 | ❌ leaks Chinese into the Dari |
| `llama-3.1-8b-instant` | 6,000 | used only for the cheap interim tail |
| `whisper-large-v3` | 7,200 **audio-sec/hr** | we re-transcribe overlaps → watch the multiplier |

Consequences baked into the design: chain is `gpt-oss-120b → compound-mini →
gemini → glm`; **each extra target language multiplies output tokens**, so the
picker warns at 3; and the glossary is filtered per-sentence (`relevantGlossary`)
because re-sending a long glossary every call was the biggest input-token cost.

## Gotchas (each cost a real debugging cycle)
- **`/join/:code` is a 200 rewrite, not a redirect.** The browser URL keeps the
  path and carries **no query string** → assets must use **absolute** paths
  (`/styles.css`), and `viewer.js` reads the code from the **path** as well as `?s=`.
- **A `204` response must have a `null` body.** `new Response("", {status:204})`
  makes the Netlify runtime emit a **502**.
- **Gemini 2.5 "thinking" silently truncates the JSON.** It consumes the output
  budget, so the reply ends mid-string. Set `thinkingConfig:{thinkingBudget:0}`.
- **Groq blocks Python's default User-Agent** with Cloudflare `403 code 1010` on
  `/chat/completions` (curl and browsers are fine). Only bites local test scripts.
- Keys are **BYOK, browser-local** (`localStorage`), never sent to the relay.
- **The Kimi/Moonshot key on file returned 401** from both `api.moonshot.ai` and
  `api.moonshot.cn` on 2026-07-02 (also not OpenRouter / SiliconFlow). Stored in
  `~/.config/spark-transcribe/spark.env` as `KIMI_API_KEY` and wired into the
  provider chain, but **unverified** — the chain simply skips it until a key works.
- The publish token claims a session code; a second publisher with a different
  token gets `409`. The token is stripped before anything reaches viewers.

## Not done yet
- Draft/interim tier (Web Speech API) for sub-second text — currently the first
  text a viewer sees is the ~3.5 s confirmed pass.
- Auto-handoff of the session WAV into the Mac pipeline for the archive PDF
  (today: "下載整場錄音" then upload it to Spark Transcribe manually).
- Viewer-selectable display mode (currently Dari-primary with source beneath).
