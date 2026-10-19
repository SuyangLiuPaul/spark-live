import { LiveEngine, LANGS, SOURCE_LANGS, listInputs, buildLlmChain } from "./engine.js";
import { t, applyI18n, mountUiSwitch } from "./i18n.js";
import { createPublisher } from "./channel.js";
import { createWakeLock, createConnection, createToast, micErrorMessage, createReporter, isExtensionOrigin } from "./resilience.js";

const $ = (id) => document.getElementById(id);
const LS = {
  get: (k, d = "") => { try { return localStorage.getItem("live." + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("live." + k, v); } catch {} },
};

/* ── session identity ── */
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";      // no I/O/0/1 — read aloud safely
const rand = (n) => Array.from({ length: n }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");

let session = LS.get("session") || rand(6);
let token = LS.get("token") || (rand(8) + rand(8));
LS.set("session", session); LS.set("token", token);

let qrcodeLib = null;
const joinUrlFor = (c) => `${location.origin}/join/${c}`;

async function paintSession() {
  $("code").value = session;
  $("joinUrl").textContent = joinUrlFor(session);
  // Vendored locally: this used to come from jsdelivr, and church-hall networks
  // block third-party CDNs often enough that the QR would silently vanish from
  // the screen the congregation is supposed to scan.
  try {
    if (!qrcodeLib) qrcodeLib = (await import("./vendor/qrcode.js")).default;
    const qr = qrcodeLib(0, "M");
    qr.addData(joinUrlFor(session));
    qr.make();
    $("qr").innerHTML = qr.createImgTag(4, 8);
  } catch { $("qr").style.display = "none"; }
}
paintSession();

/**
 * The code is editable so a congregation can keep ONE permanent link
 * (e.g. /join/SUNDAY). Publishing claims it with this device's token; another
 * device holding a different token gets 409 and we say so plainly.
 */
$("code").addEventListener("change", async () => {
  const next = ($("code").value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (engine && doc.live) { $("code").value = session; $("codeMsg").textContent = t("codeLocked"); return; }
  if (!/^[A-Z0-9]{4,12}$/.test(next)) { $("code").value = session; $("codeMsg").textContent = t("codeInvalid"); return; }
  if (next === session) return;
  session = next;
  LS.set("session", session);
  publisher = createPublisher({ session, token });
  await paintSession();
  $("codeMsg").textContent = t("codeSaved");
});

$("copyBtn").onclick = async () => {
  // `joinUrl` here used to be a bare identifier with no declaration, which
  // silently resolved to window.joinUrl — the <div id="joinUrl"> element — so
  // the clipboard received "[object HTMLDivElement]". Always build it.
  const url = joinUrlFor(session);
  try {
    await navigator.clipboard.writeText(url);
    $("copyBtn").textContent = t("copied");
    toast(t("copied"));
  } catch {
    $("copyBtn").textContent = t("copyManual");
    toast(t("copyManual"), "bad");
  }
  setTimeout(() => ($("copyBtn").textContent = t("copyLink")), 1600);
};
$("openBtn").onclick = () => window.open(`./view.html?s=${session}`, "_blank");

/* ── settings: config.js defaults → localStorage overrides → live edits ── */
const CFG = window.SPARK_LIVE_CONFIG || {};
// Relay URL for Gemini streaming ASR. Not a secret (the key lives in the
// Worker), so it ships in config.js like any other setting.
const ASR_RELAY = String(CFG.asrRelay || "").trim();

// Built from SOURCE_LANGS rather than hardcoded in the markup, so adding a
// speaker language is one table entry. Must run before the restore loop below,
// or a saved choice has no matching <option> to select.
$("lang").innerHTML = Object.entries(SOURCE_LANGS)
  .map(([code, d]) => `<option value="${code}"${code === "auto" ? ' data-i18n="srcAuto"' : ""}>${
    code === "auto" ? "Auto-detect" : d.label}</option>`).join("");

// A pre-configured pool arrives as an array; the extra keys fill the textarea.
const PRESET_POOL = Array.isArray(CFG.groqKeys) ? CFG.groqKeys.filter(Boolean) : [];
for (const id of ["title", "context", "glossary", "groqKey", "groqKeys2", "geminiKey", "kimiKey", "glmKey", "lang", "asrEngine"]) {
  const el = $(id);
  const saved = LS.get(id);
  const preset = id === "groqKeys2" ? PRESET_POOL.slice(1).join("\n")
               : id === "groqKey"   ? (CFG.groqKey || PRESET_POOL[0] || "")
               : CFG[id] ?? CFG.defaults?.[id] ?? "";
  el.value = saved || preset || el.value;
  el.addEventListener("change", () => { LS.set(id, el.value); if (id.startsWith("groq")) readiness(); });
  el.addEventListener("blur", () => LS.set(id, el.value));
}

/* Human review: a person approves each line before the room sees it. A function
   declaration (hoisted) because syncAsrOption() below already needs it. */
function reviewOn() { const el = $("reviewOn"); return !!(el && el.checked); }
$("reviewOn").checked = LS.get("review") === "1";
$("reviewAuto").value = LS.get("reviewAuto") || "0";

/* Gemini is the DEFAULT engine as of 2026-08-31. Measured on the same 120 s of
   real Cantonese, Whisper wrote 「他是需要想的」 where the speaker said
   「佢係需要唞嘅」, so Whisper-by-default was shipping the congregation the worse
   transcript unless someone remembered to switch.

   Changing the markup order alone would reach nobody: the restore loop above
   reads localStorage first, so every presenter who has ever run a service keeps
   "whisper" forever. One stamped reset moves them across, after which the
   choice is theirs again — the same reason TARGETS_STAMP exists. */
const ASR_STAMP = "2026-08-31-gemini-default";
if (LS.get("asrStamp") !== ASR_STAMP) {
  LS.set("asrStamp", ASR_STAMP);
  $("asrEngine").value = "gemini";
  LS.set("asrEngine", "gemini");
}

/* Streaming ASR opens its WebSocket from THIS page, so it is only selectable
   when there is a relay to reach or a key in this browser. Leaving the option
   enabled without either would quietly run Whisper instead — the presenter
   would be told they had picked Gemini and get Whisper's Cantonese, which is
   the exact failure this was meant to fix. Disable it and say why instead. */
function syncAsrOption() {
  const sel = $("asrEngine");
  if (!sel) return;
  // Two ways to be usable. The relay is the one that makes a zero-setup site
  // possible: the key lives in the Worker, so nobody types anything here.
  const usable = !!ASR_RELAY || !!$("geminiKey").value.trim();
  for (const v of ["gemini", "translate"]) {
    const opt = sel.querySelector(`option[value="${v}"]`);
    if (opt) opt.disabled = !usable;
  }
  if (!usable && sel.value !== "whisper") { sel.value = "whisper"; LS.set("asrEngine", "whisper"); }
  const hint = $("asrHint");
  if (hint) hint.textContent = sel.value === "translate" && usable && reviewOn() ? t("reviewNoTranslate")
                             : sel.value === "translate" && usable ? t("asrHintTranslate")
                             : ASR_RELAY ? t("asrHintRelay")
                             : usable ? t("asrHintReady") : t("asrHintNeedKey");
  // The source-language advice depends on the engine too. Measured 2026-08-31
  // on the same Cantonese: auto-detect through Gemini kept 12 Cantonese-only
  // characters against 11 when the language was named — it does NOT flatten to
  // Mandarin the way Whisper does. Telling presenters otherwise would push them
  // to change a setting that is already right.
  const srcHint = $("srcLangHint");
  if (srcHint) srcHint.textContent = sel.value !== "whisper" ? t("srcLangHint")
                                                            : t("srcLangHintWhisper");
}
$("geminiKey").addEventListener("input", syncAsrOption);
$("asrEngine").addEventListener("change", syncAsrOption);
// The engine decides the room's language in translate mode, so the picker, the
// operator's preview and the published document follow a change. This runs only on
// a user's change, never during page load: syncAsrOption() is first called before
// `targets` and `engine` exist, and touching a `let` that early throws.
$("asrEngine").addEventListener("change", () => {
  renderLangPick(); renderPreviewLang(); renderLines();
  if (!engine) announceIdle();
});
syncAsrOption();

/** True when the site carries a server-side key pool (hosted, no key entry). */
const HOSTED = !!CFG.proxy;
if (HOSTED) {
  // Otherwise the panel prominently demands a key the site does not need.
  $("hostedNotice").hidden = false;
  $("groqHint").setAttribute("data-i18n", "groqHintHosted");
}

/* ── pre-flight quota ─────────────────────────────────────────────────
   Answers "will I get through this service?" while there is still time to add
   a key or drop a language. Deliberately NOT a live counter: during a session
   the number moves on its own and the only useful response — rotating keys —
   is already automatic, so a ticking gauge would be anxiety with no action. */
async function showQuota() {
  const el = $("quotaHint");
  if (!el) return;

  // Show it whenever we can get a trustworthy number — the old check was
  // "hosted mode?", which hid it on the dev rig even though that site has the
  // same pool behind the same endpoint. The condition that actually matters is
  // whether the keys the session will USE are the ones /api/quota reports on.
  //
  // Pre-filled keys (dev's config.js) are the pool, so the number is right. A
  // key the operator typed themselves is NOT, and reporting the service pool's
  // remaining hours for someone spending their own quota would be a lie.
  const typed = groqPool().filter((k) => !PRESET_POOL.includes(k));
  if (typed.length) { el.textContent = ""; return; }

  try {
    const q = await (await fetch("/api/quota")).json();
    if (!q || typeof q.hours !== "number") return;
    const h = q.hours;
    // ~2h covers a long service; below that the operator needs to know now.
    el.className = h < 2 ? "hint warn" : "hint";
    el.textContent = h < 2 ? t("quotaLow", h) : t("quotaOk", h);
    reporter.setQuota(`${h}h remaining, ${q.keys} keys`);
    // A cold function has no observations yet — say so rather than imply precision.
    if (!q.measured) el.textContent += " " + t("quotaEstimate");
  } catch { /* the pill and banner already report an unreachable relay */ }
}

/** Every Groq key the operator has given us, primary first, de-duplicated. */
function groqPool() {
  const extra = $("groqKeys2").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return [...new Set([$("groqKey").value.trim(), ...extra].filter(Boolean))];
}

// Tell the operator what's ready without making them open anything.
function readiness() {
  const have = ["groqKey", "geminiKey", "kimiKey", "glmKey"].filter((k) => $(k).value.trim());
  const names = { groqKey: "Groq", geminiKey: "Gemini", kimiKey: "Kimi", glmKey: "GLM" };
  const hint = $("readyHint");
  if (HOSTED && !$("groqKey").value.trim()) {
    hint.textContent = t("readyHosted");
  } else if (!$("groqKey").value.trim()) {
    // Left closed on purpose — the hint says where to go, and force-opening a
    // long settings panel on every load buries the Start button.
    hint.textContent = t("needGroq");
  } else {
    const n = groqPool().length;
    hint.textContent = t("ready", have.map((k) => names[k]).join(" → ")) +
                       (n > 1 ? ` · ${t("keyPool", n)}` : "");
  }
}
readiness();

/* Publish an "not started yet" document as soon as the console opens.
   Until now nothing existed server-side until Start was pressed, so previewing
   the audience view — or sharing the link ahead of the service — showed
   "Session not found", which reads as a broken app. This also claims the code
   with our token before anyone else can take it. */
function announceIdle() {
  doc.title = $("title").value.trim() || "Spark Live";
  doc.langs = langsOf(liveTargets());
  renderDlLangs();
  doc.live = false;
  doc.ended = false;
  schedulePush();
}

/**
 * Come back from a reload without the room noticing.
 *
 * A presenter's page can go away mid-service for reasons that have nothing to
 * do with them: an accidental refresh, iOS reclaiming a backgrounded tab, a
 * laptop waking up unhappy. Before this, reopening the console published an
 * idle document and every phone in the room fell back to "not started".
 *
 * So: ask the relay what it already holds for our code first. If a session is
 * still marked live and was updated recently, adopt it — same code, same
 * token, transcript restored — and offer Resume rather than Start. Capture
 * cannot restart without a user gesture (the AudioContext needs one), which is
 * exactly why this is a button and not automatic.
 */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

async function adoptLiveSession() {
  let stored = null;
  try {
    const res = await fetch(`/api/feed?s=${encodeURIComponent(session)}&v=-1`, { cache: "no-store" });
    if (res.ok) stored = await res.json();
  } catch { /* offline: fall through to the local mirror */ }

  // The relay is authoritative, but a venue with no signal at the wrong moment
  // shouldn't cost the transcript either.
  if (!stored || !stored.live) stored = readLocalMirror();
  if (!stored || !stored.live) return false;
  if (Date.now() - (Number(stored.updatedAt) || 0) > RESUME_WINDOW_MS) return false;

  doc.title = String(stored.title || doc.title);
  doc.langs = Array.isArray(stored.langs) ? stored.langs : doc.langs;
  doc.lines = (Array.isArray(stored.lines) ? stored.lines : [])
    // A line still pending here was waiting on the OLD tab's translation
    // queue, which is gone; it would stay pending forever, and the audience
    // view hides untranslated pending lines. Settle it as failed so the source
    // text is at least on screen.
    .map((l) => (l && l.pending ? { ...l, pending: false, failed: true } : l));
  doc.startedAt = Number(stored.startedAt) || Date.now();
  doc.live = true;
  doc.ended = false;
  // Bring the whole transcript back, not just the 120 lines the relay keeps —
  // otherwise a mid-service reload silently truncates the download.
  try {
    const f = JSON.parse(LS.get("full") || "null");
    if (f && f.session === session && Array.isArray(f.lines)) {
      all.length = 0;
      for (const l of f.lines) all.push(l.pending ? { ...l, pending: false, failed: true } : l);
      markSeq = all.reduce((m, l) => Math.max(m, /^m(\d+)$/.test(String(l.id)) ? +String(l.id).slice(1) : 0), 0);
    }
  } catch { /* the capped copy in doc.lines is still there */ }
  if (!all.length) for (const l of doc.lines) all.push(l);
  mark("resumed", t("markResumed"));
  if (doc.title) $("title").value = doc.title;

  renderLines();
  renderDlLangs();
  $("setupPanel").style.display = "none";
  $("livePanel").style.display = "";
  $("dot").className = "dot";
  $("statePill").textContent = t("stateInterrupted");
  $("statePill").className = "pill";
  $("resumeBar").hidden = false;
  $("stopBtn").style.display = "none";
  toast(t("resumeFound"), "bad");
  return true;
}

/* Mirror of the published document, so a reload can restore the transcript
   even when the relay is unreachable. Throttled by schedulePush's own 400 ms
   batching, and capped by the same 120-line bound the relay applies. */
function writeLocalMirror() {
  try {
    LS.set("mirror", JSON.stringify({
      session, title: doc.title, langs: doc.langs, lines: doc.lines.slice(-120),
      live: doc.live, startedAt: doc.startedAt, updatedAt: Date.now(),
    }));
  } catch { /* private mode, or quota — the relay copy still covers us */ }
  // The full transcript is written SEPARATELY and second, on purpose. It is
  // the big one and the only one that can plausibly hit the quota, and if it
  // does it must not take the small resume mirror down with it — losing the
  // download is bad, losing the ability to resume mid-service is worse.
  try {
    LS.set("full", JSON.stringify({ session, lines: all }));
  } catch {
    try { LS.set("full", JSON.stringify({ session, lines: all.slice(-Math.ceil(all.length / 2)), clipped: true })); }
    catch { /* nothing more to give up */ }
  }
}
function readLocalMirror() {
  try {
    const m = JSON.parse(LS.get("mirror") || "null");
    return m && m.session === session ? m : null;
  } catch { return null; }
}

/* ── target languages ── */
const DEFAULT_TARGETS = ["zh-Hans", "prs", "vi"];
// Changing the default alone would NOT have reached anyone: `targets` is read
// from localStorage first, so every presenter who had already run a service
// would have kept their old set (the last real service ran en/vi/zh-Hans) and
// the change would look like it silently did nothing. The stamp forces exactly
// one reset onto the new default, after which the picker is theirs again.
const TARGETS_STAMP = "2026-08-17-zh-prs-vi";
let targets = (() => {
  try {
    if (LS.get("targetsStamp") === TARGETS_STAMP) {
      const v = JSON.parse(LS.get("targets") || "null");
      if (Array.isArray(v) && v.length) return v.slice(0, 3);
    }
  } catch {}
  LS.set("targetsStamp", TARGETS_STAMP);
  LS.set("targets", JSON.stringify(DEFAULT_TARGETS));
  return DEFAULT_TARGETS.slice();
})();
/* Live Translate produces ONE language, Persian, and not Dari ("fa-AF" and "prs"
   are refused by the model). While it is the engine, that is the language the room
   gets, whatever is ticked below; the ticks are kept for when Whisper or Transcribe
   Live is chosen again. */
// Live Translate hears and translates in one step, so there is no sentence for a person
// to check in between: with review on, the session uses Transcribe Live instead.
const isTranslate = () => $("asrEngine") && $("asrEngine").value === "translate" && !reviewOn();
const liveTargets = () => (isTranslate() ? ["fa"] : targets);
const langsOf = (list) => list.map((c) => ({ c, label: LANGS[c].label, rtl: !!LANGS[c].rtl }));

function renderLangPick() {
  $("langpick").innerHTML = Object.entries(LANGS)
    .map(([c, d]) => `<button data-c="${c}" lang="${d.rtl ? "prs" : c}" class="${targets.includes(c) ? "on" : ""}">${d.label}</button>`).join("");
  for (const b of $("langpick").querySelectorAll("button")) {
    b.onclick = () => {
      if (isTranslate()) { $("langHint").textContent = t("translateFixed"); return; }
      const c = b.dataset.c;
      if (targets.includes(c)) targets = targets.filter((x) => x !== c);
      else if (targets.length < 3) targets.push(c);
      else { $("langHint").textContent = t("maxLangs"); return; }
      if (!targets.length) targets = ["prs"];
      LS.set("targets", JSON.stringify(targets));
      renderLangPick(); renderPreviewLang();
      if (!engine) announceIdle();          // pre-start: keep viewers in sync
      // Mid-session edits apply to NEW lines; already-translated lines keep what
      // they have (re-translating history would be a surprise cost).
      if (engine) {
        engine.cfg.targets = targets.slice();
        doc.langs = targets.map((c) => ({ c, label: LANGS[c].label, rtl: !!LANGS[c].rtl }));
  renderDlLangs();
        renderLines(); schedulePush();
      }
    };
  }
  syncLangScrollHint();
  const names = targets.map((c) => LANGS[c].en).join(" · ");
  $("langHint").textContent = isTranslate() ? t("translateFixed")
    : targets.length >= 3 ? t("langWarn", names) : t("langNote", names);
}
/* Only fade the bottom edge when the list actually scrolls — a short list
   would otherwise have its last row faded for no reason. Re-checked on resize
   and rotation, since whether it overflows depends entirely on width. */
function syncLangScrollHint() {
  const lp = $("langpick");
  if (!lp) return;
  // Measured synchronously on purpose: requestAnimationFrame never fires in a
  // hidden tab, so a page opened in the background would render without the
  // hint and stay wrong until something resized. Reading scrollHeight forces
  // the layout we need anyway.
  lp.classList.toggle("scrollable", lp.scrollHeight > lp.clientHeight + 1);
}
if (typeof ResizeObserver === "function") {
  new ResizeObserver(syncLangScrollHint).observe($("langpick"));
}
window.addEventListener("orientationchange", syncLangScrollHint);

/* ── microphone picker ───────────────────────────────────────────────
   A laptop plugged into a sound desk still defaults to the built-in mic,
   which records the room instead of the PA feed. Device labels are only
   revealed after mic permission, so before that we say so rather than
   presenting a list of blanks. */
let micId = LS.get("micId") || "";

async function renderMics() {
  const sel = $("mic");
  const { devices, labelled } = await listInputs();
  if (!devices.length) {
    sel.innerHTML = `<option value="">${t("micDefault")}</option>`;
    $("micHint").textContent = t("micNoList");
    return;
  }
  // A remembered device that has been unplugged shouldn't look selected.
  if (micId && !devices.some((d) => d.deviceId === micId)) micId = "";
  sel.innerHTML =
    `<option value="">${t("micDefault")}</option>` +
    devices.map((d, i) =>
      `<option value="${d.deviceId}"${d.deviceId === micId ? " selected" : ""}>${
        esc(d.label || t("micNumbered", i + 1))}</option>`).join("");
  $("micHint").textContent = labelled ? t("micPickHint") : t("micNamesHidden");
}

$("mic").addEventListener("change", () => {
  micId = $("mic").value;
  LS.set("micId", micId);
  if (engine) toast(t("micChangeRestart"), "bad");
});

// Someone plugging in an interface mid-setup should see it appear.
navigator.mediaDevices?.addEventListener?.("devicechange", renderMics);
renderMics();

mountUiSwitch($("uiSwitch"));
applyI18n();
renderLangPick();

/* Which target language the OPERATOR sees in their own console. */
let previewLang = LS.get("previewLang") || "";
function activePreview() {
  const list = liveTargets();
  return list.includes(previewLang) ? previewLang : list[0];
}
function renderPreviewLang() {
  const el = $("previewLang");
  if (!el) return;
  const cur = activePreview();
  el.style.display = liveTargets().length > 1 ? "" : "none";
  el.innerHTML = liveTargets().map((c) =>
    `<button class="iconbtn lang ${c === cur ? "on" : ""}" data-c="${c}" lang="${LANGS[c].rtl ? "prs" : c}">${LANGS[c].label}</button>`).join("");
  for (const b of el.querySelectorAll(".lang")) b.onclick = () => {
    previewLang = b.dataset.c; LS.set("previewLang", previewLang);
    renderPreviewLang(); renderLines(); renderDraft();
  };
}
window.addEventListener("ui:lang", () => {
  applyI18n(); renderLangPick(); renderPreviewLang(); readiness();
  syncAsrOption();   // its hint has two states, so applyI18n cannot own it
  $("copyBtn").textContent = t("copyLink");
  renderDlLangs();
  if (doc.lines.length) renderLines();
});

/* ── resilience ── */
const wake = createWakeLock();
const reporter = createReporter({ session, hosted: HOSTED });
const toast = createToast();
const conn = createConnection({
  onChange: ({ online }) => {
    document.body.classList.toggle("offline", !online);
    if (!online) toast(t("offline"), "bad");
    else if (engine && engine.running) toast(t("backOnline"), "ok");
    // Only while a service is running: a blip on the setup screen is not a
    // hole in anybody's recording.
    if (engine && doc.live) mark(online ? "on" : "off", t(online ? "markOnline" : "markOffline"));
  },
});

/* ── state ── */
const doc = {
  v: 0, title: "", live: false, ended: false, draft: "", interim: "",
  langs: [], startedAt: Date.now(), lines: [],
};

/* THE WHOLE SERVICE. `doc.lines` is the publish payload and is deliberately
   capped at 120 so the relay document stays small — but that cap was also the
   only copy the presenter kept, so the transcript file it wrote out held the
   last 120 lines and nothing else. On 2026-09-13 a 70-minute sermon downloaded
   as 120 lines and the rest was simply gone. This array is never trimmed; the
   downloads read from here, the relay still gets the tail. */
const all = [];
let markSeq = 0;

function record(line) {
  const i = all.findIndex((x) => x.id === line.id);
  if (i >= 0) all[i] = line; else all.push(line);
}

/**
 * Put a marker in the transcript — "the connection dropped here".
 *
 * The presenter already saw "Publish failed Failed to fetch" on screen during
 * the 2026-09-13 service, but that is a transient error message: by the time
 * anyone edits the recording on Monday there is nothing in the file saying
 * where the gap was. A marker is a line like any other, so it carries a
 * timestamp, survives into the file, and lands in the right place in the
 * order things happened.
 *
 * It is NOT sent to the room: the audience does not need to be told the
 * presenter's wifi blinked, and `viewer.js` filters marks out.
 */
function mark(kind, text) {
  const last = all[all.length - 1];
  if (last && last.mark && last.markKind === kind) return;   // don't stutter
  const line = { id: `m${++markSeq}`, mark: true, markKind: kind,
                 src: text, tr: {}, t: Date.now() };
  record(line);
  doc.lines.push(line);
  renderLines();
  schedulePush();
}
let publisher = createPublisher({ session, token });
let asrDown = false;
let asrDownTimer = null;
// The relay's audio-gap buffer already replays up to 90 s of held audio once
// it reconnects (see gemini-asr.js's GAP_MAX_SAMPLES), so a blip shorter than
// this is not actually a loss — just a beat of delay the replay makes up.
// Marking every one of those anyway is what turned a real but recoverable
// service into a transcript that "doesn't seem usable, too many breaks":
// reported 2026-09-27, a run of drop/reconnect pairs seconds apart, most of
// them well under this window. Only a gap that outlasts it gets the marker.
const ASR_MARK_DEBOUNCE_MS = 3000;
let engine = null;
let pushTimer = null;

function schedulePush() {
  if (pushTimer) return;
  // Batch rapid updates into ~400 ms so a burst of corrections is one request.
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    doc.v += 1;
    writeLocalMirror();
    try { await publisher.push(doc); }
    catch (e) {
      conn.report(false); showErr(t("publishFail") + e.message);
      // Only once the connection has genuinely given up — a single failed push
      // during a blip is not an incident.
      if (!conn.online) reporter.report("publish_failed", "audience stopped receiving", e.message);
    }
  }, 400);
}

const showErr = (m) => { $("err").textContent = m || ""; };

// What the recogniser is hearing right now. The operator always sees it; the room
// only does when review is off, because with review on nothing unapproved goes out.
let localDraft = "";
function renderDraft() {
  const primary = activePreview();
  const rtl = (LANGS[primary] || {}).rtl;
  $("draft").innerHTML = doc.interim
    ? `<div class="${rtl ? "rtl" : ""}" style="color:var(--warn)">${esc(doc.interim)}</div>
       <div style="opacity:.6;margin-top:2px">${esc(localDraft)}</div>`
    : esc(localDraft) || "…";
}
function renderLines() {
  const primary = activePreview();
  const rtl = (LANGS[primary] || {}).rtl;
  $("lines").innerHTML = doc.lines.slice(-25).reverse().map((l) => {
    if (l.mark) return `<div class="line mark"><div class="src">— ${esc(l.src)} —</div></div>`;
    const main = (l.tr && l.tr[primary]) || "";
    return `<div class="line ${l.pending ? "pending" : ""} ${l.failed ? "failed" : ""}">
      <div class="dari ${rtl ? "rtl" : ""}" lang="${rtl ? "prs" : primary}">${esc(main) || (l.pending ? t("translating") : "—")}</div>
      <div class="src">${esc(l.src)}</div>
      ${l.heard ? `<div class="heard">${esc(t("heardLabel"))} ${esc(l.heard)}</div>` : ""}
    </div>`;
  }).join("");
}
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* The top bar is sticky, so Settings is reachable at any scroll position and in
   any state — previously it only existed inside the live panel. */
$("topSettingsBtn").onclick = () => {
  const adv = $("advPanel");
  adv.open = !adv.open;
  if (adv.open) adv.scrollIntoView({ behavior: "smooth", block: "start" });
};

/* ── key test ── */
$("testBtn").onclick = async () => {
  // Result goes NEXT TO THE BUTTON. It used to write to #setupMsg up beside the
  // Start button, so from inside the collapsed Advanced panel it looked dead.
  const msg = $("keyMsg");
  const btn = $("testBtn");
  btn.disabled = true;
  msg.textContent = t("testing");

  // Probe every key in the Groq pool — one dud among four is otherwise invisible.
  const pool = groqPool();
  const groqResults = await Promise.all(pool.map(async (k) => {
    try { return (await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${k}` } })).ok; }
    catch { return false; }
  }));
  const okCount = groqResults.filter(Boolean).length;

  const probes = [
    ["geminiKey", "Gemini", (k) => fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`)],
    ["kimiKey",   "Kimi",   (k) => fetch("https://api.moonshot.ai/v1/models", { headers: { Authorization: `Bearer ${k}` } })],
    ["glmKey",    "GLM",    (k) => fetch("https://api.z.ai/api/coding/paas/v4/models", { headers: { Authorization: `Bearer ${k}` } })],
  ];

  const out = [];
  if (HOSTED) {
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "ping", sys: "Reply {\"ok\":1}" }),
      });
      out.push(`Hosted ${r.ok ? "✓" : "✗" + r.status}`);
    } catch { out.push("Hosted ✗net"); }
  }
  out.push(pool.length
    ? `Groq ${okCount}/${pool.length} ${okCount === pool.length ? "✓" : "✗"}`
    : "Groq —");
  for (const [id, label, run] of probes) {
    const key = $(id).value.trim();
    if (!key) continue;
    try {
      const r = await run(key);
      out.push(`${label} ${r.ok ? "✓" : "✗" + r.status}`);
    } catch {
      // A browser-side failure here is almost always CORS, not a bad key.
      out.push(`${label} ✗net`);
    }
  }
  msg.textContent = out.join("  ·  ");
  btn.disabled = false;
};

