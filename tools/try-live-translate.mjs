/**
 * Experiment: Gemini 3.5 Live Translate through the existing relay.
 *
 *   node --network-family-autoselection-attempt-timeout=2000 \
 *        tools/try-live-translate.mjs <file.wav> [--to fa] [--sid abc]
 *
 * One model that listens and translates as the speaker talks, instead of Spark
 * Live's two steps (transcribe, then an LLM corrects and translates). Streams a
 * 16 kHz mono PCM16 WAV at real time and prints what it heard, what it produced,
 * and how far the translation trailed the speech.
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const file = argv.find((a) => !a.startsWith("--") && fs.existsSync(a));
if (!file) { console.error("usage: tools/try-live-translate.mjs <file.wav> [--to fa]"); process.exit(2); }
const TO = flag("to", "fa");
const RELAY = flag("relay", "wss://spark-live-asr.lsy95112.workers.dev/asr");
const SID = flag("sid", "tl" + Math.random().toString(36).slice(2, 7));

const wav = fs.readFileSync(file);
const pcm = wav.subarray(wav.indexOf("data") + 8);
const ws = new WebSocket(`${RELAY}?sid=${SID}`, { headers: { Origin: "https://spark-live-translate.netlify.app" } });
const t0 = Date.now(); const at = () => (Date.now() - t0) / 1000;
let streamStart = 0, outAudioBytes = 0;
const heard = [], said = [];

ws.addEventListener("open", () => ws.send(JSON.stringify({ setup: {
  model: "models/gemini-3.5-live-translate-preview",
  generationConfig: {
    responseModalities: ["AUDIO"],
    translationConfig: { targetLanguageCode: TO, echoTargetLanguage: false },
  },
  inputAudioTranscription: {}, outputAudioTranscription: {},
} })));

ws.addEventListener("message", async (ev) => {
  let r = ev.data; if (r instanceof Blob) r = await r.text(); else if (r instanceof ArrayBuffer) r = new TextDecoder().decode(r);
  let m; try { m = JSON.parse(r); } catch { return; }
  if (m.setupComplete) {
    console.log(`${at().toFixed(1)}s setupComplete — streaming ${(pcm.length / 32000).toFixed(1)}s at real time\n`);
    streamStart = Date.now(); let off = 0; const F = 3200;
    const t = setInterval(() => {
      if (off >= pcm.length) { clearInterval(t); return; }
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.subarray(off, off + F).toString("base64"), mimeType: "audio/pcm;rate=16000" } } }));
      off += F;
    }, 100);
    return;
  }
  const sc = m.serverContent; if (!sc) { if (m.error || m.goAway) console.log("server:", JSON.stringify(m).slice(0, 200)); return; }
  const tAudio = (Date.now() - streamStart) / 1000;
  if (sc.inputTranscription?.text) heard.push({ t: tAudio, x: sc.inputTranscription.text });
  if (sc.outputTranscription?.text) said.push({ t: tAudio, x: sc.outputTranscription.text });
  for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) outAudioBytes += Buffer.from(p.inlineData.data, "base64").length;
});
ws.addEventListener("close", (e) => { report(`closed ${e.code} ${String(e.reason).slice(0, 120)}`); });
setTimeout(() => report("done"), (pcm.length / 32000) * 1000 + 15000);

let reported = false;
function report(why) {
  if (reported) return; reported = true;
  // Group the stream into ~10 s windows so the two sides can be read against each other.
  const win = (arr) => { const g = new Map(); for (const e of arr) { const k = Math.floor(e.t / 10) * 10; g.set(k, (g.get(k) || "") + e.x); } return g; };
  const H = win(heard), S = win(said);
  const keys = [...new Set([...H.keys(), ...S.keys()])].sort((a, b) => a - b);
  for (const k of keys) {
    console.log(`── ${String(k).padStart(3)}–${k + 10}s ──`);
    console.log(`  heard: ${(H.get(k) || "").replace(/\s+/g, " ").trim()}`);
    console.log(`  ${TO}:    ${(S.get(k) || "").replace(/\s+/g, " ").trim()}`);
  }
  // Lag: for each heard chunk, when did the translated text next advance?
  const lags = [];
  for (const h of heard) { const s = said.find((x) => x.t >= h.t); if (s) lags.push(s.t - h.t); }
  lags.sort((a, b) => a - b);
  const p = (q) => lags.length ? lags[Math.min(lags.length - 1, Math.floor(lags.length * q))].toFixed(1) : "-";
  console.log(`\n${why} | heard ${heard.length} pieces, translated ${said.length} pieces, ${(outAudioBytes / 48000).toFixed(0)}s of translated speech`);
  console.log(`translation trails the transcript by: median ${p(0.5)}s  p90 ${p(0.9)}s`);
  process.exit(0);
}
