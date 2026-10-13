/**
 * Spark Live — replay a recording through the SHIPPED engine at real-time speed.
 *
 *   node tools/replay.mjs <file.wav> [--origin https://spark-live-translate.netlify.app]
 *                                     [--asr gemini|whisper] [--lang en|zh|yue|auto]
 *                                     [--speed 1] [--sid abc]
 *
 * The smoke suite proves the deployment answers; this proves what a room would
 * SEE. It feeds real speech into the real engine (only getUserMedia is bypassed),
 * through the real relay and the real translation pool, and prints every line the
 * audience would receive with its timing — then states, as numbers, the three
 * things that went wrong on 2026-10-11:
 *
 *   doubled   consecutive lines that say mostly the same thing
 *   disorder  a line whose translation landed after a LATER line's
 *   late      how long a finished sentence waited before it had a translation
 *
 * WAV must be 16 kHz mono PCM16 (ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le).
 * Costs real quota: roughly one translation call per sentence.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const file = argv.find((a) => !a.startsWith("--") && fs.existsSync(a));
if (!file) { console.error("usage: node tools/replay.mjs <file.wav> [--asr gemini|whisper] [--lang en] [--speed 1]"); process.exit(2); }

const ORIGIN = flag("origin", "https://spark-live-translate.netlify.app").replace(/\/$/, "");
const ASR = flag("asr", "gemini");
const LANG = flag("lang", "auto");
const SPEED = Number(flag("speed", "1"));
const RELAY = flag("relay", "wss://spark-live-asr.lsy95112.workers.dev/asr");
const TARGET = ASR === "translate" ? "fa" : "prs";

/* ── the little of a browser the engine touches ── */
globalThis.window = { SPARK_LIVE_CONFIG: { proxy: true } };
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, init);
// The relay only accepts the site's Origin, and a Node WebSocket sends none.
const RealWS = globalThis.WebSocket;
globalThis.WebSocket = class extends RealWS {
  constructor(url, protocols) { super(url, { headers: { Origin: ORIGIN }, ...(typeof protocols === "object" && !Array.isArray(protocols) ? protocols : {}) }); }
};

const { LiveEngine, KeyPool } = await import(path.join(ROOT, "public/engine.js"));

/* ── load the audio ── */
const wav = fs.readFileSync(file);
const dataAt = wav.indexOf("data") + 8;
const pcm = new Float32Array((wav.length - dataAt) >> 1);
for (let i = 0; i < pcm.length; i++) pcm[i] = wav.readInt16LE(dataAt + i * 2) / 32768;
const seconds = pcm.length / 16000;

/* ── run ── */
const t0 = Date.now();
const at = () => (Date.now() - t0) / 1000;
const log = [];                 // every line event, in the order the audience gets it
const errors = [];
const first = new Map();        // id -> when the sentence first appeared (pending)
const done = new Map();         // id -> when its translation landed
let finals = 0;

const eng = new LiveEngine({
  proxy: true, targets: [TARGET], language: LANG, llmChain: [{ id: "proxy" }],
  asr: ASR, asrRelay: RELAY, glossary: "", context: "",
}).events({
  line: (l) => {
    const t = at();
    if (!first.has(l.id)) first.set(l.id, t);
    if (!l.pending) done.set(l.id, t);
    log.push({ t, id: l.id, pending: !!l.pending, failed: !!l.failed, src: l.src, tr: (l.tr && l.tr[TARGET]) || "" });
    const tag = l.pending ? "…   " : l.failed ? "FAIL" : "done";
    console.log(`${t.toFixed(1).padStart(6)}s  #${String(l.id).padEnd(3)} ${tag}  ${String(l.src).slice(0, 78)}`);
    if (flag("show-tr", "") && !l.pending && l.tr && l.tr[TARGET]) console.log(`                    ${TARGET}: ${String(l.tr[TARGET]).slice(0, 90)}`);
  },
  error: (e) => { errors.push({ t: at(), m: String(e && e.message || e) }); console.log(`${at().toFixed(1).padStart(6)}s  ERROR ${String(e && e.message || e).slice(0, 110)}`); },
  draft: () => {}, interim: () => {}, level: () => {},
  status: (s) => { if (s.reconnecting || s.fellBack) console.log(`${at().toFixed(1).padStart(6)}s  status ${JSON.stringify(s)}`); },
});
eng.pool = new KeyPool([]);
eng.running = true; eng.rate = 16000;
eng.lastVoiceAt = eng.lastTickAt = eng.lastAudioAt = eng.lastAsrAt = Date.now();
eng.stallWarned = false;
if (flag("debug", "") && ASR === "gemini") {
  // Print the raw evidence behind a repeated line: what was already sent, and what the final said.
  const dh = eng._dropHarvested.bind(eng), hv = eng._harvest.bind(eng);
  eng._harvest = (t) => { const before = eng._gUttEmitted; hv(t); if (eng._gUttEmitted !== before) console.log(`${at().toFixed(1).padStart(6)}s  HARVEST  sent so far: "${eng._gUttEmitted.slice(-70)}"`); };
  eng._dropHarvested = (t) => { const e = eng._gUttEmitted; const r = dh(t); console.log(`${at().toFixed(1).padStart(6)}s  FINAL    "${String(t).slice(0, 110)}"\n                   emitted(${(e.match(/\S+/g)||[]).length}w) "${e.slice(-60)}"  ->  kept "${r.slice(0, 80)}"`); return r; };
}
if (ASR === "gemini") { eng.useGemini = true; eng._startGemini(); }
if (ASR === "translate") { eng.translateMode = true; eng.useGemini = true; eng._startTranslate(); }