/* ── start / stop ── */
/**
 * Bring the microphone up and go live.
 *
 * `resume` means the console is rejoining a session that is already published
 * and already being read: the code, token, transcript and start time all stay
 * as they are, and only the capture side is rebuilt.
 */
async function beginCapture({ resume = false } = {}) {
  const groqKeys = groqPool();
  // Hosted deployments need no key: the proxy holds the pool server-side. A key
  // typed here still wins, so a presenter can spend their own quota if they want.
  const useProxy = HOSTED && !groqKeys.length;
  if (!useProxy && !groqKeys.length) { $("setupMsg").textContent = t("noGroq"); return; }

  // See buildLlmChain in engine.js — the ordering and the proxy-has-no-key
  // subtlety live there so tools/smoke.mjs can assert them without a DOM.
  const llmChain = buildLlmChain({
    useProxy, groqKeys,
    gemini: $("geminiKey").value.trim(),
    kimi:   $("kimiKey").value.trim(),
    glm:    $("glmKey").value.trim(),
  });

  engine = new LiveEngine({
    groqKey: groqKeys[0], groqKeys, proxy: useProxy, deviceId: micId, llmChain,
    // In Live Translate mode this is ["fa"]: the session itself translates into it,
    // and if it fails the Whisper fallback translates into the SAME language.
    targets: liveTargets().slice(), translateTo: "fa",
    // Streaming ASR when there is a way to reach Gemini at all — either the
    // relay (key server-side, nothing typed here) or this browser's own key.
    // The engine falls back to Whisper on its own if the socket is ever
    // rejected, so a bad key or a dead relay degrades the transcript rather
    // than ending the service.
    asr: !["gemini", "translate"].includes($("asrEngine").value) || !(ASR_RELAY || $("geminiKey").value.trim())
      ? "whisper"
      : isTranslate() ? "translate" : "gemini",
    review: reviewOn(),
    reviewAutoMs: Number($("reviewAuto").value) || 0,
    asrRelay: ASR_RELAY,
    geminiKey: $("geminiKey").value.trim(),
    language: $("lang").value,
    glossary: $("glossary").value.trim(),
    context: $("context").value.trim(),
  }).events({
    level: (v) => { $("meterBar").style.width = Math.round(v * 100) + "%"; },
    draft: (t) => {
      localDraft = t || "";
      renderDraft();
      const pub = reviewOn() ? "" : localDraft;
      if (pub !== doc.draft) { doc.draft = pub; schedulePush(); }
    },
    review: (list) => renderReview(list),
    interim: (t) => { doc.interim = t || ""; renderDraft(); schedulePush(); },
    error: (e) => {
      const msg = String(e && e.message ? e.message : e);
      // Two stages. The presenter is told at once, because they are the only
      // one who can look at the cable; we are told only if the engine's own
      // recovery failed to bring the room back, because a screen that slept
      // and woke is not an incident.
      if (msg === "audio_stalled") {
        showErr(t("micStalled")); toast(t("micStalled"), "bad");
        return;
      }
      if (msg === "mic_changed") {
        showErr(t("micChanged")); toast(t("micChanged"), "bad");
        reporter.report("mic_stalled", t("micChanged"), "recovered onto a different input device");
        return;
      }
      if (msg === "audio_stalled_persists") {
        reporter.report("mic_stalled", t("micStalled"),
          e.detail || "no audio from the input for 20s");
        return;
      }
      if (e && e.exhausted) {
        // Two different things share one status code. A per-MINUTE limit lifts by
        // itself in seconds: a few lines run late, say so calmly and do not page
        // anybody. A per-DAY one does not, and that is the one worth an alert.
        const day = e.limit === "day";
        const note = day ? t("quotaOut") : t("quotaBusy");
        showErr(note); toast(note, day ? "bad" : "ok");
        if (day) reporter.report("quota_exhausted", t("quotaOut"), `${msg}${e.detail ? " — " + String(e.detail).slice(0, 200) : ""}`);
        return;
      }
      // Streaming ASR is out of credit. The service carries on — the engine has
      // already fallen back to Whisper — but nobody can act on a bare
      // `asr_unreachable_1011`, which is all this used to say, so say the thing
      // that needs doing and keep Google's own wording as the report detail.
      if (msg === "asr_credits_depleted") {
        showErr(t("asrCredits")); toast(t("asrCredits"), "bad");
        reporter.report("asr_failed", t("asrCredits"), e.reason || msg);
        return;
      }
      // Everything else: the close reason, when there is one, is the only part
      // worth reading — the numeric code alone sent us after the wrong cause
      // twice.
      const detail = e && e.reason ? `${msg} — ${e.reason}` : msg;
      showErr(detail);
      // Only report a persistent transcription failure, not a one-off retry
      // that rotation already absorbed.
      if (/ASR|asr/.test(msg)) reporter.report("asr_failed", "speech recognition failing", detail);
      else reporter.report("translate_failed", "correction/translation failing", detail);
    },
    status: (s) => {
      $("dot").classList.toggle("bad", !!s.stalled);
      // The speech socket cycling is its own kind of gap — the room keeps its
      // internet and the transcript still loses the words spoken across it.
      // But not every cycle is a gap: `reconnecting` fires again on EVERY
      // failed retry attempt while still down, so debounce on the timer
      // itself rather than the status flag — restarting it per retry would
      // never fire until the backoff itself capped out.
      if (s.reconnecting) {
        if (!asrDown && !asrDownTimer) {
          asrDownTimer = setTimeout(() => {
            asrDownTimer = null;
            asrDown = true;
            mark("asr_off", t("markAsrDown"));
          }, ASR_MARK_DEBOUNCE_MS);
        }
      } else if (s.connected) {
        if (asrDownTimer) { clearTimeout(asrDownTimer); asrDownTimer = null; }
        if (asrDown) { asrDown = false; mark("asr_on", t("markAsrUp")); }
      }
      // The microphone came back — clear the warning, or the console keeps
      // accusing an input that is working again.
      if (s.stalled === false) { showErr(""); toast(t("micBack"), "ok"); }
      // The pool refills on its own; clear the quota warning when it does,
      // otherwise the console keeps accusing a budget that has come back.
      if (s.exhausted === false) { showErr(""); toast(t("quotaBack"), "ok"); }
    },
    line: (l) => {
      record(l);
      const i = doc.lines.findIndex((x) => x.id === l.id);
      if (i >= 0) doc.lines[i] = l; else doc.lines.push(l);
      if (doc.lines.length > 120) doc.lines.splice(0, doc.lines.length - 120);
      renderLines();
      schedulePush();
    },
  });

  try {
    // After a mid-service reload the room's lines come back with their ids
  // (adoptLiveSession), but a fresh engine numbers from 1 again — and the line
  // handler merges BY ID. So the first sentences after a resume silently
  // replaced the oldest lines on every phone instead of appending: say the
  // same two phrases again and the audience sees them twice while the real
  // opening lines vanish. Reproduced exactly from a member's screenshot.
  // Continue from the highest id the room already has.
  engine.seq = doc.lines.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0);
  await engine.start();
  } catch (e) {
    const why = e.message === "missing_asr_key" ? t("noGroq") : micErrorMessage(e, t);
    // On resume the setup panel is hidden, so its message would be invisible —
    // the failure has to land where the presenter is actually looking.
    if (resume) showErr(t("cantStart") + why);
    else $("setupMsg").textContent = t("cantStart") + why;
    toast(why, "bad");
    reporter.report("mic_denied", why, `${e.name || ""}: ${e.message || e}`);
    return false;
  }

  // A sleeping screen ends the session; hold the lock for as long as we're live.
  wake.on();
  // Permission has now been granted, so device labels are readable.
  renderMics();

  doc.title = $("title").value.trim() || "Spark Live";
  doc.langs = langsOf(liveTargets());
  renderDlLangs();
  doc.live = true; doc.ended = false;
  // Resuming keeps the original start time: the service did not restart just
  // because the presenter's browser did.
  //
  // A start that is NOT a resume is a new service, and the previous one has to
  // go with it. `all` is the only full copy the presenter keeps, it lives at
  // module scope and is never trimmed, so a console left open since last Sunday
  // still holds that transcript: the download wrote BOTH services into one
  // file, and since `startedAt` has just moved forward the old lines' stamps
  // clamped to 00:00:00 and interleaved with the new ones instead of sorting
  // before them. Reported after the 2026-09-20 meeting as "the transcript I
  // downloaded is still the file from last week", with exactly those
  // out-of-order timestamps in it.
  //
  // This sits AFTER engine.start() resolved, so a start that fails on a denied
  // or missing microphone leaves the finished transcript intact and still
  // downloadable — the operator gets another go at the mic without paying for
  // it with last week's file. Nothing can have been recorded into `all` between
  // that await and here: lines only ever arrive through an async callback, and
  // nothing in between suspends this function — `renderMics()` is async but is
  // deliberately not awaited, so control reaches the reset synchronously.
  if (!resume) {
    doc.startedAt = Date.now();
    all.length = 0;
    doc.lines.length = 0;
    markSeq = 0;
  }
  schedulePush();

  renderPreviewLang();
  syncReviewUi();
  $("setupPanel").style.display = "none";
  $("livePanel").style.display = "";
  $("resumeBar").hidden = true;
  $("stopBtn").style.display = "";
  $("dot").className = "dot on";
  $("statePill").textContent = t("stateLive");
  $("statePill").className = "pill live";
  showErr("");
  return true;
}

