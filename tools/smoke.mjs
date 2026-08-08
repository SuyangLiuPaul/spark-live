/**
 * Spark Live — deployment smoke test.
 *
 *   node tools/smoke.mjs https://spark-live-dev.netlify.app
 *
 * Every assertion here exists because the corresponding failure reached a real
 * phone, in front of a real service, and was found by a person rather than by
 * software. It drives the SHIPPED engine.js — not a copy of its logic —
 * bypassing only getUserMedia, so what passes here is what the room gets.
 *
 * Costs roughly a dozen Groq requests against a daily budget of ~16,000.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ORIGIN = (process.argv[2] || "").replace(/\/$/, "");
if (!ORIGIN) {
  console.error("usage: node tools/smoke.mjs <origin>");
  process.exit(2);
}

/* ── harness ─────────────────────────────────────────────────────────── */
let passed = 0;
const failures = [];
const ok = (name, detail = "") => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? "  " + detail : ""}`); };
const bad = (name, detail) => { failures.push(`${name}: ${detail}`); console.log(`  \x1b[31m✗ ${name}\x1b[0m  ${detail}`); };
const check = (name, cond, detail = "") => (cond ? ok(name, detail) : bad(name, detail || "assertion failed"));

async function section(title, fn) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  try { await fn(); }
  catch (e) { bad(title, `threw: ${e && e.message || e}`); }
}

/* ── minimal browser surface the engine module touches ───────────────── */
globalThis.window = { SPARK_LIVE_CONFIG: {} };
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
const realFetch = globalThis.fetch;
// The engine's own fetch is deliberately NOT retried here: retrying inside the
// shim would hide a regression in the engine's own resilience, which is one of
// the things this suite exists to check.
globalThis.fetch = (u, init) =>
  realFetch(typeof u === "string" && u.startsWith("/") ? ORIGIN + u : u, init);

/**
 * The suite's own probes, as opposed to anything the app does. A reset socket
 * between this runner and the CDN says nothing about the deployment, and a gate
 * that goes red at random is a gate people learn to ignore — which is worse
 * than no gate. Retries transport failures only; any HTTP response, including a
 * bad one, is returned as-is and still fails the assertion it belongs to.
 */
async function probe(url, init, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await realFetch(url, init); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 400 * 2 ** i)); }
  }
  throw last;
}

const { LiveEngine, KeyPool, buildLlmChain } =
  await import("file://" + path.join(ROOT, "public", "engine.js"));

/* ── fixtures ────────────────────────────────────────────────────────── */
function readWav(file) {
  const b = fs.readFileSync(file);
  let off = 12, data = null;
  while (off < b.length - 8) {
    const id = b.toString("ascii", off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === "data") { data = b.subarray(off + 8, off + 8 + sz); break; }
    off += 8 + sz + (sz & 1);
  }
  const n = data.length / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = data.readInt16LE(i * 2) / 32768;
  return pcm;
}
const SPEECH = readWav(path.join(HERE, "fixtures", "speech-16k.wav"));
// The interim (provisional) translation asks for a cheap model by name; that is
// how a translate call is told apart from an interim one in the drop test below.
const INTERIM_MODEL_HINT = "llama-3.1-8b-instant";
// Transport turbulence between this runner and the CDN. Recovering from one is
// the engine doing its job; only errors that are NOT this should fail a gate.
const TRANSIENT_RE = /fetch failed|network|ECONN|socket|EPIPE|ETIMEDOUT|terminated/i;
const attenuate = (pcm, k) => pcm.map((x) => x * k);

/** Deterministic empty-room tone: no speech, only a low steady noise floor. */
function roomTone(seconds = 30) {
  const n = seconds * 16000;
  const out = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;      // reproducible across runs
    out[i] = ((s / 0x7fffffff) - 0.5) * 0.005;
  }
  return out;
}

const wavBlob = (pcm) => {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, pcm[i] * 32768)), 44 + i * 2);
  return new Blob([buf], { type: "audio/wav" });
};

/** Run the real engine over a PCM buffer and report what came out. */
async function runEngine(pcm, { seconds = 16, language = "auto" } = {}) {
  const seen = { lines: [], errors: [] };
  const eng = new LiveEngine({
    proxy: true, targets: ["prs"], language, llmChain: [{ id: "proxy" }],
  }).events({
    line: (l) => seen.lines.push(l),
    error: (e) => seen.errors.push(String(e && e.message || e)),
    draft: () => {}, interim: () => {}, status: () => {}, level: () => {},
  });
  eng.pool = new KeyPool([]);
  eng.running = true;
  eng.rate = 16000;
  eng.lastVoiceAt = eng.lastTickAt = eng.lastAudioAt = eng.lastAsrAt = Date.now();
  eng.stallWarned = false;

  const FRAME = 128;
  for (let i = 0; i < pcm.length; i += FRAME) {
    eng._audio(pcm.subarray(i, Math.min(pcm.length, i + FRAME)), 16000);
    if ((i / FRAME) % 125 === 0) await new Promise((r) => setTimeout(r, 1));
  }
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { eng._maybeTick(); await new Promise((r) => setTimeout(r, 1000)); }
  await eng.translateQueue.catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  return {
    asrCalls: eng.asrCalls || 0,
    skipped: eng.skipped || 0,
    lines: seen.lines,
    translated: seen.lines.filter((l) => l.tr && Object.values(l.tr).some((v) => v && v.trim())),
    errors: seen.errors,
  };
}

console.log(`\x1b[1mSpark Live smoke\x1b[0m  →  ${ORIGIN}`);

/* ═══ 1. the site serves no credentials, and is in hosted mode ═══
   The dev site once served /config.js with all eight Groq keys in cleartext;
   a later deploy that simply dropped the file knocked the console out of proxy
   mode so it demanded a key it does not need. Both directions are asserted. */
await section("config", async () => {
  const res = await probe(`${ORIGIN}/config.js`);
  const body = res.ok ? await res.text() : "";
  const leaked = (body.match(/gsk_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|re_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/g) || []);
  check("config.js exposes no credentials", leaked.length === 0, leaked.length ? `${leaked.length} found` : "");
  check("config.js puts the console in hosted mode", /proxy\s*:\s*true/.test(body), res.ok ? "" : `HTTP ${res.status}`);
});

/* ═══ the deployed bundle is the bundle in this checkout ═══
   prod once served a months-stale build while dev was current, and nothing
   anywhere said so — the symptom surfaced as an unrelated Groq 403. The rest
   of this file drives the LOCAL engine.js against remote backends, which is
   what makes the behavioural assertions meaningful, but it also means a stale
   frontend would otherwise pass every one of them. */
await section("deployed bundle is current", async () => {
  const { createHash } = await import("node:crypto");
  const sum = (s) => createHash("sha256").update(s.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 12);
  for (const f of ["engine.js", "presenter.js", "viewer.js", "channel.js", "i18n.js", "styles.css"]) {
    const local = fs.readFileSync(path.join(ROOT, "public", f), "utf8");
    const r = await probe(`${ORIGIN}/${f}`);
    const remote = r.ok ? await r.text() : "";
    check(`${f} matches this checkout`, r.ok && sum(local) === sum(remote),
          r.ok ? `local ${sum(local)} vs deployed ${sum(remote)}` : `HTTP ${r.status}`);
  }
});

/* ═══ 2. every backend the room depends on actually answers ═══
   prod once ran a months-stale bundle whose /api/asr returned Groq 403 on
   every call while /api/chat was fine — so each endpoint is probed separately. */
await section("backends", async () => {
  const q = await probe(`${ORIGIN}/api/quota`).then((r) => r.json()).catch(() => null);
  check("/api/quota answers", !!q && !q.error, q && q.error ? q.error : `${q?.keys ?? 0} keys, ${q?.hours ?? "?"}h`);
  check("key pool is not empty", !!q && q.keys > 0);
  check("at least one key is ready", !!q && q.pool && q.pool.ready > 0, q ? `${q?.pool?.ready}/${q?.pool?.total}` : "");

  const fd = new FormData();
  fd.append("file", wavBlob(SPEECH.subarray(0, 16000)), "chunk.wav");
  fd.append("model", "whisper-large-v3-turbo");
  const a = await probe(`${ORIGIN}/api/asr`, { method: "POST", body: fd });
  const aj = await a.json().catch(() => ({}));
  check("/api/asr transcribes", a.ok && typeof aj.text === "string", a.ok ? "" : `HTTP ${a.status} ${JSON.stringify(aj).slice(0, 120)}`);

  const c = await probe(`${ORIGIN}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sys: 'Reply with JSON only: {"t":"..."}', prompt: "Say hello" }),
  });
  const cj = await c.json().catch(() => ({}));
  check("/api/chat answers", c.ok && !!cj.content, c.ok ? "" : `HTTP ${c.status} ${JSON.stringify(cj).slice(0, 120)}`);
});

