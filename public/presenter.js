import { LiveEngine, LANGS , listInputs } from "./engine.js";
import { t, applyI18n, mountUiSwitch } from "./i18n.js";
import { createPublisher } from "./channel.js";
import { createWakeLock, createConnection, createToast, micErrorMessage } from "./resilience.js";

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
  // QR is a nicety, not a dependency — if the CDN is blocked we still show the link.
  try {
    if (!qrcodeLib) qrcodeLib = (await import("https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm")).default;
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
// A pre-configured pool arrives as an array; the extra keys fill the textarea.
const PRESET_POOL = Array.isArray(CFG.groqKeys) ? CFG.groqKeys.filter(Boolean) : [];
for (const id of ["title", "context", "glossary", "groqKey", "groqKeys2", "geminiKey", "kimiKey", "glmKey", "lang"]) {
  const el = $(id);
  const saved = LS.get(id);
  const preset = id === "groqKeys2" ? PRESET_POOL.slice(1).join("\n")
               : id === "groqKey"   ? (CFG.groqKey || PRESET_POOL[0] || "")
               : CFG[id] ?? CFG.defaults?.[id] ?? "";
  el.value = saved || preset || el.value;
  el.addEventListener("change", () => { LS.set(id, el.value); if (id.startsWith("groq")) readiness(); });
  el.addEventListener("blur", () => LS.set(id, el.value));
}

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
  doc.langs = targets.map((c) => ({ c, label: LANGS[c].label, rtl: !!LANGS[c].rtl }));
  doc.live = false;
  doc.ended = false;
  schedulePush();
}

/* ── target languages ── */
const DEFAULT_TARGETS = ["prs", "en"];
let targets = (() => {
  try { const v = JSON.parse(LS.get("targets") || "null"); if (Array.isArray(v) && v.length) return v.slice(0, 3); } catch {}
  return DEFAULT_TARGETS.slice();
})();
function renderLangPick() {
  $("langpick").innerHTML = Object.entries(LANGS)
    .map(([c, d]) => `<button data-c="${c}" class="${targets.includes(c) ? "on" : ""}">${d.label}</button>`).join("");
  for (const b of $("langpick").querySelectorAll("button")) {
    b.onclick = () => {
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
        renderLines(); schedulePush();
      }
    };
  }
  syncLangScrollHint();
  const names = targets.map((c) => LANGS[c].en).join(" · ");
  $("langHint").textContent = targets.length >= 3 ? t("langWarn", names) : t("langNote", names);
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
  return targets.includes(previewLang) ? previewLang : targets[0];
}
function renderPreviewLang() {
  const el = $("previewLang");
  if (!el) return;
  const cur = activePreview();
  el.style.display = targets.length > 1 ? "" : "none";
  el.innerHTML = targets.map((c) =>
    `<button class="iconbtn lang ${c === cur ? "on" : ""}" data-c="${c}"${LANGS[c].rtl ? ' lang="prs"' : ""}>${LANGS[c].label}</button>`).join("");
  for (const b of el.querySelectorAll(".lang")) b.onclick = () => {
    previewLang = b.dataset.c; LS.set("previewLang", previewLang);
    renderPreviewLang(); renderLines(); renderDraft();
  };
}
window.addEventListener("ui:lang", () => {
  applyI18n(); renderLangPick(); renderPreviewLang(); readiness();
  $("copyBtn").textContent = t("copyLink");
  if (doc.lines.length) renderLines();
});

/* ── resilience ── */
const wake = createWakeLock();
const toast = createToast();
const conn = createConnection({
  onChange: ({ online }) => {
    document.body.classList.toggle("offline", !online);
    if (!online) toast(t("offline"), "bad");
    else if (engine && engine.running) toast(t("backOnline"), "ok");
  },
});

/* ── state ── */
const doc = {
  v: 0, title: "", live: false, ended: false, draft: "", interim: "",
  langs: [], startedAt: Date.now(), lines: [],
};
let publisher = createPublisher({ session, token });
let engine = null;
let pushTimer = null;

function schedulePush() {
  if (pushTimer) return;
  // Batch rapid updates into ~400 ms so a burst of corrections is one request.
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    doc.v += 1;
    try { await publisher.push(doc); }
    catch (e) { conn.report(false); showErr(t("publishFail") + e.message); }
  }, 400);
}

const showErr = (m) => { $("err").textContent = m || ""; };

