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
 *
 * Steps 1–2 have a second implementation: `asr: "gemini"` streams to Gemini
 * Live instead, which finalizes segments server-side and so needs neither the
 * tick nor LocalAgreement. Step 3 onwards is shared — the Gemini path hands
 * finalized text to the same _commit(), so sentence assembly, translation,
 * relay publishing and the archive are identical either way. It requires the
 * presenter's own key (see gemini-asr.js for why hosted mode cannot use it).
 */

import { GeminiLiveAsr } from "./gemini-asr.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const TICK_MS = 2200;        // confirm pass cadence — tighter = text lands sooner
const MIN_WINDOW_S = 1.2;
const MAX_WINDOW_S = 28;
/**
 * Voice/silence detection.
 *
 * This used to be one absolute threshold (0.012) compared against the mean RMS
 * of the whole window, and that combination can kill a service outright: mic
 * gain varies more than twentyfold between a headset and a phone on a lectern,
 * and averaging a window that includes the pauses between words pulls the
 * figure well under the level of the speech inside it. A presenter whose input
 * landed under the line got a session that showed "Live", moved the meter, and
 * never made a single transcription request — no text, and no error either,
 * because no call was ever attempted.
 *
 * So the floor is now learned from the room instead of assumed, and the gate
 * fails OPEN: when it is not sure, it transcribes. A needless call costs one
 * request out of ~16,000; a needless skip costs the whole event.
 */
const SILENCE_ABS = 0.0015;    // below this is true digital near-silence
const SILENCE_MARGIN = 2.2;    // speech must clear the learned floor by this much
const FLOOR_MIN_OBS = 8;       // observations before the learned floor is trusted
const FORCE_PROBE_MS = 30000;  // never skip for longer than this while audio arrives

/**
 * The level-independent half of the decision, and the one that actually carries
 * it. Speech is bursty — loud syllables separated by gaps — while room tone is
 * flat, so the ratio between a window's loud frames and its quiet frames tells
 * the two apart without knowing anything about the microphone's gain. Measured
 * across the same sentence attenuated from 0.16 down to 0.003 RMS (a fiftyfold
 * span, far wider than the difference between a headset and a phone on a
 * lectern) it stayed at 9.6–9.8; an empty room reads 1.1. Anything above 3
 * is speech, and no absolute level threshold can make that call.
 */
const DYN_FRAME = 480;         // 30 ms at 16 kHz
const DYN_SPEECH = 3.0;

// Ceiling for the raw-PCM archive fallback: 45 min at 16 kHz Float32 ≈ 173 MB.
// Only reached on a browser with no MediaRecorder at all.
const PCM_ARCHIVE_MAX = 45 * 60 * 16000;

// How long to sit out after every key reports its daily cap spent.
const EXHAUSTED_BACKOFF_MS = 60000;
const SILENCE_FLUSH_MS = 700; // a pause this long ends a unit
const MAX_SENTENCE_CHARS = 150;
const MAX_UNIT_WAIT_MS = 6000;// never sit on committed text longer than this
// A sentence may be taken out of an INTERIM once the server has moved past it.
// Measured against the relay on 2026-09-13: "Good morning everyone." was complete
// in the interim at 3.0 s and the final for that utterance did not arrive until
// 8.7 s. Waiting for the final is what put a whole paragraph on the room's screen
// at once when the speaker never paused. Trailing text is the server's own proof
// that it has committed to the sentence.
const wordsOf = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);
// normWord lives with the stabiliser below; both users want the same thing —
// a word stripped of exactly the case and punctuation the ASR keeps changing.

const HARVEST_TAIL_CHARS = 3;
// Streaming ASR: how long the server may stay silent WHILE SPEECH IS ARRIVING
// before the socket is cycled. Interims normally come several times a second
// during speech, so 20 s of nothing is a dead session, not a pause.
const GEMINI_STALL_MS = 20000;

/**
 * Two thresholds, because the two audiences are different. The presenter wants
 * to know the moment the room stops being captured, so 5 s of nothing puts a
 * warning on their screen. We only want an email if it did NOT come back —
 * a phone whose screen slept and woke, or a context the OS suspended for a
 * second, heals itself and is not worth waking anyone up for.
 */
const MIC_WARN_MS = 5000;
const MIC_REPORT_MS = 20000;
// One attempt is not enough: a phone call owns the microphone for as long as it
// lasts, and the input only becomes takeable again when it ends. So keep asking.
const MIC_RETRY_MS = 10000;
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

/**
 * Container for the session archive, in the browser's order of preference.
 *
 * Both are already accepted by the Mac batch pipeline (server/worker.py), which
 * is the archive's only consumer, so the presenter's "record now, run it
 * through Spark Transcribe afterwards" workflow is unaffected by which one a
 * given browser picks. iOS Safari has no WebM at all and only ever produces
 * the second.
 */
const ARCHIVE_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];
const ARCHIVE_BPS = 32000;   // Opus at 32 kbps is transparent enough for speech