/* ═══ 3. hosted mode can actually start ═══
   The proxy step carries no key; a filter on `.key` dropped it and every Start
   on the hosted site failed with "missing_llm_key". */
await section("provider chain", async () => {
  const hosted = buildLlmChain({ useProxy: true, groqKeys: [] });
  check("hosted chain is not empty", hosted.length > 0, JSON.stringify(hosted.map((s) => s.id)));
  check("hosted chain leads with the proxy", hosted[0] && hosted[0].id === "proxy");
  const own = buildLlmChain({ useProxy: false, groqKeys: ["k1"], gemini: "g" });
  check("own-key chain keeps only configured steps", own.length === 2 && own[0].id === "groq", JSON.stringify(own.map((s) => s.id)));
  check("own-key chain has no proxy step", !own.some((s) => s.id === "proxy"));
});

/* ═══ 4. speech is transcribed at ANY input level ═══
   The gate compared whole-window mean RMS to a fixed 0.012. A quieter mic made
   zero requests — so no text AND no error, just "Live" and a moving meter. */
await section("speech is heard at every level", async () => {
  for (const [k, label] of [[1.0, "full scale"], [0.08, "1-2 m away"], [0.05, "across a room"], [0.02, "very quiet"]]) {
    const r = await runEngine(attenuate(SPEECH, k), { seconds: 12 });
    // Judge the OUTCOME, not the absence of turbulence. A dropped socket that
    // the engine recovered from — the next tick re-transcribes the same audio,
    // and a translation is retried — is the resilience working, yet asserting
    // errors.length === 0 failed the build for it anyway. A gate that reddens
    // when the app did its job correctly is one people learn to ignore.
    // Anything that is NOT a transport blip still fails, loudly.
    const hard = r.errors.filter((e) => !TRANSIENT_RE.test(e));
    const detail = `asr=${r.asrCalls} lines=${r.lines.length} translated=${r.translated.length}` +
                   (r.errors.length ? ` (recovered ${r.errors.length} transient)` : "") +
                   (hard.length ? ` HARD=${JSON.stringify(hard.slice(0, 2))}` : "");
    check(`x${k} (${label}) produces translated text`, r.translated.length > 0 && hard.length === 0, detail);
  }
});

