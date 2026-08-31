# Spark Live ASR relay

A ~120-line Cloudflare Worker that holds the Gemini Live WebSocket so the
church site needs **no setup on any device**. The browser opens a plain
`wss://…/asr`; the Worker attaches the key and forwards frames both ways.

## Why a relay at all

Gemini Live is a WebSocket the browser has to hold open, and Netlify cannot
hold one — Edge Functions are HTTP-only and Functions are Lambda. Google's own
answer is ephemeral tokens, and on **2026-08-17** they minted fine but the Live
endpoint rejected every documented way of presenting one:

| presented as | result |
| --- | --- |
| `?access_token=<token>` | 1008 unregistered callers |
| `?access_token=<bare id>` | 1008 |
| `?key=<token>` | 1007 API key not valid |
| `Authorization: Token <token>` | 1008 |
| `x-goog-api-key: <token>` | 1007 |

…on both `v1alpha` and `v1beta`, while the real key connected first try. So the
key has to live somewhere that can hold a socket. Re-test the token path before
assuming this Worker is permanent — the minting call is a plain
`POST /v1beta/auth_tokens` with a `bidiGenerateContentSetup` body, and if Google
starts accepting the result on the Live socket, the relay can be retired.

## Deploy

Requires a Cloudflare account (free plan is enough).

```bash
cd relay
npx wrangler login
npx wrangler secret put GEMINI_API_KEY     # prompts; the value never touches your shell history
npx wrangler deploy
```

Run these **one at a time** — pasting two interactive commands together lets the
second line be swallowed by the first one's prompt.

`wrangler deploy` prints the URL. Put it in `config.hosted.js`, **with the
`/asr` path**, and redeploy the site:

```js
asrRelay: "wss://spark-live-asr.<your-subdomain>.workers.dev/asr",
```

Then `./deploy.sh dev` (and `prod` once you're happy).

That URL is **not** a credential — the key stays in the Worker's secret store,
which is the entire point. Shipping it in `config.js` is fine.

## Who is allowed in

`ALLOWED_ORIGINS` in `wrangler.toml` — the sites permitted to open a socket.
Not secret, so it is committed rather than stored as a secret.

A shared access code was tried first and **removed**: it would have had to ride
in the relay URL inside the public `config.js`, where every visitor could read
it. It protected nothing while looking like it did. Origin is the real control:
a browser sets it and a page cannot forge it, so no other site can spend this
key. A non-browser client can forge the header — this is a quota guard, not an
authentication system, and it is not load-bearing (see Failure behaviour).

## Check it

```bash
curl https://spark-live-asr.<your-subdomain>.workers.dev/health
```

```json
{ "ok": true, "keyConfigured": true, "keyLen": 39, "originsAllowed": 2,
  "sessionsSeenByThisIsolate": 0, "peakFramesSeenByThisIsolate": 0, "lastClose": "" }
```

`keyLen` is the length of the stored secret and nothing else — no part of the
value. A Google key is **39** characters; anything else means the secret was
pasted wrong, which the endpoint only ever reports as a flat "API key not
valid". That one number turned an hour of guessing into a re-paste.

**The `…SeenByThisIsolate` counters are a lower bound, not truth.** They live in
module scope, which is per-isolate, and Cloudflare will happily answer /health
from a different isolate than the one holding a socket — a session that had just
finished read back as `0`. For the real number, watch the log:

```bash
npx wrangler tail --format pretty
#   session end: code=1000 frames=24107 reason=client closed
```

## The one number to watch: frames per session

The free plan allows **10 ms of CPU per request**, and Cloudflare's docs do not
say whether that is charged per message or cumulatively across a connection's
whole life. Audio is sent about **10 frames a second** — measured: 1202 frames
for 120 s — so a 40-minute sermon is roughly **24,000 frames**.

- Sessions surviving to ~24,000 frames → the limit is per-message. Fine as is.
- Sessions dying at a consistent frame count well below that → it is cumulative,
  and this host is wrong for the job.

### Answered, 2026-08-31: per-message. The relay is fine.

25.4 minutes of real Cantonese audio was fed through the deployed relay, and
the SAME audio at the SAME rate straight to Google as a control. If Cloudflare
were metering CPU cumulatively, only the relay run would have been cut short.

| | through the relay | direct to Google |
| --- | --- | --- |
| first reconnect | 142 s | 164 s |
| second reconnect | 287 s | 312 s |
| gap between them | 145 s | 148 s |
| reconnects | 2 | 2 |
| finalized segments | 36 | 34 |
| characters | 2498 | 2541 |

The two runs are the same run. The ~12-minute cut is **Gemini's own audio
session limit**, which the client already treats as normal operation — not a
Cloudflare limit, and not something the relay causes. A session reaches roughly
7,200 frames before Gemini ends it, well inside whatever the CPU budget is.

Note this is why a control was necessary at all: fed at a constant rate, "the
model ends the session" and "the host killed us on CPU" produce the identical
symptom of a disconnect at a fixed interval. The relay run alone could not tell
them apart.


If it turns out cumulative, **move the relay, not the app**: Deno Deploy, Fly
and Railway all hold sockets and bill wall-clock. `worker.js` is a plain
frame-forwarder and ports in minutes; the client only needs a new `asrRelay`
URL. Nothing else in Spark Live changes.

Frames are forwarded verbatim — never parsed or re-encoded — precisely so the
CPU budget is spent on nothing but the copy.

## Failure behaviour

The relay is not load-bearing. If it is unreachable or refuses the socket, the
client retries with backoff and then falls back to Whisper, which needs no key
and no relay. A broken relay degrades the transcript; it does not end the
service.
