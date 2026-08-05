import { subscribe } from "./channel.js";
import { t, applyI18n, mountUiSwitch } from "./i18n.js";
import { createWakeLock, createToast } from "./resilience.js";

const $ = (id) => document.getElementById(id);
// `/join/CODE` is a 200 rewrite, so the browser URL keeps the path and carries
// NO query string — read the code from either shape.
const params = new URLSearchParams(location.search);
const fromPath = (location.pathname.match(/\/join\/([A-Za-z0-9]{4,12})/) || [])[1] || "";
const session = (params.get("s") || fromPath || "").trim().toUpperCase();

if (!session) {
  $("empty").textContent = t("missingCode");
  throw new Error("no session");
}

/* ── viewer-local preferences ── */
const pref = {
  get size() { return +(localStorage.getItem("live.size") || 30); },
  set size(v) { localStorage.setItem("live.size", String(v)); apply(); },
  get src() { return localStorage.getItem("live.src") !== "0"; },
  set src(v) { localStorage.setItem("live.src", v ? "1" : "0"); apply(); lastSig = ""; if (lastDoc) render(lastDoc); },
  get lang() { return localStorage.getItem("live.lang") || ""; },
  set lang(v) { localStorage.setItem("live.lang", v); lastSig = ""; if (lastDoc) render(lastDoc); apply(); },
};
let LANGS = [];                     // [{c,label,rtl}] — published by the presenter
function activeLang() {
  if (!LANGS.length) return "";
  const want = pref.lang;
  return LANGS.some((l) => l.c === want) ? want : LANGS[0].c;
}
function isRtlLang(c) { const l = LANGS.find((x) => x.c === c); return !!(l && l.rtl); }
function renderLangSel() {
  const cur = activeLang();
  const el = $("langsel");
  // Only worth showing a switcher when there's something to switch between.
  el.style.display = LANGS.length > 1 ? "" : "none";
  el.innerHTML = LANGS.map((l) =>
    `<button class="iconbtn lang ${l.c === cur ? "on" : ""}" data-lang="${l.c}"${l.rtl ? ' lang="prs"' : ""}>${l.label}</button>`).join("");
  for (const b of el.querySelectorAll(".lang")) b.onclick = () => { pref.lang = b.dataset.lang; };
}
function apply() {
  document.documentElement.style.setProperty("--dsize", pref.size + "px");
  // A checkbox menu item states its own status; opacity did not.
  $("srcBtn").setAttribute("aria-checked", pref.src ? "true" : "false");
  $("sizeVal").textContent = pref.size;
  renderLangSel();
}

/* ── display menu ─────────────────────────────────────────────────────
   Opened rarely, so it must be obvious and dismissible: Escape, a click
   outside, or choosing an action all close it, and focus returns to the
   button so a keyboard user is not stranded. */
const menu = $("menu");
const menuBtn = $("menuBtn");
function setMenu(open) {
  menu.hidden = !open;
  menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) return;
  const first = menu.querySelector("button:not([disabled])");
  first && first.focus();
}
menuBtn.onclick = (e) => { e.stopPropagation(); setMenu(menu.hidden); };
document.addEventListener("click", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) setMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menu.hidden) { setMenu(false); menuBtn.focus(); }
});
$("bigger").onclick = () => { pref.size = Math.min(72, pref.size + 4); };
$("smaller").onclick = () => { pref.size = Math.max(16, pref.size - 4); };
$("srcBtn").onclick = () => { pref.src = !pref.src; };
$("fsBtn").onclick = () => {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen();
  else (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  setMenu(false);
};
// iOS Safari has no Fullscreen API on iPhone; offering a dead control is worse
// than not offering one.
if (!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)) {
  $("fsBtn").hidden = true;
}
mountUiSwitch($("uiSwitch"), { variant: "inline" });
applyI18n();
apply();
window.addEventListener("ui:lang", () => { applyI18n(); lastSig = ""; if (lastDoc) render(lastDoc); });

/* ── keep the newest line in view unless the reader scrolled up ── */
let pinned = true;
window.addEventListener("scroll", () => {
  pinned = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
}, { passive: true });

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let lastSig = "";
let lastDoc = null;

// Text in the viewer's chosen language, falling back to whatever exists so a
// line is never blank just because one translation is missing.
function pick(l) {
  const tr = l.tr || {};
  const want = activeLang();
  if (tr[want] && tr[want].trim()) return tr[want].trim();
  for (const k of Object.keys(tr)) if (tr[k] && tr[k].trim()) return tr[k].trim();
  return "";
}

function render(doc) {
  lastDoc = doc;
  if (doc.title) $("title").textContent = doc.title;

  const incoming = Array.isArray(doc.langs) ? doc.langs : [];
  if (incoming.map((l) => l.c).join(",") !== LANGS.map((l) => l.c).join(",")) {
    LANGS = incoming; renderLangSel();
  }

  const lines = Array.isArray(doc.lines) ? doc.lines : [];
  const shown = lines.filter((l) => pick(l) || !l.pending);

  // Signature check keeps us from re-rendering (and killing the animation)
  // on every poll when nothing actually changed.
  const sig = activeLang() + "/" + pref.src + "#" +
    shown.map((l) => `${l.id}:${(pick(l) || "").length}:${l.src.length}`).join("|") +
    "#" + (doc.draft || "") + "#" + (doc.interim || "");
  if (sig === lastSig) return;
  lastSig = sig;

  if (!shown.length && !doc.draft) {
    $("feed").innerHTML = `<div class="empty">${doc.live
      ? t("waiting") : t("notStarted")}</div>`;
    return;
  }

  const cur = activeLang();
  const isRtl = isRtlLang(cur);
  const html = shown.slice(-60).map((l) => `
    <div class="entry ${l.pending ? "pending" : ""}">
      <div class="dari ${isRtl ? "rtl" : ""}" lang="${isRtl ? "prs" : cur}">${esc(pick(l)) || "…"}</div>
      ${pref.src && esc(l.src) !== esc(pick(l)) ? `<div class="src">${esc(l.src)}</div>` : ""}
    </div>`).join("");

  const draft = doc.live && (doc.interim || doc.draft)
    ? `<div class="entry live">
         ${doc.interim ? `<div class="dari ${isRtl ? "rtl" : ""}" style="opacity:.7">${esc(doc.interim)}</div>` : ""}
         ${(pref.src || !doc.interim) ? `<div class="src" style="font-style:italic">${esc(doc.draft)}</div>` : ""}
       </div>`
    : "";

  const ended = doc.ended
    ? `<div class="empty">${t("sessionEnded")}</div>`
    : "";

  $("feed").innerHTML = html + draft + ended;
  if (pinned) window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

/* Audience phones sleep in ~30 s, which means unlocking the phone every time
   you want to read the translation. Hold the screen awake while watching. */
const wake = createWakeLock();
const toast = createToast();
wake.on();

let wasOffline = false;

subscribe({
  session,
  onDoc: render,
  onStatus: (s) => {
    $("dot").className = "dot" + (s.ok ? " on" : s.notFound ? " bad" : "");
    document.body.classList.toggle("offline", !!s.offline);
    if (s.offline && !wasOffline) { wasOffline = true; toast(t("reconnecting"), "bad"); }
    else if (!s.offline && wasOffline) { wasOffline = false; toast(t("backOnline"), "ok"); }
    if (s.notFound) {
      $("feed").innerHTML = `<div class="empty">${t("notFound")}: <b>${esc(session)}</b><br /><span class="sub">${t("checkCode")}</span></div>`;
      lastSig = "";
    }
  },
});