function renderDraft() {
  const primary = activePreview();
  const rtl = (LANGS[primary] || {}).rtl;
  $("draft").innerHTML = doc.interim
    ? `<div class="${rtl ? "rtl" : ""}" style="color:var(--warn)">${esc(doc.interim)}</div>
       <div style="opacity:.6;margin-top:2px">${esc(doc.draft)}</div>`
    : esc(doc.draft) || "…";
}
function renderLines() {
  const primary = activePreview();
  const rtl = (LANGS[primary] || {}).rtl;
  $("lines").innerHTML = doc.lines.slice(-25).reverse().map((l) => {
    const main = (l.tr && l.tr[primary]) || "";
    return `<div class="line ${l.pending ? "pending" : ""} ${l.failed ? "failed" : ""}">
      <div class="dari ${rtl ? "rtl" : ""}">${esc(main) || (l.pending ? t("translating") : "—")}</div>
      <div class="src">${esc(l.src)}</div>
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
$("startBtn").onclick = async () => {
  const groqKeys = groqPool();
  // Hosted deployments need no key: the proxy holds the pool server-side. A key
  // typed here still wins, so a presenter can spend their own quota if they want.
  const useProxy = HOSTED && !groqKeys.length;
  if (!useProxy && !groqKeys.length) { $("setupMsg").textContent = t("noGroq"); return; }

  // Fast-and-good first, reliable-but-slow last. Only configured keys join.
  // The groq step gets no `key`: the engine hands it the rotating pool.
  const llmChain = [
    ...(useProxy ? [{ id: "proxy" }] : []),
    { id: "groq",   key: groqKeys[0] },
    { id: "gemini", key: $("geminiKey").value.trim() },
    { id: "kimi",   key: $("kimiKey").value.trim() },
    { id: "glm",    key: $("glmKey").value.trim() },
  ].filter((s) => s.key);

  engine = new LiveEngine({
    groqKey: groqKeys[0], groqKeys, proxy: useProxy, deviceId: micId, llmChain, targets,
    language: $("lang").value,
    glossary: $("glossary").value.trim(),
    context: $("context").value.trim(),
  }).events({
    level: (v) => { $("meterBar").style.width = Math.round(v * 100) + "%"; },
    draft: (t) => { doc.draft = t || ""; renderDraft(); schedulePush(); },
    interim: (t) => { doc.interim = t || ""; renderDraft(); schedulePush(); },
    error: (e) => {
      const msg = String(e && e.message ? e.message : e);
      if (msg === "audio_stalled") { showErr(t("micStalled")); toast(t("micStalled"), "bad"); return; }
      if (e && e.exhausted) { showErr(t("quotaOut")); toast(t("quotaOut"), "bad"); return; }
      showErr(msg);
    },
    status: (s) => { $("dot").classList.toggle("bad", !!s.stalled); },
    line: (l) => {
      const i = doc.lines.findIndex((x) => x.id === l.id);
      if (i >= 0) doc.lines[i] = l; else doc.lines.push(l);
      if (doc.lines.length > 120) doc.lines.splice(0, doc.lines.length - 120);
      renderLines();
      schedulePush();
    },
  });

  try {
    await engine.start();
  } catch (e) {
    const why = e.message === "missing_asr_key" ? t("noGroq") : micErrorMessage(e, t);
    $("setupMsg").textContent = t("cantStart") + why;
    toast(why, "bad");
    return;
  }

  // A sleeping screen ends the session; hold the lock for as long as we're live.
  wake.on();
  // Permission has now been granted, so device labels are readable.
  renderMics();

  doc.title = $("title").value.trim() || "Spark Live";
  doc.langs = targets.map((c) => ({ c, label: LANGS[c].label, rtl: !!LANGS[c].rtl }));
  doc.live = true; doc.ended = false; doc.startedAt = Date.now();
  schedulePush();

  renderPreviewLang();
  $("setupPanel").style.display = "none";
  $("livePanel").style.display = "";
  $("dot").className = "dot on";
  $("statePill").textContent = t("stateLive");
  $("statePill").className = "pill live";
  showErr("");
};

$("stopBtn").onclick = async () => {
  if (!engine) return;
  $("statMsg").textContent = t("wrapUp");
  engine.stop();
  wake.off();
  await engine.drain();
  doc.live = false; doc.ended = true; doc.draft = "";
  doc.v += 1;
  try { await publisher.push(doc); conn.report(true); } catch { conn.report(false); }
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

$("dlBtn").onclick = () => {
  if (!engine) return;
  const blob = engine.archiveWav();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(doc.title || "spark-live").replace(/[^\w一-龥-]+/g, "_")}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};

window.addEventListener("beforeunload", (e) => {
  if (engine && doc.live) { e.preventDefault(); e.returnValue = ""; }
});

// Runs last on purpose: it touches `doc`, `publisher` and `schedulePush`, all of
// which are declared below the language-picker setup where this used to sit.
announceIdle();
showQuota();   // pre-flight only: never polled, never shown mid-session