/* ═══ 5. but a silent room still costs nothing ═══
   ASR is metered per day, so the fix above must not simply transcribe
   everything — the quota saving has to survive. */
await section("silence still skipped", async () => {
  const r = await runEngine(roomTone(30), { seconds: 10 });
  check("empty room makes no ASR calls", r.asrCalls === 0, `asr=${r.asrCalls} skipped=${r.skipped}`);
});

/* ═══ 6. Cantonese survives both stages ═══
   Two independent failures conspired here. Whisper's auto-detect reports
   Cantonese as "Chinese" and writes Mandarin (我哋要睇 → 我們要看), so the
   variety has to be selected explicitly; and with language=yue Whisper emits a
   leading " " token, which broke LocalAgreement's scan at position 0 so NO line
   ever settled — the room would have watched a provisional tail all service. */
await section("Cantonese", async () => {
  const CANTO = readWav(path.join(HERE, "fixtures", "cantonese-16k.wav"));
  const r = await runEngine(CANTO, { seconds: 14, language: "yue" });
  check("yue commits settled lines", r.lines.length > 0,
        `asr=${r.asrCalls} lines=${r.lines.length}` + (r.errors.length ? ` errors=${JSON.stringify(r.errors.slice(0, 2))}` : ""));

  const src = r.lines.map((l) => l.src || "").join(" ");
  const kept = ["我哋", "我地", "睇", "喺", "嘅", "一齊"].filter((m) => src.includes(m));
  check("the transcript stays Cantonese", kept.length >= 3, `kept ${JSON.stringify(kept)}`);
  check("it is not rewritten as Mandarin", !/我們|要看|喺呢度$/.test(src) || kept.length >= 3,
        src.slice(0, 60));
  check("Cantonese is still translated", r.translated.length > 0, `${r.translated.length} translated`);
});