class Capture {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.ctx = null;
    this.node = null;
    this.src = null;
    this.stream = null;
    this.rec = null;          // MediaRecorder, when the browser has one
    this.recChunks = [];
    this.recType = "";
  }

  /**
   * Record the session for the archive.
   *
   * This used to be done by keeping every raw PCM chunk the worklet produced —
   * Float32 at 16 kHz, so 64 KB per second, retained for the whole service and
   * then copied twice more to build the WAV. A three-hour sermon held 659 MB
   * and peaked near 1.6 GB on download, which is several times what an iOS tab
   * is allowed before the OS kills it; the session would die mid-sermon and
   * take the audience's transcript with it on reload.
   *
   * MediaRecorder does the same job at about 4 KB/s (~43 MB for three hours)
   * and lets the browser own the buffering. The live pipeline still runs off
   * the worklet — this is a second, independent consumer of the same stream.
   */
  _startRecorder() {
    if (typeof MediaRecorder === "undefined") return;
    const type = ARCHIVE_TYPES.find((t) => {
      try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
    });
    if (!type) return;
    try {
      this.rec = new MediaRecorder(this.stream, { mimeType: type, audioBitsPerSecond: ARCHIVE_BPS });
      this.recType = type;
      this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.recChunks.push(e.data); };
      // stop() delivers its final slice asynchronously, so reading the chunks
      // straight after stopping loses the last segment — the end of the sermon.
      // Callers await this instead.
      this.recDone = new Promise((resolve) => {
        this.rec.onstop = resolve;
        this.rec.onerror = resolve;
      });
      // A timeslice means the blob is delivered in pieces as we go, so nothing
      // is lost if the session ends abruptly and no single allocation is huge.
      this.rec.start(15000);
    } catch {
      this.rec = null;        // fall back to the capped PCM archive
    }
  }

  /** Stop recording and wait for the final slice to land. Safe to call twice. */
  async flushArchive() {
    if (!this.rec) return;
    if (this.rec.state !== "inactive") {
      try { this.rec.stop(); } catch { return; }
    }
    await this.recDone;
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
    this._audioConstraints = audio;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this._watchTrack();
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
    this._startRecorder();
    return this.ctx.sampleRate;
  }

  /** The recorded session, or null when this browser had no MediaRecorder. */
  archive() {
    if (!this.recChunks.length || !this.recType) return null;
    // Strip the codec parameter: a Blob type of "audio/webm;codecs=opus" makes
    // some upload endpoints reject the file on a MIME allow-list.
    return new Blob(this.recChunks, { type: this.recType.split(";")[0] });
  }

  /**
   * Watch the TRACK, because the audio graph will lie to you.
   *
   * Measured in Chrome on 2026-09-06: when a track ends, the
   * MediaStreamAudioSourceNode feeding the worklet does NOT stop. It keeps
   * being pulled at exactly the same rate and emits digital silence (12
   * callbacks in the 2.5 s after `stop()`, RMS 0.0000). A muted track behaves
   * the same way. So "no audio is arriving" — the question the stall watchdog
   * was built to ask — can never become true for an input that goes away; it
   * only becomes true when the AudioContext itself is suspended, which is
   * mostly just the page being in the background.
   *
   * The track's own state is the honest signal, and it is the only one: the
   * samples look exactly like a quiet room, and a quiet room is something a
   * church service does regularly.
   */
  _watchTrack() {
    const track = this.stream && this.stream.getAudioTracks
      ? this.stream.getAudioTracks()[0] : null;
    if (!track) return;
    this.inputMuted = !!track.muted;
    this.inputEnded = track.readyState !== "live";
    track.onmute = () => { this.inputMuted = true; };
    track.onunmute = () => { this.inputMuted = false; };
    track.onended = () => { this.inputEnded = true; };
    // Remember which input we are actually on, not which one was asked for.
    // A presenter who never opened the picker still has a real device, and
    // that is the one a retake has to aim at.
    try { this._activeDeviceId = track.getSettings?.().deviceId || this._activeDeviceId; } catch {}
  }

  /**
   * Try to get the room back after audio stopped arriving.
   *
   * Two different faults look identical from outside — no chunks — and they
   * need opposite responses. A SUSPENDED context still owns a live microphone
   * and only needs resuming; an ENDED track is gone for good (a phone call took
   * the mic, a Bluetooth headset switched profile, the OS handed the input to
   * another app) and no amount of resuming will bring it back, only asking for
   * it again will. Before this, the only recovery was a human noticing the
   * warning and restarting the session — mid-sermon, from the lectern.
   *
   * Returns true when the input is plausibly alive again. A CLOSED context is
   * not recoverable here: a fresh AudioContext needs a user gesture, which is
   * what the Resume button is for.
   */
  async recover() {
    if (this._recovering || !this.ctx) return false;
    this._recovering = true;
    try {
      if (this.ctx.state === "closed") return false;
      if (this.ctx.state === "suspended") { try { await this.ctx.resume(); } catch {} }
      const track = this.stream && this.stream.getAudioTracks
        ? this.stream.getAudioTracks()[0] : null;
      // A running context with a live track will start pulling the worklet by
      // itself; taking the microphone again in that state would interrupt a
      // service that was already fixing itself.
      if (this.ctx.state === "running" && track && track.readyState === "live") return true;
      return await this._retakeMic();
    } catch {
      return false;
    } finally {
      this._recovering = false;
    }
  }

  /**
   * Ask for the microphone again and splice it into the existing graph.
   *
   * Pinned to the input we were actually on. `ideal` would let a dropped
   * Bluetooth mic be replaced by the laptop's built-in one, audio would start
   * flowing, the stall warning would clear, and the presenter would be told
   * everything was fine while the room was being transcribed off the wrong
   * microphone. So: the same device, or a substitute we say out loud.
   */
  async _retakeMic() {
    let fresh = null;
    const want = this._activeDeviceId;
    if (want) {
      try {
        fresh = await navigator.mediaDevices.getUserMedia({
          audio: { ...(this._audioConstraints || {}), deviceId: { exact: want } },
        });
      } catch { /* the same device is not back yet — see below */ }
    }
    if (!fresh) {
      // A Bluetooth mic can come back under a new id, so refusing anything but
      // the old one would mean never recovering. Take what there is, and let
      // the presenter know the input is not the one they set up.
      fresh = await navigator.mediaDevices.getUserMedia({
        audio: this._audioConstraints || { channelCount: 1 },
      });
      if (want) this.inputChanged = true;
    }
    try { this.src && this.src.disconnect(); } catch {}
    try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    this.stream = fresh;
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.src.connect(this.node);          // the worklet and its sink are untouched
    this._watchTrack();
    // The archive recorder stays on the stream that died, and is deliberately
    // NOT restarted on the new one. Appending a second encode to the same
    // chunk list looks like it should work and does not: measured with ffmpeg,
    // a joined 5 s + 7 s WebM reads as 5 s, so the remainder would be dead
    // bytes inside a file that claims to hold the whole service. A recording
    // that honestly stops at the drop is worth more than one that lies about
    // its length. (To keep all of it, the recorder would have to hang off a
    // MediaStreamDestination in the graph rather than off the microphone.)
    this.recSplitAt = this.recSplitAt || Date.now();
    return true;
  }

  /**
   * The track, if we still have one. `onended` is not reliable on its own —
   * it does not fire for a track ended locally, and was already false 300 ms
   * after a real one ended in Chrome — so readyState is the thing to trust and
   * the events are only the fast path.
   */
  _track() {
    try {
      return (this.stream && this.stream.getAudioTracks && this.stream.getAudioTracks()[0]) || null;
    } catch { return null; }
  }

  /** The device is GONE. Unambiguous, and true whether or not anyone is looking. */
  inputGone() {
    if (this.inputEnded) return true;
    const t0 = this._track();
    return !!t0 && t0.readyState !== "live";
  }

  /** Gone, or held by something else. Either way nothing of the room reaches us. */
  inputDead() {
    if (this.inputMuted) return true;
    const t0 = this._track();
    return this.inputGone() || !!(t0 && t0.muted);
  }

  /**
   * Where the input actually is, in one line, for the alert we send ourselves.
   * "no audio" alone cannot be acted on; "the track ended" means the OS handed
   * the microphone to something else, and "suspended" means the browser paused
   * us — different conversations with the person who was presenting.
   */
  state() {
    let track = "none";
    try {
      const t0 = this.stream && this.stream.getAudioTracks && this.stream.getAudioTracks()[0];
      if (t0) track = `${t0.readyState}${t0.muted ? "/muted" : ""}`;
    } catch {}
    return `ctx=${this.ctx ? this.ctx.state : "none"} track=${track}`;
  }

  stop() {
    try { this.rec && this.rec.state !== "inactive" && this.rec.stop(); } catch {}
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

/**
 * Ratio of the window's loud frames to its quiet ones — see DYN_SPEECH. Uses
 * percentiles rather than max/min so one door slam or one dropout can't decide
 * it. Too short a window to judge reports 0, which the caller reads as "don't
 * skip on my account".
 */
function dynamicRange(pcm) {
  const frames = [];
  for (let i = 0; i + DYN_FRAME <= pcm.length; i += DYN_FRAME) {
    let s = 0;
    for (let j = i; j < i + DYN_FRAME; j += 2) s += pcm[j] * pcm[j];
    frames.push(Math.sqrt(s / (DYN_FRAME / 2)));
  }
  if (frames.length < 8) return 0;
  frames.sort((a, b) => a - b);
  const lo = frames[Math.floor(frames.length * 0.2)];
  const hi = frames[Math.floor(frames.length * 0.9)];
  return hi / Math.max(lo, 1e-6);
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
      const a = normWord(this.prev[i].w);
      const b = normWord(words[i].w);
      // A token that normalises to nothing — a bare space, or punctuation on its
      // own — used to fail the truthiness test and break the whole scan, so
      // everything after it stayed uncommitted no matter how well it agreed.
      // Whisper emits exactly such a leading " " token for `language=yue`, which
      // meant choosing Cantonese produced a session where NO line ever settled:
      // the audience saw only the provisional tail until the 28 s force-commit.
      // Two identical empty tokens agree; that is all this needs to say.
      const same = a === b && (a !== "" || this.prev[i].w === words[i].w);
      if (same) stable.push(words[i]);
      else break;
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
    let upstream = 0;
    try {
      const j = await res.json();
      upstream = Number(j.status) || 0;
      msg = j.error === "not_configured" ? "server has no key pool configured"
          : j.error === "bad_access_code" ? "access code rejected"
          : `${j.error || res.status}${j.status ? " " + j.status : ""}`;
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    // A drained pool is not a bug, it's a budget, and it has its own message and
    // its own incident category. On the hosted path the 429 arrives WRAPPED —
    // the proxy answers `{error:"upstream", status:429}` — so testing only the
    // outer status missed it, and the site the church actually uses reported
    // "upstream 429" and filed it as `asr_failed`. Hour three of a service is
    // exactly when this fires.
    if (res.status === 429 || upstream === 429) err.exhausted = true;
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
  /**
   * Bench a key after a 429, for as long as the API says.
   *
   * This used to clamp the wait to 2 minutes, which is right for a per-minute
   * token limit but wrong for the daily request cap: an exhausted key would
   * re-enter the rotation every 2 minutes, fail again, and be benched again —
   * spending a failed round-trip and delaying real work each time.
   *
   * Groq's daily cap refills continuously (~43s per whisper request, ~86s per
   * chat request), so `retry-after` is usually tens of seconds rather than
   * hours. Honour whatever it says; the hour ceiling is only a sanity bound so
   * a malformed header can't bench a key for the rest of the service.
   */
  bench(key, retryAfter) {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) && secs > 0
      ? Math.min(3600000, Math.max(5000, secs * 1000))
      : 60000;                                   // no header: assume a refill gap
    this.cool.set(key, Date.now() + ms);
  }

  /** Seconds until the earliest key frees up — for telling the operator. */
  nextFreeIn() {
    if (!this.keys.length) return 0;
    const now = Date.now();
    const soonest = Math.min(...this.keys.map((k) => this.cool.get(k) || 0));
    return Math.max(0, Math.round((soonest - now) / 1000));
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
  // The bare instruction "use Afghan vocabulary, NOT Iranian Farsi" was measured
  // on 2026-08-17 and does NOT work: gpt-oss-120b scored 0/4, 2/4, 0/4 over three
  // runs on the standard register probe and shipped plain Iranian Farsi
  // (بیمارستان / دانشگاه / خیابان / ماشین) to an Afghan congregation. A negative
  // instruction with no examples is not enough. Naming four concrete pairs took
  // the same model to 4/4, 4/4, 4/4 at no extra latency — so the examples stay,
  // and the final line is what generalises them beyond these four words.
  prs:       { label: "دری",      en: "Dari",      rtl: true,  note:
    "Dari (دری, Afghan Persian) for an AFGHAN audience.\n"
    + "     You MUST use the Afghan word, never the Iranian one:\n"
    + "       hospital = شفاخانه (not بیمارستان)   university = پوهنتون (not دانشگاه)\n"
    + "       street = سرک (not خیابان)            car = موتر (not ماشین)\n"
    + "     Apply the same Afghan preference to every other word and idiom." },
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

/**
 * Languages the SPEAKER may be using, as opposed to LANGS which is what the
 * audience reads. `code` is Whisper's own language code and is sent verbatim;
 * an empty code means auto-detect.
 *
 * Auto-detect exists and is still the default, but it is not neutral: given
 * Cantonese it reports "Chinese" and transcribes Mandarin, so 今日我哋要睇
 * comes out as 今日我們要看. Setting `yue` explicitly is the only way to get
 * Cantonese out of Whisper, which is why this table exists at all rather than
 * the three hardcoded options it replaced.
 */
export const SOURCE_LANGS = {
  auto: { code: "",    label: "Auto-detect" },
  en:   { code: "en",  label: "English",    prompt: "English" },
  zh:   { code: "zh",  label: "普通話 / Mandarin", prompt: "Mandarin Chinese",
          keep: "Write it in Chinese characters as spoken." },
  yue:  { code: "yue", label: "廣東話 / Cantonese", prompt: "Cantonese (廣東話)",
          keep: "Never rewrite it into Mandarin: keep 我哋/我地, 睇, 喺, 嘅, 唔, 咗, 邊個,\n一齊 and every other Cantonese word and particle exactly as they were said." },
  fa:   { code: "fa",  label: "فارسی / Persian",  prompt: "Persian" },
  ar:   { code: "ar",  label: "العربية / Arabic", prompt: "Arabic" },
  ur:   { code: "ur",  label: "اردو / Urdu",      prompt: "Urdu" },
  ko:   { code: "ko",  label: "한국어 / Korean",   prompt: "Korean" },
  ja:   { code: "ja",  label: "日本語 / Japanese", prompt: "Japanese" },
  es:   { code: "es",  label: "Español",          prompt: "Spanish" },
  fr:   { code: "fr",  label: "Français",         prompt: "French" },
  id:   { code: "id",  label: "Indonesia",        prompt: "Indonesian" },
  vi:   { code: "vi",  label: "Tiếng Việt",       prompt: "Vietnamese" },
  hi:   { code: "hi",  label: "हिन्दी / Hindi",     prompt: "Hindi" },
  th:   { code: "th",  label: "ไทย / Thai",       prompt: "Thai" },
};

function buildSys(targets, sourceLang) {
  const list = targets.map((c) => `   - "${c}": ${(LANGS[c] || {}).note || c}`).join("\n");
  const src = SOURCE_LANGS[sourceLang];
  // Naming the spoken language is not decoration. Told only that the talk "may
  // mix English and Chinese", the correction step rewrote a correctly
  // transcribed Cantonese sentence into Mandarin — 我哋→我們, 睇→看, 嘅→的 —
  // so picking Cantonese in the console fixed the transcription and then lost it
  // again one stage later. `keep` is where a language says what must survive.
  const note = src && src.code
    ? `The speaker is speaking ${src.prompt}. The corrected source MUST stay in
${src.prompt} exactly as spoken — correcting is not translating.${src.keep ? "\n" + src.keep : ""}
`
    : `The talk may mix languages. Keep the corrected source in whatever language
each sentence was actually spoken in; never convert it to another language or
to a different variety of the same language.
`;
  return `You are a professional live interpreter working in real time.
You receive raw speech-recognition output from a live talk.
${note}
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
/**
 * A dropped connection is not a verdict on the provider.
 *
 * `fetch failed` — a reset socket, a cold function, a phone changing cell —
 * arrives with no `.status` at all, and the old code treated it exactly like a
 * refusal: abandon this step, and with a hosted chain of one that abandoned the
 * sentence entirely. Unlike speech recognition, translation never gets a second
 * chance on its own: the next tick re-transcribes the same audio, but a
 * translation is issued once per committed line, so whatever is lost here is
 * lost for the rest of the service. The audience is left reading a line of
 * Chinese they came here precisely because they cannot read.
 *
 * So transport errors and 5xx get another attempt; a 4xx (a real refusal —
 * wrong model, malformed request) still moves straight on.
 */
const isTransient = (e) => !e || !e.status || e.status >= 500;
const TRANSIENT_TRIES = 3;
const backoff = (n) => new Promise((r) => setTimeout(r, 400 * 2 ** n));

async function askChain(chain, prompt, sys) {
  const errors = [];
  for (const step of chain) {
    const def = LLM_PROVIDERS[step.id];
    if (!def || !(def.kind === "proxy" || step.key || (step.pool && step.pool.size))) continue;
    // A pooled step gets one attempt per key (429 rotation); every step also
    // gets a few attempts at a transient failure, whichever is more.
    const tries = Math.max(TRANSIENT_TRIES, step.pool ? step.pool.size : 1);
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
        if (isTransient(e) && a < tries - 1) { await backoff(a); continue; }
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

/**
 * Order the translation providers for a session.
 *
 * Fast-and-good first, reliable-but-slow last; only configured steps join. The
 * subtlety that broke the hosted site outright is that the `proxy` step carries
 * NO key — that is the entire point of hosted mode — so a filter on `.key`
 * silently produced an empty chain and every Start died with
 * "missing_llm_key". Lives here rather than inline in the console so it can be
 * tested without a DOM.
 */
export function buildLlmChain({ useProxy = false, groqKeys = [], gemini = "", kimi = "", glm = "" } = {}) {
  return [
    ...(useProxy ? [{ id: "proxy" }] : []),
    { id: "groq",   key: (groqKeys && groqKeys[0]) || "" },
    { id: "gemini", key: gemini },
    { id: "kimi",   key: kimi },
    { id: "glm",    key: glm },
  ].filter((s) => s.id === "proxy" || s.key);
}

/* ───────────────────────── engine ───────────────────────── */

export class LiveEngine {
  constructor(opts = {}) {
    this.cfg = {
      // large-v3 over turbo: measured on real sermon audio it fixed a homophone
      // (當日→當然), avoided a garbled run, and ADDS PUNCTUATION (which the
      // sentence splitter below depends on) for ~0.1 s more on a 25 s window.
      groqKey: "", groqKeys: [], proxy: false, deviceId: "", groqModel: "whisper-large-v3", language: "auto",
      // "whisper" (windowed Groq, works hosted) | "gemini" (streaming). Gemini
      // needs EITHER asrRelay (the Worker holds the key, so the page needs
      // nothing) OR geminiKey in this browser. Anything unusable silently
      // stays on whisper — a missing key must never take the service off air.
      asr: "whisper", geminiKey: "", asrRelay: "",
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
    this._gUttEmitted = "";   // text already taken out of the CURRENT utterance
    this.archive = [];         // PCM fallback only — see PCM_ARCHIVE_MAX
    this.archiveLen = 0;
    this.archiveTruncated = false;
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
    // Streaming ASR replaces the Groq audio pool, not the chat chain: the LLM
    // still corrects and translates every settled sentence.
    this.useGemini = this.cfg.asr === "gemini"
      && (!!this.cfg.asrRelay || !!this.cfg.geminiKey);
    if (!this.useGemini && !this.cfg.proxy && !this.pool.size) throw new Error("missing_asr_key");
    if (!this.cfg.llmChain || !this.cfg.llmChain.length) throw new Error("missing_llm_key");

    if (this.useGemini) this._startGemini();

    this.cap = new Capture((chunk, rate) => this._audio(chunk, rate));
    this.cap.deviceId = this.cfg.deviceId || "";
    this.rate = await this.cap.start();
    this.running = true;
    this.lastVoiceAt = Date.now();
    this.lastTickAt = Date.now();
    this.lastAudioAt = Date.now();
    // Measure the forced-probe window from the start of the session; left
    // unset it reads as "last transcribed at epoch 0" and fires on tick one.
    this.lastAsrAt = Date.now();
    this.stallWarned = false;
    this.stallReported = false;
    // See _watchdog: the tick that would have cleared the clock may never have
    // run while the page was hidden, so do it on the transition itself.
    this._vis = () => {
      if (document.visibilityState === "visible") this.lastAudioAt = Date.now();
    };
    document.addEventListener("visibilitychange", this._vis);
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

  /**
   * Streaming ASR. The server finalizes segments itself, so there is no tick and
   * no LocalAgreement here — a finalized segment goes straight into the same
   * _commit() the Whisper path feeds, and everything downstream is unchanged.
   */
  _startGemini() {
    this.gasr = new GeminiLiveAsr({
      relay: this.cfg.asrRelay,
      key: this.cfg.geminiKey,
      language: this.cfg.language === "auto" ? "" : this.cfg.language,
      // The glossary becomes ASR BIAS rather than post-hoc correction. The text
      // glossary could only ever fire on a term already spelled correctly —
      // exactly when it was not needed; as customVocabulary it applies first.
      glossary: this.cfg.glossary,
      onInterim: (t) => {
        this._gInterim = t;
        // Take any sentence the server has already moved past, rather than
        // holding the whole utterance until it finalizes.
        this._harvest(t);
        const tail = ((this.sentence || "") + " " + this._unharvested(t))
          .replace(/\s+/g, " ").trim();
        this.on.draft(tail);
        this._interim(tail);
      },
      onFinal: (t) => {
        this._gInterim = "";
        this.asrCalls = (this.asrCalls || 0) + 1;
        this.lastAsrAt = Date.now();
        // The final restates the ENTIRE utterance, including whatever the
        // interims already put on screen — commit only what is new.
        const rest = this._dropHarvested(t);
        this._gUttEmitted = "";
        if (rest) this._commit(rest);
        this.on.draft((this.sentence || "").trim());
      },
      onStatus: (s) => this.on.status({ running: true, asr: "gemini", ...s }),
      onError: (e) => {
        // Losing streaming ASR mid-sermon must not end the service: fall back to
        // the Whisper path, which needs only the tick that is already running.
        this.useGemini = false;
        this.gasr = null;
        this.on.status({ running: true, asr: "whisper", fellBack: true });
        this.on.error(e);
      },
    });
    this.gasr.start();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    if (this._vis) { document.removeEventListener("visibilitychange", this._vis); this._vis = null; }
    this.gasr && this.gasr.stop();
    this.cap && this.cap.stop();
    this.on.status({ running: false });
  }

  _audio(chunk, rate) {
    if (!this.running) return;
    // Buffers still arrive while the OS holds the microphone for something
    // else; they are just silence. Counting them as proof the input is alive
    // is what let a muted mic run a whole service without one warning.
    if (this.cap && this.cap.inputDead()) {
      // Silence from a dead input proves nothing and clears nothing. Treating
      // it as recovery would flicker the warning off and on every few seconds
      // and re-send the alert each time round.
    } else {
      this.lastAudioAt = Date.now();
      if (this.stallWarned) {               // recovered (e.g. mic reconnected)
        this.stallWarned = false;
        this.stallReported = false;
        this.on.status({ running: true, stalled: false });
      }
    }
    const pcm = resampleTo16k(chunk, rate);
    // Streaming ASR consumes audio as it arrives, so the overlapping-window
    // buffer would only grow forever. Everything below — archive, level meter,
    // stall watchdog — is shared and still runs.
    if (this.useGemini && this.gasr) {
      this.gasr.push(pcm);
    } else {
      this.buf.push(pcm);
      this.bufLen += pcm.length;
    }
    // Raw PCM is only retained where the browser gave us no MediaRecorder, and
    // even then it is bounded: unbounded retention is what put 659 MB in a
    // three-hour tab. A truncated archive is a far smaller loss than a session
    // that gets killed by the OS in the middle of the sermon.
    if (!this.cap || !this.cap.rec) {
      this.archive.push(pcm);
      this.archiveLen += pcm.length;
      while (this.archiveLen > PCM_ARCHIVE_MAX) {
        this.archiveLen -= this.archive.shift().length;
        this.archiveTruncated = true;
      }
    }

    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    // Auto-gain the meter off the loudest thing heard so far, so a quiet input
    // still shows movement across the bar instead of a permanent sliver that
    // looks identical to a dead microphone.
    this.peakRms = Math.max(this.peakRms || 0, rms);
    const scale = this.peakRms > 0.02 ? 1 / this.peakRms : 8;
    this.on.level(Math.min(1, rms * scale));
    if (rms > this._voiceFloor()) this.lastVoiceAt = Date.now();
    this._maybeTick();
  }

  /** Fire a confirm pass when one is due, whatever woke us. */
  _maybeTick() {
    if (!this.running || this.busy) return;
    // Streaming ASR: _tick() would return immediately (the overlap buffer is
    // empty by design), and the trailing-fragment flush lives inside it — so
    // without this a last part-sentence would sit unsent until Stop. Waiting
    // for `!_gInterim` avoids cutting a sentence the server is still forming;
    // MAX_UNIT_WAIT_MS is the backstop for a speaker who never pauses.
    if (this.useGemini) {
      if (this.sentence.trim()) {
        const quiet = Date.now() - this.lastVoiceAt > SILENCE_FLUSH_MS;
        const stale = this.pendingSince && Date.now() - this.pendingSince > MAX_UNIT_WAIT_MS;
        if ((quiet && !this._gInterim) || stale) this._flushSentence();
      }
      // A session can stay OPEN and simply stop answering: measured at 1x on
      // 2026-09-05, the server went silent for 107 s while speech kept
      // arriving, and only then closed the socket — and the client reconnects
      // only on close. Nothing reached the audience for that whole stretch.
      // So: voice is present (the level meter says so) and the server has said
      // nothing for GEMINI_STALL_MS → cycle the socket now. During real
      // silence in the room this never fires, because lastVoiceAt is old too.
      const g = this.gasr;
      if (g && g.connected && g.lastServerMsgAt
          && Date.now() - this.lastVoiceAt < 3000
          && Date.now() - g.lastServerMsgAt > GEMINI_STALL_MS) {
        g.lastServerMsgAt = Date.now();      // one cycle per stall, not one per tick
        this.on.status({ running: true, asr: "gemini", stalled: true });
        g._cycle();
      }
      return;
    }
    // A drained pool refills continuously (~43 s per whisper request), so the
    // right response is to wait it out, not to keep firing every 2.2 s — that
    // spends nothing but latency and buries the console in identical errors.
    if (Date.now() < (this.coolUntil || 0)) return;
    if (Date.now() - this.lastTickAt < TICK_MS) return;
    this.lastTickAt = Date.now();
    this._tick().catch((e) => {
      if (e && e.exhausted) {
        this.coolUntil = Date.now() + EXHAUSTED_BACKOFF_MS;
        this.exhausted = true;
        this.on.status({ running: true, exhausted: true });
      }
      this.on.error(e);
    });
  }

  /**
   * Audio silently stopping is a real failure mode — a Bluetooth mic drops, or
   * the OS hands the device to another app. Without this the UI keeps saying
   * "Live" while nothing is being captured.
   */
  _watchdog() {
    if (!this.running) return;
    // A hidden page has its audio suspended by the OS on purpose — that's not a
    // broken microphone, and warning about it would cry wolf every time the
    // presenter glances at another app. Only judge a stall while visible.
    //
    // Clearing the clock here is not enough on its own: a hidden tab's timers
    // are throttled to about once a MINUTE, so the last hidden tick can be long
    // past by the time the presenter comes back, and the first visible tick
    // then reads a minute of "silence" that was only ever the screen being off.
    // start() stamps the clock on the way back to the foreground for that.
    // A track that has ENDED is gone whether or not anyone is looking at the
    // screen, and the sooner we start asking for it back the better — waiting
    // for the presenter to wake their phone wastes the whole outage. Being
    // MUTED is not treated the same way, because a backgrounded page is
    // exactly where a platform might mute an input for its own reasons, and
    // mailing us every time a screen sleeps is the bug we started from.
    const gone = !!(this.cap && this.cap.inputGone());
    if (document.visibilityState !== "visible" && !gone) { this.lastAudioAt = Date.now(); return; }
    const gap = Date.now() - this.lastAudioAt;
    // A dead input keeps the clock fresh all by itself (see _watchTrack), so
    // waiting for the clock to go stale would mean waiting forever.
    if (gap < MIC_WARN_MS && !(this.cap && this.cap.inputDead())) return;

    if (!this.stallWarned) {
      this.stallWarned = true;
      this.on.status({ running: true, stalled: true });
      this.on.error(new Error("audio_stalled"));
      this.lastRecoverAt = 0;
    }
    // Complaining is not a fix. A suspended context can be resumed and an ended
    // track can be retaken, and either beats a dead session that only recovers
    // if someone in the room notices and presses Stop/Start.
    if (this.cap && Date.now() - (this.lastRecoverAt || 0) >= MIC_RETRY_MS) {
      this.lastRecoverAt = Date.now();
      this.cap.recover()
        .then(() => {
          // Recovered onto a different input than the one that was set up. The
          // service continues, but nobody should believe it is the same mic.
          if (this.cap && this.cap.inputChanged && !this.inputChangeTold) {
            this.inputChangeTold = true;
            this.on.error(new Error("mic_changed"));
          }
        })
        .catch(() => {});
    }
    // Still nothing well after the warning: this one is real, so tell us.
    if (gap >= MIC_REPORT_MS && !this.stallReported) {
      this.stallReported = true;
      const err = new Error("audio_stalled_persists");
      err.detail = `no audio for ${Math.round(gap / 1000)}s after ${
        Math.max(1, Math.round(gap / MIC_RETRY_MS))} recovery attempts; ${
        this.cap ? this.cap.state() : "no capture"}`;
      this.on.error(err);
    }
  }

  /**
   * Remember what this room actually sounds like. Only the quietest windows
   * inform the floor, so a long stretch of speech can't drag it up and start
   * suppressing the speech that raised it.
   */
  _noteLevel(v) {
    if (!Number.isFinite(v)) return;
    (this.levels || (this.levels = [])).push(v);
    if (this.levels.length > 150) this.levels.shift();
  }

  /**
   * The level a window must clear to be worth transcribing: the 20th percentile
   * of what we've heard, times a margin. Until there are enough observations to
   * mean anything, only true digital silence is skipped — an unknown room is
   * transcribed, not guessed at.
   */
  _voiceFloor() {
    const n = this.levels ? this.levels.length : 0;
    // Before the room is known, leave this check deliberately insensitive and
    // let dynamic range do the work — it needs no calibration, so an empty room
    // isn't transcribed just for having a noise floor above digital silence.
    if (n < FLOOR_MIN_OBS) return SILENCE_ABS * SILENCE_MARGIN;
    const sorted = this.levels.slice().sort((a, b) => a - b);
    const quiet = sorted[Math.floor(n * 0.2)];
    return Math.max(SILENCE_ABS, quiet * SILENCE_MARGIN);
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
    const level = rmsOf(pcm);
    this._noteLevel(level);
    // The safety net that makes a wrong floor survivable: however quiet this
    // input looks, never go longer than FORCE_PROBE_MS without actually asking,
    // as long as something above true silence is arriving. Worst case this
    // spends ~360 requests across a three-hour service, against a budget of
    // 16,000 — the price of never again shipping a session that dies quietly.
    const overdue = Date.now() - (this.lastAsrAt || 0) > FORCE_PROBE_MS && level > SILENCE_ABS;
    // Three independent reasons to spend the call, and it only takes one. Level
    // alone was the old gate and the reason a whole session could go dark.
    const worthIt = dynamicRange(pcm) >= DYN_SPEECH || level >= this._voiceFloor();
    if (!overdue && !worthIt && !this.agree.pendingText()) {
      this._trim(seconds - MIN_WINDOW_S / 2);
      this.skipped = (this.skipped || 0) + 1;
      return;
    }
    this.lastAsrAt = Date.now();

    this.busy = true;
    try {
      const wav = encodeWav(pcm, 16000);
      this.asrCalls = (this.asrCalls || 0) + 1;
      const { words } = await transcribeGroq({
        blob: wav, pool: this.pool, proxy: this.cfg.proxy,
        model: this.cfg.groqModel, language: this.cfg.language,
      });
      // Budget came back on its own — say so, so the console stops showing a
      // quota warning that is no longer true.
      if (this.exhausted) {
        this.exhausted = false;
        this.on.status({ running: true, exhausted: false });
      }

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

  /* ── taking a sentence out of a live interim ─────────────────────────────
   *
   * Measured against the relay on 2026-09-13 with tools/fixtures/speech-16k.wav:
   * the interim is the whole utterance so far, and the FINAL restates that same
   * utterance from the beginning while rewriting it — interim "Romans chapter 8
   * where Paul writes", final "Romans, chapter eight, where Paul writes". Two
   * consequences, and both of these methods exist because of them:
   *
   *   1. A finished sentence is visible in an interim long before the final.
   *      "Good morning everyone." was complete at 3.0 s; the final arrived at
   *      8.7 s. On a speaker who pauses, that 5.7 s is invisible because the
   *      pause triggers the final anyway. On one who does not pause — Anne on
   *      2026-09-13, filling every gap with "uh" and "right?" — the wait runs
   *      to the length of a whole paragraph, which then lands on the room's
   *      screen in one block and is pushed off before anyone can read it.
   *   2. The prefix already sent CANNOT be removed from the final by string
   *      comparison, because the final has rewritten it. It has to go by word
   *      count, anchored on the last words actually sent.
   */

  /** The part of the current interim that has not been sent as a line yet. */
  _unharvested(text) {
    const n = wordsOf(this._gUttEmitted).length;
    return n ? wordsOf(text).slice(n).join(" ") : String(text || "");
  }

  /**
   * Send every sentence this interim has finished AND moved past.
   *
   * "Moved past" carries the whole safety argument. A terminator with more
   * words after it is the server's own statement that it has settled that
   * sentence; a terminator at the very END of an interim is still a guess and
   * routinely vanishes on the next frame.
   */
  _harvest(text) {
    const all = wordsOf(text);
    let taken = wordsOf(this._gUttEmitted).length;
    // Fewer words than we have already taken means the server moved on to a
    // new utterance: there is nothing left to de-duplicate against.
    if (all.length < taken) { this._gUttEmitted = ""; taken = 0; }
    const rest = all.slice(taken);
    if (rest.length < 2) return;
    let end = -1;
    for (let i = 0; i < rest.length - 1; i++) {
      if (/[.!?。！？…]["\'”’)\]]?$/.test(rest[i])) end = i;
    }
    if (end < 0) return;
    if (rest.slice(end + 1).join(" ").length < HARVEST_TAIL_CHARS) return;
    this._gUttEmitted = all.slice(0, taken + end + 1).join(" ");
    this._commit(rest.slice(0, end + 1).join(" "));
  }

  /**
   * Drop from a final whatever the interims have already put on screen.
   *
   * Anchored on the last two words sent rather than on the count alone, because
   * the final can spell a number out ("8" → "eight") and move the boundary by a
   * word. If the anchor is nowhere near where it should be, the raw count is
   * used: showing the room the same sentence twice is a worse failure than
   * clipping a word off the front of the next one.
   */
  _dropHarvested(text) {
    const emitted = wordsOf(this._gUttEmitted);
    if (!emitted.length) return String(text || "");
    const fw = wordsOf(text);
    const n = emitted.length;
    const a = normWord(emitted[n - 1]);
    const b = n > 1 ? normWord(emitted[n - 2]) : "";
    const fits = (k) => k >= 1 && k <= fw.length && normWord(fw[k - 1]) === a
      && (!b || k < 2 || normWord(fw[k - 2]) === b);
    let cut = Math.min(n, fw.length);
    for (const k of [n, n - 1, n + 1, n - 2, n + 2, n - 3, n + 3]) {
      if (fits(k)) { cut = k; break; }
    }
    return fw.slice(cut).join(" ");
  }

  _commit(text) {
    const t = String(text || "").replace(/\s+/g, " ").replace(/\s+([,.!?;:，。！？；：])/g, "$1").trim();
    if (!t) return;
    if (!this.sentence) this.pendingSince = Date.now();
    this.sentence = (this.sentence ? this.sentence + " " : "") + t;

    // Prefer a real sentence boundary; fall back to length so an unpunctuated
    // speaker still gets delivered in readable pieces.
    if (this._drainSentences()) return;
    if (this.sentence.length >= MAX_SENTENCE_CHARS) this._flushSentence();
  }

  /**
   * Take out EVERY finished sentence, not just the first one.
   *
   * Streaming ASR hands over whole utterances, so one final routinely carries
   * several sentences. Peeling off only the leading one left the rest sitting
   * in the buffer until the speaker paused, and the pause flush then put all
   * of them on the room's screen as a single 358-character paragraph, which is
   * exactly what a congregation reading a second language cannot keep up with:
   * it arrives all at once and is pushed off by the next one. One sentence per
   * line also means each is translated on its own and appears as its
   * translation lands, so the screen advances at the pace of the speech.
   *
   * Returns true when at least one line was sent.
   */
  _drainSentences() {
    let sent = false;
    for (;;) {
      const m = this.sentence.match(/^([\s\S]*?[.!?。！？…]+["'”’)\]]?)\s*([\s\S]*)$/);
      if (!m) break;
      const done = m[1].trim();
      this.sentence = m[2] || "";
      // The tail that is left is a new, unfinished unit: time it from now, or
      // MAX_UNIT_WAIT_MS would measure from a sentence that has already gone.
      this.pendingSince = this.sentence ? Date.now() : 0;
      if (done) { this._send(done); sent = true; }
    }
    return sent;
  }

  _flushSentence() {
    // A flush is not a reason to glue finished sentences together: drain them
    // first, then send whatever unfinished tail is left as its own line.
    this._drainSentences();
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
        const { raw, via } = await askChain(this.cfg.llmChain, prompt, buildSys(this.cfg.targets, this.cfg.language));
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
    // The recorder's last slice lands after stop(); without this the download
    // silently loses the closing minutes of the service.
    if (this.cap) await this.cap.flushArchive();
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

  /**
   * The session recording, for pushing through the Mac pipeline afterwards.
   * Returns `{ blob, ext, truncated }`, or null when nothing was captured.
   *
   * Await `drain()` first — the recorder's final slice arrives asynchronously.
   */
  archiveFile() {
    const recorded = this.cap && this.cap.archive();
    if (recorded) {
      return {
        blob: recorded,
        ext: recorded.type.includes("mp4") ? "m4a" : "webm",
        truncated: false,
        // The recorder was bound to a microphone that went away mid-service, so
        // this file ends there even though the transcript carried on. Say so
        // rather than letting a short file look like a lost sermon.
        stoppedEarly: !!(this.cap && this.cap.recSplitAt),
      };
    }
    if (!this.archive.length) return null;
    const all = new Float32Array(this.archiveLen);
    let o = 0;
    for (const c of this.archive) { all.set(c, o); o += c.length; }
    return { blob: encodeWav(all, 16000), ext: "wav", truncated: this.archiveTruncated };
  }
}

export { encodeWav };
