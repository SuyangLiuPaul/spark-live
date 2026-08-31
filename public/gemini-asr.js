/* Gemini Live speech recognition — a streaming alternative to the windowed
   Whisper path in engine.js.

   WHY THIS EXISTS
   Measured on real Cantonese audio (2026-08-17, same 120 s window, same run):
     Whisper large-v3   「他是需要想的…投一投气」   flattened to Mandarin, nonsense
     transcribe-live    「佢係需要唞嘅…等佢唞唞氣」  verbatim Cantonese
   It also kept the Greek term Whisper dropped entirely (kakourgos), got 釘痕
   where Whisper wrote 丁痕, and stayed in Traditional throughout instead of
   mixing scripts. Different enough to be worth a second ASR backend.

   TWO WAYS TO CONNECT
   The Live API is a WebSocket the browser must hold, and a Netlify function
   cannot hold one. Google's answer is ephemeral tokens, and they are minted
   fine — but on 2026-08-17 the Live endpoint REJECTED every documented way of
   presenting one (?access_token=, ?key=, Authorization: Token, x-goog-api-key,
   on both v1alpha and v1beta) while the real key connected on the first try.
   So there are two supported shapes, and `relay` picks between them:

     relay set   → connect to the Cloudflare Worker in ../relay, which holds the
                   key server-side. The page needs NO key, which is what makes a
                   zero-setup site for the congregation possible.
     no relay    → connect straight to Google with the presenter's own key, the
                   app's existing own-key design. Works today, one device at a
                   time.

   Revisit the token path before assuming the relay is permanent.

   MODE IS VERBATIM, DELIBERATELY
   SMART mode formats better and fixes the spacing artifact below, but measured
   on the same audio it rewrote 「走向祂，走向祂的天父」 as 「走向她，走向她的
   天賦」 and silently deleted 38% of the content as "filler". For scripture that
   is not a trade worth making. */

const WS_BASE = "wss://generativelanguage.googleapis.com/ws/"
  + "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODEL = "models/gemini-3.5-transcribe-live";

/** SOURCE_LANGS ids → the BCP-47 tags the Live API expects. */
const BCP47 = {
  en: "en-US", zh: "cmn-Hans-CN", yue: "yue-Hant-HK", fa: "fa-IR",
  ar: "ar-EG", ur: "ur-PK", ko: "ko-KR", ja: "ja-JP", es: "es-ES",
  fr: "fr-FR", id: "id-ID", vi: "vi-VN", hi: "hi-IN", th: "th-TH",
};

const CHUNK_SAMPLES = 1600;          // 100 ms at 16 kHz
const MAX_VOCAB = 1000;              // API cap
// The socket dies at ~10 min and the audio session at ~15; a sermon is longer
// than both, so reconnection is normal operation, not error handling.
const RECONNECT_MS = 800;
const MAX_BACKOFF_MS = 8000;
// Consecutive failures with no session in between before giving up and letting
// the engine fall back to Whisper. With the backoff above this is roughly 25 s
// of dead transcript — long enough to ride out a WiFi blip, short enough that a
// sermon does not finish in silence. Reset by every setupComplete, so the
// ordinary ~12-minute reconnect never counts toward it.
const MAX_CONSECUTIVE_FAILS = 6;
// Audio captured while the socket is down. Replayed on reconnect — verified
// safe because feeding at 5x realtime produced byte-identical transcripts.
const GAP_MAX_SAMPLES = 16000 * 90;

/**
 * Collapse the per-character spacing the API emits on some finalized segments
 * ("站 在 這 裡 , 我 還 看 到 了"), which would otherwise reach the screen. Only
 * touches runs of single CJK characters separated by single spaces, so Latin
 * words and real spacing are left alone.
 */
export function tidy(text) {
  let s = String(text || "");
  s = s.replace(/(?:[㐀-鿿][ \t](?=[㐀-鿿]))+[㐀-鿿]/g,
                (m) => m.replace(/[ \t]/g, ""));
  // The same segments come back with half-width punctuation among CJK.
  s = s.replace(/([㐀-鿿])\s*,\s*(?=[㐀-鿿])/g, "$1，");
  s = s.replace(/([㐀-鿿])\s*\.\s*(?=[㐀-鿿]|$)/g, "$1。");
  return s.replace(/\s+/g, " ").trim();
}