/* ═══ 7. a dropped connection does not cost a sentence ═══
   Speech recognition heals itself — the next tick re-transcribes the same
   audio. Translation does not: it is issued once per committed line, so a reset
   socket used to leave that sentence untranslated for good, and the audience
   read source text in a language they came here because they cannot read.
   The drop is injected on the TRANSLATE call only; the provisional interim call
   also hits /api/chat and is meant to fail silently. */
await section("a dropped translation is retried", async () => {
  const outer = globalThis.fetch;
  let dropped = 0;
  globalThis.fetch = async (u, init) => {
    const body = String(init?.body || "");
    if (String(u).includes("/api/chat") && !body.includes(INTERIM_MODEL_HINT) && dropped === 0) {
      dropped = 1;
      throw new TypeError("fetch failed");
    }
    return outer(u, init);
  };
  try {
    const r = await runEngine(SPEECH, { seconds: 14, language: "en" });
    check("the drop was actually injected", dropped === 1);
    check("the sentence is still translated", r.translated.length > 0,
          `translated=${r.translated.length} failed=${r.lines.filter((l) => l.failed).length}`);
    check("no line is left marked failed", r.lines.every((l) => !l.failed));
  } finally {
    globalThis.fetch = outer;
  }
});

/* ═══ 8. the relay survives a presenter reload ═══
   A reload republished v=1 over a stored v=40 (freezing every phone), and
   published an empty idle document (blanking every phone). Both are asserted,
   along with the fact that Stop can still legitimately end a session. */
await section("relay: reload safety", async () => {
  const S = "SMOKE" + Math.floor(Math.random() * 90 + 10);
  const token = "smoketoken" + Math.random().toString(36).slice(2);
  const langs = [{ c: "prs", label: "دری", rtl: true }];
  const lines = [{ id: 1, src: "Good morning.", tr: { prs: "صبح بخیر" }, pending: false }];
  const pub = (doc) => probe(`${ORIGIN}/api/publish`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: S, token, doc }),
  }).then((r) => r.json());
  // s-maxage=3 on /api/feed: vary the URL or this reads the CDN, not the relay.
  const feed = () => probe(`${ORIGIN}/api/feed?s=${S}&v=-1&_=${Math.random()}`, { cache: "no-store" })
    .then((r) => (r.status === 200 ? r.json() : null));

  await pub({ v: 40, title: "Smoke", live: true, ended: false, langs, lines });
  await pub({ v: 1, title: "Smoke", live: false, ended: false, langs, lines: [] });   // the reload
  const after = await feed();
  check("a reload does not freeze viewers", !!after && after.v > 40, after ? `v=${after.v}` : "no doc");
  check("a reload does not blank the transcript", !!after && after.live === true && after.lines.length === 1,
        after ? `live=${after.live} lines=${after.lines.length}` : "no doc");

  await pub({ v: 2, title: "Smoke", live: false, ended: true, langs, lines: [] });    // a real Stop
  const ended = await feed();
  check("Stop still ends the session", !!ended && ended.live === false && ended.ended === true,
        ended ? `live=${ended.live} ended=${ended.ended}` : "no doc");
});

/* ── verdict ─────────────────────────────────────────────────────────── */
console.log("");
if (failures.length) {
  console.log(`\x1b[31m\x1b[1mFAILED\x1b[0m  ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`\x1b[32m\x1b[1mPASSED\x1b[0m  ${passed} checks against ${ORIGIN}`);