$("startBtn").onclick = () => beginCapture();
$("resumeBtn").onclick = async () => {
  $("resumeBtn").disabled = true;
  try { await beginCapture({ resume: true }); }
  finally { $("resumeBtn").disabled = false; }
};

$("stopBtn").onclick = async () => {
  if (!engine) return;
  $("statMsg").textContent = t("wrapUp");
  engine.stop();
  wake.off();
  await engine.drain();
  doc.live = false; doc.ended = true; doc.draft = ""; doc.interim = "";
  doc.v += 1;
  writeLocalMirror();
  // The one push that has no successor. Every other update is followed by
  // another within seconds, so a failure self-heals; if this one is lost the
  // room is left watching a session that never says it finished — and the
  // server now deliberately refuses to let an empty document end a live
  // session, so `ended` has to actually arrive.
  let delivered = false;
  for (let attempt = 0; attempt < 4 && !delivered; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    try { await publisher.push(doc); delivered = true; } catch { /* retry */ }
  }
  conn.report(delivered);
  if (!delivered) {
    showErr(t("endNotDelivered"));
    reporter.report("publish_failed", "session end never reached the audience", "4 attempts failed");
  }
  $("dot").className = "dot";
  $("statePill").textContent = t("stateEnded");
  $("statePill").className = "pill ended";
  $("statMsg").textContent = t("endedMsg");
  $("stopBtn").style.display = "none";
  $("newBtn").style.display = "";
};