function toPcm16Base64(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Glossary text → customVocabulary terms (the left side of `term = rendering`). */
export function vocabFrom(glossary) {
  return String(glossary || "")
    .split(/\r?\n/)
    .map((l) => l.split(/[=:｜|]/)[0].trim())
    .filter((t) => t && t.length <= 40)
    .slice(0, MAX_VOCAB);
}

export class GeminiLiveAsr {
  /**
   * @param {object} o
   * @param {string} o.relay     wss:// URL of the relay Worker. When set the
   *                             key is NOT needed and never leaves the server.
   * @param {string} o.key       presenter's own Gemini API key (relay-less mode)
   * @param {string} o.language  SOURCE_LANGS id ("yue"), "" / "auto" to detect
   * @param {string} o.glossary  becomes customVocabulary — the ASR is biased
   *                             toward these BEFORE mishearing them, unlike the
   *                             text glossary which only matches once correct
   * @param {(t:string)=>void} o.onInterim
   * @param {(t:string)=>void} o.onFinal
   * @param {(e:Error)=>void}  o.onError
   * @param {(s:object)=>void} o.onStatus
   */
  constructor(o = {}) {
    this.o = o;
    this.ws = null;
    this.handle = null;         // session resumption handle, survives reconnects
    this.closed = false;
    this.connected = false;
    this.gap = [];              // Float32Array chunks captured while down
    this.gapLen = 0;
    this.pending = new Float32Array(0);
    this.backoff = RECONNECT_MS;
    this.reconnects = 0;
    this.fails = 0;
    this.finals = 0;
  }

  start() {
    this.closed = false;
    this._open();
  }

  stop() {
    this.closed = true;
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch {}
    }
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
    this.connected = false;
  }

  _setup() {
    const lang = BCP47[this.o.language] || "";
    const vocab = vocabFrom(this.o.glossary);
    return {
      setup: {
        model: MODEL,
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: {
          // [] means auto-detect across 85+ languages. Naming the language is
          // what keeps Cantonese from being written as Mandarin.
          languageCodes: lang ? [lang] : [],
          customVocabulary: vocab,
          mode: "VERBATIM",
        },
        // Asking for handles is what makes a 40-minute service possible on a
        // socket that will not live 10.
        sessionResumption: this.handle ? { handle: this.handle } : {},
      },
    };
  }

  _open() {
    if (this.closed) return;
    let ws;
    try {
      // The relay URL is used verbatim — it may already carry ?code=, and the
      // key belongs on the far side of it, never here.
      ws = new WebSocket(this.o.relay
        ? this.o.relay
        : `${WS_BASE}?key=${encodeURIComponent(this.o.key)}`);
    } catch (e) {
      this._retry(e);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      try { ws.send(JSON.stringify(this._setup())); } catch (e) { this._retry(e); }
    };

    ws.onmessage = async (ev) => {
      // Gemini replies in BINARY frames, so this is never a plain string in
      // practice. Which flavour of binary depends on the socket's binaryType,
      // which differs between browsers and the relay hop — handle both rather
      // than discover the difference on a Sunday.
      let raw = ev.data;
      if (raw instanceof Blob) raw = await raw.text();
      else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
      // NOT `raw.buffer` — a view is a window onto a larger, possibly pooled
      // buffer, and decoding the whole thing yields garbage that JSON.parse
      // rejects silently. The offset and length are the whole point.
      else if (ArrayBuffer.isView(raw)) {
        raw = new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
      }
      let m;
      try { m = JSON.parse(raw); } catch { return; }

      if (m.setupComplete) {
        this.connected = true;
        this.backoff = RECONNECT_MS;
        this.fails = 0;
        this.o.onStatus && this.o.onStatus({ connected: true, resumed: !!this.handle });
        this._drainGap();
        return;
      }
      if (m.sessionResumptionUpdate) {
        // Keep the newest handle; it is what a reconnect rejoins with.
        const h = m.sessionResumptionUpdate.newHandle;
        if (h) this.handle = h;
        return;
      }
      if (m.goAway) {
        // The server is about to hang up. Reconnect BEFORE it does so the gap
        // is a few hundred ms instead of a dropped sentence.
        this._cycle();
        return;
      }
      const sc = m.serverContent;
      if (!sc) return;
      if (sc.interimInputTranscription && sc.interimInputTranscription.text != null) {
        this.o.onInterim && this.o.onInterim(tidy(sc.interimInputTranscription.text));
      }
      if (sc.inputTranscription && sc.inputTranscription.text) {
        const t = tidy(sc.inputTranscription.text);
        if (t) { this.finals++; this.o.onFinal && this.o.onFinal(t); }
      }
    };

    ws.onerror = () => { /* close always follows; handled there */ };
    ws.onclose = (e) => {
      this.connected = false;
      if (this.closed) return;
      // 1000 here is the server ending a session that has run its course, which
      // for a sermon means "carry on", not "stop".
      this._retry(new Error(`asr_socket_closed_${e.code}`), e.code);
    };
  }

  /** Deliberate reconnect (GoAway) — no backoff, we were told in advance. */
  _cycle() {
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
    this.connected = false;
    if (!this.closed) setTimeout(() => this._open(), 50);
  }

  _retry(err, code) {
    this.reconnects++;
    this.fails++;
    // A key problem will not fix itself by reconnecting, and retrying forever
    // would hide it behind a silent stream of failures.
    if (code === 1007 || code === 1008) {
      this.o.onError && this.o.onError(new Error("asr_auth_rejected"));
      this.closed = true;
      return;
    }
    // Neither will anything else that keeps failing. Only 1007/1008 used to end
    // this loop, so ANY other persistent fault — a spent balance (which arrives
    // as a quota error, not an auth one, and through the relay as a plain 1011),
    // a dead relay, a blocked origin — reconnected forever while the presenter
    // watched "reconnecting…" and no transcript. Whisper was available the whole
    // time. Measured before this guard: 8 reconnects in 40 s, never gave up.
    if (this.fails >= MAX_CONSECUTIVE_FAILS) {
      this.o.onError && this.o.onError(new Error(`asr_unreachable_${code || "?"}`));
      this.closed = true;
      return;
    }
    this.o.onStatus && this.o.onStatus({ connected: false, reconnecting: true });
    const wait = this.backoff;
    this.backoff = Math.min(MAX_BACKOFF_MS, Math.round(this.backoff * 1.8));
    setTimeout(() => this._open(), wait);
  }

  /** Feed 16 kHz mono Float32. Buffered into 100 ms frames the API expects. */
  push(f32) {
    if (this.closed) return;
    if (!this.connected) { this._hold(f32); return; }
    const merged = new Float32Array(this.pending.length + f32.length);
    merged.set(this.pending, 0);
    merged.set(f32, this.pending.length);
    let off = 0;
    while (merged.length - off >= CHUNK_SAMPLES) {
      this._send(merged.subarray(off, off + CHUNK_SAMPLES));
      off += CHUNK_SAMPLES;
    }
    this.pending = merged.slice(off);
  }

  _hold(f32) {
    this.gap.push(f32);
    this.gapLen += f32.length;
    // Bounded: a socket that has been down 90 s is a real outage, and replaying
    // more than that would flood the new session with stale audio.
    while (this.gapLen > GAP_MAX_SAMPLES) this.gapLen -= this.gap.shift().length;
  }

  _drainGap() {
    if (!this.gap.length) return;
    const held = this.gap; this.gap = []; this.gapLen = 0;
    // Replayed as fast as the socket takes it. Verified equivalent: the same
    // audio at 5x realtime produced a byte-identical transcript.
    for (const c of held) this.push(c);
  }

  _send(frame) {
    if (!this.ws || this.ws.readyState !== 1) { this._hold(frame.slice()); return; }
    try {
      this.ws.send(JSON.stringify({
        realtimeInput: {
          audio: { data: toPcm16Base64(frame), mimeType: "audio/pcm;rate=16000" },
        },
      }));
    } catch {
      this._hold(frame.slice());
    }
  }

  stats() {
    return { finals: this.finals, reconnects: this.reconnects,
             connected: this.connected, resumable: !!this.handle };
  }
}