console.log(`replaying ${seconds.toFixed(1)}s of ${path.basename(file)} via ${ASR}${ASR === "gemini" ? " relay" : ""} at ${SPEED}x\n`);
const FRAME = 320;              // 20 ms
let off = 0;
await new Promise((resolve) => {
  const timer = setInterval(() => {
    for (let k = 0; k < SPEED && off < pcm.length; k++) { eng._audio(pcm.subarray(off, off + FRAME), 16000); off += FRAME; }
    eng._maybeTick();
    if (off >= pcm.length) { clearInterval(timer); resolve(); }
  }, 20);
});
// A short silence so the last utterance can finalise, then drain like Stop does.
const quiet = new Float32Array(FRAME);
for (let i = 0; i < 150; i++) { eng._audio(quiet, 16000); eng._maybeTick(); await new Promise((r) => setTimeout(r, 20)); }
await new Promise((r) => setTimeout(r, 4000));
await eng.drain().catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
try { eng.gasr && eng.gasr.stop(); } catch {}

/* ── what the audience got ── */
const finalLines = new Map();
for (const e of log) finalLines.set(e.id, e);
const lines = [...finalLines.values()].sort((a, b) => a.id - b.id);
const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean);
const overlap = (a, b) => {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
};

let doubled = 0;
const dupPairs = [];
for (let i = 1; i < lines.length; i++) {
  const o = overlap(lines[i - 1].src, lines[i].src);
  if (o >= 0.7 && words(lines[i].src).length >= 3) { doubled++; dupPairs.push([lines[i - 1], lines[i], o]); }
}
let disorder = 0;
const ids = [...done.keys()].sort((a, b) => a - b);
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (done.get(ids[i]) > done.get(ids[j]) + 0.001) { disorder++; break; }
const waits = ids.map((id) => done.get(id) - first.get(id)).filter((x) => x >= 0).sort((a, b) => a - b);
const pct = (p) => waits.length ? waits[Math.min(waits.length - 1, Math.floor(waits.length * p))] : 0;
const untranslated = lines.filter((l) => !l.tr).length;

console.log(`\n──────── ${lines.length} lines from ${seconds.toFixed(0)}s of speech ────────`);
console.log(`doubled     ${doubled}   consecutive lines saying mostly the same thing`);
for (const [a, b, o] of dupPairs.slice(0, 5)) console.log(`            #${a.id} "${a.src.slice(0, 55)}"\n            #${b.id} "${b.src.slice(0, 55)}"  (${(o * 100) | 0}% shared)`);
console.log(`disorder    ${disorder}   lines whose translation landed after a LATER line's`);
console.log(`late        median ${pct(0.5).toFixed(1)}s   p90 ${pct(0.9).toFixed(1)}s   max ${(waits[waits.length - 1] || 0).toFixed(1)}s   (sentence shown -> translation shown)`);
console.log(`untranslated ${untranslated}/${lines.length}`);
console.log(`errors      ${errors.length}${errors.length ? "  " + [...new Set(errors.map((e) => e.m.slice(0, 60)))].join(" | ") : ""}`);
process.exit(0);