/* Start a brand-new session: fresh code so old audience links don't collide. */
/* Regenerate the code without leaving the page. The full-reload path used by
   "New session" is fine after a service, but before one has started the
   operator is usually just claiming a fresh code, and losing their typed title
   and glossary to a reload would be hostile. */
$("newCodeBtn").onclick = async () => {
  if (engine && doc.live) { $("codeMsg").textContent = t("codeLocked"); toast(t("codeLocked"), "bad"); return; }
  session = rand(6);
  token = rand(8) + rand(8);              // fresh claim, so an old device can't publish
  LS.set("session", session); LS.set("token", token);
  publisher = createPublisher({ session, token });
  doc.v = 0;
  await paintSession();
  announceIdle();
  $("codeMsg").textContent = t("codeSaved");
  toast(t("newCodeMade", session));
};

$("newBtn").onclick = () => {
  engine = null;
  session = rand(6); token = rand(8) + rand(8);   // fresh code + fresh claim
  LS.set("session", session); LS.set("token", token);
  location.reload();
};
$("settingsBtn").onclick = () => {
  $("advPanel").open = true;
  $("advPanel").scrollIntoView({ behavior: "smooth", block: "start" });
};

$("dlBtn").onclick = async () => {
  if (!engine) return;
  // Mid-session downloads are allowed, but the recorder is still holding an
  // unflushed slice; drain first so the file is complete either way.
  $("dlBtn").disabled = true;
  try {
    await engine.drain();
    const file = engine.archiveFile();
    if (!file) { toast(t("noRecording"), "bad"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file.blob);
    a.download = `${(doc.title || "spark-live").replace(/[^\w一-龥-]+/g, "_")}.${file.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    // Only reachable on a browser with no MediaRecorder, where the archive is
    // capped — say so rather than letting them discover it at the Mac.
    if (file.truncated) toast(t("recordingTruncated"), "bad");
    if (file.stoppedEarly) toast(t("recordingStopped"), "bad");
  } finally {
    $("dlBtn").disabled = false;
  }
};

/**
 * The transcript as a file, for the review that happens after the service.
 *
 * Everything the room saw, in the order it was said: the corrected source and
 * every translation of it under a timestamp, so a mistake spotted on Sunday can
 * be found in the audio on Monday and turned into a glossary entry.
 *
 * Three things it has to survive, all three learned from the file the church
 * actually downloaded on 2026-09-13:
 *
 *  - **It has to be the whole service.** It reads `all`, never `doc.lines` —
 *    that one is capped at 120 for the relay, and the capped copy is what got
 *    written out: a 70-minute sermon arrived as its last 120 lines.
 *  - **It is opened in Notepad on the church's Windows laptop.** Notepad breaks
 *    lines on CRLF and nothing else, so the LF-only file it got rendered as a
 *    single unreadable paragraph. Hence \r\n throughout, and a BOM so the
 *    encoding is not guessed and the Dari not mangled.
 *  - **One language at a time is often what is wanted.** Whoever checks the
 *    Dari does not want the Chinese in the way, so `only` narrows it and the
 *    source text always stays, because a translation cannot be corrected
 *    without the line it came from.
 */
function cleanExportLine(s) {
  let out = String(s || "").trim();
  for (let i = 0; i < 3; i++) {
    out = out.replace(/([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])\s+([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af，。！？；：、“”‘’（）《》【】])/g, "$1$2");
    out = out.replace(/([，。！？；：、“”‘’（）《》【】])\s+([\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af])/g, "$1$2");
  }
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

function joinIntoParagraphs(lines, isCjk) {
  const paras = [];
  let buf = [];
  let charCount = 0;
  for (const raw of lines) {
    const s = cleanExportLine(raw);
    if (!s) continue;
    buf.push(s);
    charCount += s.length;
    const endsSentence = /[.!?。！？；]$/.test(s);
    if ((buf.length >= 4 && endsSentence) || charCount >= (isCjk ? 180 : 320)) {
      paras.push(buf.join(isCjk ? "" : " "));
      buf = [];
      charCount = 0;
    }
  }
  if (buf.length) paras.push(buf.join(isCjk ? "" : " "));
  return paras;
}

function transcriptText(only) {
  const langs = (Array.isArray(doc.langs) ? doc.langs : [])
    .filter((l) => !only || l.c === only);
  const started = Number(doc.startedAt) || Date.now();
  const stamp = (ms) => {
    const sec = Math.max(0, Math.round((ms - started) / 1000));
    const p2 = (n) => String(n).padStart(2, "0");
    return `${p2(Math.floor(sec / 3600))}:${p2(Math.floor(sec / 60) % 60)}:${p2(sec % 60)}`;
  };
  const MAJOR = "=".repeat(68);
  const RULE = "-".repeat(68);
  const spoken = all.filter((l) => !l.mark);
  const head = [
    MAJOR,
    doc.title || "Spark Live",
    `${new Date(started).toLocaleString()}   ·   ${spoken.length} lines`,
    langs.length ? `Source  ->  ${langs.map((l) => l.label || l.c).join(",  ")}`
                 : "Source only (no translation)",
    MAJOR,
    "",
  ];

  // Part 1: Clean Continuous Paragraphs per language (ready for reading / pasting)
  const summary = [];
  const srcLines = spoken.map((l) => cleanExportLine(l.src)).filter(Boolean);
  const srcIsCjk = /[\u4e00-\u9fff]/.test(srcLines.slice(0, 10).join(""));
  if (srcLines.length) {
    summary.push("【Part 1 · Continuous Transcript / 完整連貫文稿】", RULE, "");
    summary.push("■ Source (原文):", "");
    for (const p of joinIntoParagraphs(srcLines, srcIsCjk)) {
      summary.push(`  ${p}`, "");
    }
    for (const lang of langs) {
      const trLines = spoken.map((l) => cleanExportLine((l.tr || {})[lang.c])).filter(Boolean);
      if (!trLines.length) continue;
      const isCjk = /[\u4e00-\u9fff]/.test(trLines.slice(0, 10).join(""));
      summary.push(`■ ${lang.label || lang.c}:`, "");
      for (const p of joinIntoParagraphs(trLines, isCjk)) {
        summary.push(`  ${p}`, "");
      }
    }
    summary.push(MAJOR, "");
  }

  // Part 2: Timestamped Line-by-Line Log
  const body = ["【Part 2 · Timestamped Line-by-Line Log / 時間軸逐句對照】", RULE, ""];
  for (const l of all) {
    if (l.mark) {
      // A gap is the one thing somebody editing the recording is hunting for,
      // so it gets the full width of the page rather than a quiet note.
      body.push(RULE, `[${stamp(Number(l.t) || started)}]  *** ${cleanExportLine(l.src)} ***`, RULE, "");
      continue;
    }
    body.push(`[${stamp(Number(l.t) || started)}]${l.failed ? "   (not translated)" : ""}`);
    body.push(`   ${cleanExportLine(l.src)}`);
    // The recogniser's own words, where the corrector changed them — so a wrong
    // "fix" can be found on Monday instead of being taken for what was said.
    if (l.heard) body.push(`   (heard: ${cleanExportLine(l.heard)})`);
    for (const lang of langs) {
      const txt = cleanExportLine((l.tr || {})[lang.c]);
      if (txt) body.push(`   ${lang.label || lang.c}:  ${txt}`);
    }
    body.push("");
  }
  // BOM + CRLF: this file's job is to open correctly in Windows Notepad.
  return "\uFEFF" + head.concat(summary, body).join("\r\n") + "\r\n";
}

function saveTranscript(only) {
  if (!all.some((l) => !l.mark)) { toast(t("noTranscript"), "bad"); return; }
  const blob = new Blob([transcriptText(only)], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const day = new Date(Number(doc.startedAt) || Date.now()).toISOString().slice(0, 10);
  const tag = only ? `_${only}` : "";
  a.download = `${(doc.title || "spark-live").replace(/[^\w一-龥-]+/g, "_")}_${day}${tag}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function printTranscript(only) {
  const spoken = all.filter((l) => !l.mark);
  if (!spoken.length) { toast(t("noTranscript"), "bad"); return; }
  const langs = (Array.isArray(doc.langs) ? doc.langs : [])
    .filter((l) => !only || l.c === only);
  const started = Number(doc.startedAt) || Date.now();
  const stamp = (ms) => {
    const sec = Math.max(0, Math.round((ms - started) / 1000));
    const p2 = (n) => String(n).padStart(2, "0");
    return `${p2(Math.floor(sec / 3600))}:${p2(Math.floor(sec / 60) % 60)}:${p2(sec % 60)}`;
  };

  const srcLines = spoken.map((l) => cleanExportLine(l.src)).filter(Boolean);
  const srcIsCjk = /[\u4e00-\u9fff]/.test(srcLines.slice(0, 10).join(""));
  let continuousHtml = "";
  if (srcLines.length) {
    continuousHtml += `<div class="sec"><div class="sec-h">Source · 原文連貫文稿</div>`;
    for (const p of joinIntoParagraphs(srcLines, srcIsCjk)) {
      continuousHtml += `<p class="para">${esc(p)}</p>`;
    }
    continuousHtml += `</div>`;
    for (const lang of langs) {
      const trLines = spoken.map((l) => cleanExportLine((l.tr || {})[lang.c])).filter(Boolean);
      if (!trLines.length) continue;
      const isCjk = /[\u4e00-\u9fff]/.test(trLines.slice(0, 10).join(""));
      const dirAttr = lang.rtl ? ' dir="rtl" lang="prs"' : "";
      continuousHtml += `<div class="sec"${dirAttr}><div class="sec-h">${esc(lang.label || lang.c)} · 連貫譯文</div>`;
      for (const p of joinIntoParagraphs(trLines, isCjk)) {
        continuousHtml += `<p class="para">${esc(p)}</p>`;
      }
      continuousHtml += `</div>`;
    }
  }

  let logHtml = "";
  for (const l of all) {
    const ts = stamp(Number(l.t) || started);
    if (l.mark) {
      logHtml += `<div class="gap">[${esc(ts)}] — ${esc(cleanExportLine(l.src))}</div>`;
      continue;
    }
    let trRows = "";
    for (const lang of langs) {
      const txt = cleanExportLine((l.tr || {})[lang.c]);
      if (!txt) continue;
      const dirAttr = lang.rtl ? ' dir="rtl" lang="prs"' : "";
      trRows += `<div class="tr"${dirAttr}><span class="tr-lbl">${esc(lang.label || lang.c)}</span><span class="tr-txt">${esc(txt)}</span></div>`;
    }
    logHtml += `<div class="row">
      <div class="ts">${esc(ts)}</div>
      <div class="cnt">
        <div class="src">${esc(cleanExportLine(l.src))}</div>
        ${trRows}
      </div>
    </div>`;
  }

  const w = window.open("", "_blank");
  if (!w) { toast("Popup blocked — please allow popups for PDF export", "bad"); return; }
  const title = doc.title || "Spark Live Transcript";
  const dateStr = new Date(started).toLocaleString();
  const langSummary = langs.length ? langs.map((l) => l.label || l.c).join(" · ") : "Source only";
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 18mm 18mm 20mm 18mm; }
  body { font: 11pt/1.75 "Noto Serif TC", "Songti TC", "PingFang TC", Georgia, serif; color: #1f242d; max-width: 720px; margin: 24px auto; padding: 0 16px; }
  .cover { margin-bottom: 20px; }
  .brand { font: 600 8.5pt/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #9a6b16; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 6px; }
  h1 { font-size: 20pt; line-height: 1.3; margin: 0 0 6px; color: #141821; font-weight: 700; }
  .meta { font: 9.5pt/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #68707c; }
  .rule { height: 2px; background: #c59b27; margin: 14px 0 4px; }
  .rule-thin { height: 1px; background: #e2e5ec; margin: 0 0 22px; }
  h2.part { font: 700 12pt/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1e293b; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 6px; margin: 26px 0 14px; }
  .sec { margin: 14px 0 20px; }
  .sec-h { font: 700 10.5pt/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #2b3548; background: #f3f5f8; border-left: 3.5px solid #c59b27; padding: 5px 10px; margin-bottom: 10px; }
  p.para { margin: 0 0 10px; text-align: justify; }
  .row { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px solid #f1f5f9; page-break-inside: avoid; }
  .ts { font: 600 8.5pt/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #94a3b8; flex: 0 0 58px; }
  .cnt { flex: 1; min-width: 0; }
  .src { font-weight: 600; color: #141821; margin-bottom: 2px; }
  .tr { font-size: 10.2pt; color: #334155; margin-top: 2px; }
  .tr-lbl { display: inline-block; font: 600 8pt/1.2 -apple-system, sans-serif; color: #9a6b16; background: #fef3c7; border-radius: 3px; padding: 1px 5px; margin-right: 6px; }
  .gap { font: 600 9pt/1.4 -apple-system, sans-serif; color: #9a6b16; background: #fffbeb; border: 1px dashed #f59e0b; padding: 6px 10px; margin: 8px 0; text-align: center; }
</style></head><body>
  <div class="cover">
    <div class="brand">Spark Live · Bilingual Session Record</div>
    <h1>${esc(title)}</h1>
    <div class="meta">${esc(dateStr)} &nbsp;·&nbsp; ${spoken.length} lines &nbsp;·&nbsp; ${esc(langSummary)}</div>
    <div class="rule"></div>
    <div class="rule-thin"></div>
  </div>
  <h2 class="part">Part 1 · Continuous Transcript / 完整連貫文稿</h2>
  ${continuousHtml}
  <h2 class="part">Part 2 · Timestamped Bilingual Log / 時間軸逐句對照</h2>
  ${logHtml}
  <script>window.onload=()=>{setTimeout(()=>window.print(),250)};</script>
</body></html>`);
  w.document.close();
}

$("dlTextBtn").onclick = () => saveTranscript(null);
if ($("dlPdfBtn")) $("dlPdfBtn").onclick = () => printTranscript(null);

/* One button per language next to the all-languages one. Asked for directly:
   the person checking the Dari and the person checking the Chinese are not the
   same person and do not want each other's text in the file. */
function renderDlLangs() {
  const el = $("dlLangs");
  if (!el) return;
  const langs = Array.isArray(doc.langs) ? doc.langs : [];
  el.style.display = langs.length > 1 ? "" : "none";
  el.innerHTML = langs.map((l) =>
    `<button class="iconbtn lang" data-c="${l.c}"${l.rtl ? ' lang="prs"' : ""}>${esc(l.label || l.c)}</button>`).join("");
  for (const b of el.querySelectorAll(".lang")) b.onclick = () => saveTranscript(b.dataset.c);
}

/* ── human review ─────────────────────────────────────────────────────────
   Asked for after the 2026-10-19 Mandarin sharing, where fast speech came out late
   and garbled: "add a person to approve the text, with an input box and Enter".
   The engine holds each line (engine.js, "human review"); this is the operator's
   side. Rows are kept and updated in place rather than re-rendered, so a line
   being typed into is never wiped by a new one arriving. */
const rEls = new Map();            // rid -> row element

function syncReviewUi() {
  const on = reviewOn();
  $("reviewPanel").hidden = !on;
  const b = $("reviewToggle");
  b.textContent = on ? t("reviewBtnOn") : t("reviewBtnOff");
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.title = t("reviewToggleTip");
}

$("reviewOn").addEventListener("change", () => {
  const on = reviewOn();
  LS.set("review", on ? "1" : "0");
  syncAsrOption();
  renderLangPick(); renderPreviewLang();
  syncReviewUi();
  if (engine) {
    // Turning it off sends whatever is waiting, in order.
    engine.setReview(on);
    doc.draft = on ? "" : localDraft;
    if (on) doc.interim = "";
    renderDraft(); schedulePush();
    toast(on ? t("reviewNowOn") : t("reviewNowOff"), "ok");
  } else {
    announceIdle();
  }
});
$("reviewToggle").onclick = () => {
  $("reviewOn").checked = !reviewOn();
  $("reviewOn").dispatchEvent(new Event("change"));
};
$("reviewAuto").addEventListener("change", () => {
  LS.set("reviewAuto", $("reviewAuto").value);
  if (engine) { engine.cfg.reviewAutoMs = Number($("reviewAuto").value) || 0; renderReview(engine.reviewQ); }
});
$("reviewAllBtn").onclick = () => { if (engine) engine.approveAll(); };

function fit(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }
function caretEnd(ta) { try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {} }
function focusRow(rid) {
  const el = rEls.get(rid);
  const ta = el && el.querySelector("textarea");
  if (ta) { ta.focus({ preventScroll: true }); caretEnd(ta); }
}

function sendRow(rid) {
  const el = rEls.get(rid);
  if (!el || !engine) return;
  engine.approve(rid, el.querySelector("textarea").value);
}
function dropRow(rid) { if (engine) engine.discard(rid); }
function mergeRow(rid) {
  const el = rEls.get(rid);
  const nx = el && el.nextElementSibling;
  if (!el || !nx || !engine) return;
  const ta = el.querySelector("textarea");
  engine.mergeNext(rid, ta.value, nx.querySelector("textarea").value);
  const item = engine.reviewQ.find((r) => r.rid === rid);
  if (item) { ta.value = item.text; fit(ta); }
  ta.focus({ preventScroll: true }); caretEnd(ta);
}

function reviewRow(r) {
  const el = document.createElement("div");
  el.className = "ritem";
  el.innerHTML = `<span class="rnum"></span><textarea rows="1" dir="auto" spellcheck="false"></textarea>
    <div class="ract">
      <button type="button" class="rsend" title="${esc(t("reviewSendTip"))}">✓</button>
      <button type="button" class="rmerge" title="${esc(t("reviewMergeTip"))}">⤓</button>
      <button type="button" class="rdrop" title="${esc(t("reviewDropTip"))}">✕</button>
    </div><i class="rbar"></i>`;
  const ta = el.querySelector("textarea");
  ta.value = r.text;
  ta.addEventListener("input", () => {
    fit(ta);
    el.classList.add("held");
    if (engine) engine.edit(r.rid, ta.value);
  });
  ta.addEventListener("blur", () => { if (engine) engine.release(r.rid); });
  ta.addEventListener("keydown", (e) => {
    // An IME (Chinese, Persian…) uses Enter to pick characters; that Enter is not ours.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); sendRow(r.rid); }
    else if (e.key === "ArrowDown" && e.altKey) { e.preventDefault(); mergeRow(r.rid); }
  });
  el.querySelector(".rsend").onclick = () => sendRow(r.rid);
  el.querySelector(".rdrop").onclick = () => dropRow(r.rid);
  el.querySelector(".rmerge").onclick = () => mergeRow(r.rid);
  return el;
}

/** Restart the auto-send countdown bar when a line's clock (re)starts. */
function paintTimer(el, r) {
  const bar = el.querySelector(".rbar");
  const ms = engine ? engine.cfg.reviewAutoMs || 0 : 0;
  if (!ms) { bar.style.transition = "none"; bar.style.width = "0"; el.dataset.at = ""; return; }
  if (r.hold || el.dataset.at === String(r.at)) return;
  el.dataset.at = String(r.at);
  const left = Math.max(0, ms - (Date.now() - r.at));
  bar.style.transition = "none";
  bar.style.width = (left / ms) * 100 + "%";
  void bar.offsetWidth;                         // commit the start before animating
  bar.style.transition = `width ${left}ms linear`;
  bar.style.width = "0";
}

function renderReview(list) {
  const box = $("reviewList");
  const keep = new Set(list.map((r) => r.rid));
  for (const [rid, el] of rEls) if (!keep.has(rid)) { el.remove(); rEls.delete(rid); }
  list.forEach((r, i) => {
    let el = rEls.get(r.rid);
    const fresh = !el;
    if (fresh) { el = reviewRow(r); rEls.set(r.rid, el); }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    el.querySelector(".rnum").textContent = String(i + 1);
    const ta = el.querySelector("textarea");
    if (document.activeElement !== ta && ta.value !== r.text) ta.value = r.text;
    if (fresh || document.activeElement !== ta) fit(ta);
    el.classList.toggle("held", !!r.hold);
    el.querySelector(".rmerge").disabled = i === list.length - 1;
    paintTimer(el, r);
  });
  const n = list.length;
  $("reviewCount").textContent = String(n);
  $("reviewCount").classList.toggle("zero", !n);
  $("reviewEmpty").hidden = n > 0;
  // Ready for the next Enter: unless the operator is busy somewhere else, the cursor
  // goes to the oldest waiting line.
  const ae = document.activeElement;
  const idle = !ae || ae === document.body || (ae.id === "manualIn" && !ae.value);
  if (n && idle) focusRow(list[0].rid);
}

function sendManual() {
  const v = $("manualIn").value.trim();
  if (!v) return;
  if (!engine) { toast(t("manualNotLive"), "bad"); return; }
  engine.say(v);
  $("manualIn").value = "";
}
$("manualBtn").onclick = sendManual;
$("manualIn").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") { e.preventDefault(); sendManual(); }
});
syncReviewUi();
window.addEventListener("ui:lang", syncReviewUi);

window.addEventListener("beforeunload", (e) => {
  if (engine && doc.live) { e.preventDefault(); e.returnValue = ""; }
});

// Runs last on purpose: it touches `doc`, `publisher` and `schedulePush`, all of
// which are declared below the language-picker setup where this used to sit.
// Adopting an interrupted session must be tried FIRST — announcing idle over a
// live session is precisely the failure this guards against.
adoptLiveSession().then((resumed) => { if (!resumed) announceIdle(); });
showQuota();   // pre-flight only: never polled, never shown mid-session

// Context the reporter attaches to any incident.
window.__sparkTargets = targets;
window.addEventListener("error", (e) => {
  reporter.report("uncaught", e.message || "uncaught error",
    `${e.filename || ""}:${e.lineno || ""}\n${e.error?.stack || ""}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const detail = String(e.reason?.stack || e.reason || "").slice(0, 2000);
  if (isExtensionOrigin(detail)) return;   // wallet/ad-blocker noise, not our bug
  reporter.report("uncaught", "unhandled promise rejection", detail);
});
