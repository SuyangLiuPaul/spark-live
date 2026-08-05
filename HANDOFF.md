# Spark Live — HANDOFF

## Environments
- **Production** — a Netlify site, deployed from a staged copy that **excludes**
  `public/config.js` and substitutes `window.SPARK_LIVE_CONFIG = { proxy: true }`,
  so no API key is ever served publicly. Keys live in a Netlify env var and are
  added server-side by the proxies — the site works with no presenter setup.
  (Serving nothing at all is worse than the stub: `/config.js` then falls through
  to the SPA rewrite and hands `index.html` to a `<script>` tag.)
- **Dev** — separate Netlify site, deployed WITH `config.js` pre-filled for testing.
  That URL is effectively key-bearing: treat it as private and rotate if shared.
- **Site IDs are pinned in `.netlify/state.json` (gitignored).** Deploying with
  neither that file nor `--site` makes Netlify create a *brand-new public site* —
  which, from `--dir=public`, publishes your keys. Always pass `--site`.
- **Public repo** — `SuyangLiuPaul/spark-live` (MIT). Audited by cloning the pushed
  tree: 0 key patterns, 0 tokens, `config.js` untracked, 0 deployment URLs in docs,
  and 0 secret matches across the whole git history.

### Hosted mode (prod): keys server-side
`GROQ_KEY_POOL` is a Netlify **env var on the prod site**, read only by
`netlify/functions/keys.mjs`. Prod ships `config.js` = `{ proxy: true }`, which
routes the client to `/api/asr` + `/api/chat` instead of Groq. Verified: 0 key
patterns reachable from the browser, and the endpoints answer with no client key.

Rotation server-side differs from the client's: a function invocation is
stateless, so there is no counter to advance — `keys.mjs` shuffles the pool per
request (Fisher-Yates) and fails over within the invocation on 429/5xx.

Both proxies whitelist the model, so a stray caller can't spend the pool on
something expensive. `SPARK_ACCESS_CODE` (unset = open) gates them if needed.

**Setting the env var: use the API, not the CLI.** `netlify env:set --site=<id>`
resolved the project from the *working directory's* `.netlify/state.json` and
wrote to the dev site despite the explicit flag. `POST /api/v1/accounts/<slug>/env?site_id=<id>`
is unambiguous. Omit `scopes` — specifying it 403s on this plan.

### Deploy prod (never `--dir=public` directly — that ships config.js)
```bash
python3 -c "import shutil,tempfile,os;d=tempfile.mkdtemp();\
shutil.copytree('public',d,dirs_exist_ok=True,ignore=shutil.ignore_patterns('config.js'));print(d)"
netlify deploy --prod --dir=<that dir> --functions=netlify/functions --site=<prod-site-id>
```

Live transcription + **Dari (دری)** translation shown to an audience on their own
phones. Separate from the main Spark Transcribe app (which is batch: upload →
local Whisper → PDF). Deployed **standalone** so it can never disturb production.

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

Groq, measured from response headers (re-measured 2026-08-05). **Per key**, and
note the units differ — the daily request caps, not TPM, are what actually ends a
long service:

| model | TPM | requests/day | note |
|---|---|---|---|
| `openai/gpt-oss-120b` | **8,000** | **1,000** | best quality, 2.4 s — the workhorse |
| `groq/compound-mini` | 70,000 | **250** | high TPM but a tiny daily cap — emergency valve, not a bulk fallback |
| `llama-3.3-70b` | 12,000 | — | ❌ leaks Chinese into the Dari |
| `llama-3.1-8b-instant` | 6,000 | 14,400 | the cheap interim tail; plentiful |
| `whisper-large-v3` | — | **2,000** | the binding constraint (see below) |

The daily caps are a token bucket, which is why the reset header looks odd:
`2,000 requests` refilling one per `43.2 s` is exactly `86400/2000`, i.e. 24 h.

**Speech recognition is the tightest bucket.** One request per `TICK_MS` (2.2 s)
means a 3-hour service wants ≈4,900 requests against 2,000 per key — so a single
key cannot finish a long service and multiple keys are not optional.

Consequences baked into the design:
- **`KeyPool` (engine.js)** — N Groq keys **round-robin**, so each stays under its
  own budget, rather than use-until-throttled which just walks one key into a 429.
  A key that does 429 is benched (honouring `retry-after`, 5–120 s) and skipped.
  ASR and chat get **separate pool instances over the same keys**, because Groq
  meters them separately and a chat 429 must not bench audio budget.
- **Silent windows are never sent.** `_tick` measures buffer RMS and, if the whole
  window is below the voice floor with nothing pending in the stabiliser, drops it
  without an API call. Requests are a *daily* resource, so transcribing silence is
  permanent waste. `keyHealth()` reports `asrCalls` vs `skipped`.
- Chain is `gpt-oss-120b → gemini → kimi → glm`; **each extra target language
  multiplies output tokens**, so the picker warns at 3; and the glossary is
  filtered per-sentence (`relevantGlossary`) because re-sending a long glossary
  every call was the biggest input-token cost.

### Budget for a 3-hour service (6 keys)

| bucket | needed | 6-key budget | headroom |
|---|---|---|---|
| ASR requests | ~4,900 (fewer with silence-skip) | 12,000/day | ~2.4× |
| `gpt-oss-120b` requests | ~1,400–2,200 | 6,000/day | ~3× |
| chat TPM | ~10–13k | 48,000 | ~4× |
| interim requests | ~4,300 | 86,400/day | ample |

These are **daily** buckets and do not reset between services.

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
