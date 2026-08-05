/**
 * Spark Live — interface language (separate from the *content* languages the
 * audience toggles between). Default English; switchable and persisted.
 *
 * Usage in markup:
 *   <span data-i18n="start">Start</span>          → textContent
 *   <input data-i18n-ph="titlePh">                → placeholder
 * HTML written in the file is the English fallback, so the page reads correctly
 * even before this module runs.
 */
const DICT = {
  en: {
    stateIdle: "Not started", stateLive: "Live", stateEnded: "Ended",
    tagline: "English / Chinese → any language",
    titleLabel: "Session title", titlePh: "Sunday Service",
    targetsLabel: "Translate into (up to 3 — fewer is faster and cheaper)",
    start: "▶ Start", stop: "■ Stop", newSession: "↻ New session",
    download: "Download recording", settings: "⚙ Settings",
    audienceHead: "Audience scans this", copyLink: "Copy link", copied: "Copied ✓",
    copyManual: "Copy it manually", preview: "Preview audience view",
    advanced: "Advanced — glossary, context, source language, keys",
    glossaryLabel: "Glossary — the single biggest accuracy lever",
    glossaryPh: "One per line:\nJehovah = یهوه\nPastor Raymond = پاستور ریموند\nRomans = رومیان",
    glossaryHint: "Names, places, scripture books, jargon. Worth more than a pricier model.",
    srcLangLabel: "Source language",
    srcAuto: "Auto-detect (mixed EN/Chinese)", srcEn: "English", srcZh: "Chinese",
    contextLabel: "Session context (for the AI)",
    contextPh: "e.g. Sunday sermon, speaker Pastor Raymond, Romans chapter 8.",
    keysHead: "API key",
    groqLabel: "Groq — powers both recognition and translation",
    groqHint: "This one key is enough. The backups are only used if it runs out of quota.",
    testKey: "Test key", backupKeys: "Backup keys (rarely needed)",
    moreGroq: "More Groq keys — one per line",
    moreGroqHint: "Each key has its own rate limit, so extra keys buy headroom for a long talk. They rotate automatically.",
    keyPool: (n) => `${n} Groq keys rotating`,
    needGroq: "⚠️ No Groq key yet — open Advanced below and add one.",
    ready: (l) => `Ready: ${l} · allow the microphone after you press Start.`,
    noGroq: "Enter a Groq key first.", cantStart: "Couldn't start: ",
    testing: "Testing…", wrapUp: "Wrapping up…",
    endedMsg: "Ended — the recording is still downloadable.",
    translating: "translating…", maxLangs: "Max 3 — deselect one first.",
    langNote: (n) => `${n} · the first is primary; the audience can switch.`,
    langWarn: (n) => `${n} — 3 languages use ~3× the output budget and may hit rate limits on a long talk.`,
    publishFail: "Publish failed ",
    codeHint: "Editable — reuse the same code so a saved link keeps working.",
    codeInvalid: "4–12 letters/numbers only.",
    codeTaken: "That code is in use by another device. Pick a different one.",
    codeLocked: "Can't change the code while live.",
    codeSaved: "Saved — share the new link.",
    srcBtn: "Source",
    connecting: "Connecting…",
    waiting: "Ready — waiting for the speaker",
    notStarted: "Session hasn’t started yet",
    sessionEnded: "— Session ended —",
    notFound: "Session not found",
    checkCode: "Check the code",
    missingCode: "Missing session code",
    readyHosted: "Ready — no setup needed. Press Start and allow the microphone.",
    footTag: "Live transcription & translation",
    footAsk: "Questions or feedback? Contact Paul",
    footPriv: "Your API keys are stored on this device only and are never sent to our servers.",
  },
  prs: {
    stateIdle: "شروع نشده", stateLive: "زنده", stateEnded: "پایان یافت",
    tagline: "انگلیسی / چینی ← هر زبان",
    titleLabel: "عنوان جلسه", titlePh: "مراسم یکشنبه",
    targetsLabel: "ترجمه به (حداکثر ۳ — کمتر یعنی سریع‌تر و ارزان‌تر)",
    start: "▶ شروع", stop: "■ توقف", newSession: "↻ جلسهٔ جدید",
    download: "دانلود ضبط", settings: "⚙ تنظیمات",
    audienceHead: "حاضرین این را اسکن کنند", copyLink: "کاپی لینک", copied: "کاپی شد ✓",
    copyManual: "دستی کاپی کنید", preview: "پیش‌نمای حاضرین",
    advanced: "پیشرفته — واژه‌نامه، زمینه، زبان مبدأ، کلیدها",
    glossaryLabel: "واژه‌نامه — مهم‌ترین عامل دقت",
    glossaryPh: "هر سطر یکی:\nیهوه = یهوه\nPastor Raymond = پاستور ریموند",
    glossaryHint: "نام‌ها، مکان‌ها، کتاب‌های مقدس، اصطلاحات. از مدل گران‌تر مؤثرتر است.",
    srcLangLabel: "زبان مبدأ",
    srcAuto: "تشخیص خودکار (انگلیسی/چینی)", srcEn: "انگلیسی", srcZh: "چینی",
    contextLabel: "زمینهٔ جلسه (برای هوش مصنوعی)",
    contextPh: "مثلاً: موعظهٔ یکشنبه، سخنران پاستور ریموند، رومیان باب ۸.",
    keysHead: "کلید API",
    groqLabel: "Groq — هم تشخیص گفتار هم ترجمه",
    groqHint: "همین یک کلید کافی است.",
    testKey: "آزمایش کلید", backupKeys: "کلیدهای پشتیبان (به‌ندرت لازم)",
    moreGroq: "کلیدهای بیشتر Groq — هر سطر یکی",
    moreGroqHint: "هر کلید سهمیهٔ جداگانه دارد؛ کلیدهای بیشتر برای سخنرانی طولانی ظرفیت می‌دهند و خودکار می‌چرخند.",
    keyPool: (n) => `${n} کلید Groq در چرخش`,
    needGroq: "⚠️ کلید Groq موجود نیست — از بخش پیشرفته اضافه کنید.",
    ready: (l) => `آماده: ${l} · پس از شروع به مایکروفون اجازه دهید.`,
    noGroq: "اول کلید Groq را وارد کنید.", cantStart: "شروع نشد: ",
    testing: "در حال آزمایش…", wrapUp: "در حال اتمام…",
    endedMsg: "پایان یافت — ضبط هنوز قابل دانلود است.",
    translating: "در حال ترجمه…", maxLangs: "حداکثر ۳ — اول یکی را بردارید.",
    langNote: (n) => `${n} · اولی زبان اصلی است؛ حاضرین می‌توانند تغییر دهند.`,
    langWarn: (n) => `${n} — ۳ زبان حدود ۳ برابر مصرف دارد و ممکن است محدود شود.`,
    publishFail: "ارسال ناموفق ",
    codeHint: "قابل ویرایش — همان کد را نگه دارید تا لینک ذخیره‌شده کار کند.",
    codeInvalid: "فقط ۴ تا ۱۲ حرف/عدد.",
    codeTaken: "این کد را دستگاه دیگری گرفته است. کد دیگری انتخاب کنید.",
    codeLocked: "هنگام پخش زنده نمی‌توان کد را تغییر داد.",
    codeSaved: "ذخیره شد — لینک جدید را به اشتراک بگذارید.",
    srcBtn: "متن اصلی",
    connecting: "در حال اتصال…",
    waiting: "آماده — منتظر سخنران",
    notStarted: "این جلسه هنوز شروع نشده",
    sessionEnded: "— پایان جلسه —",
    notFound: "جلسه پیدا نشد",
    checkCode: "کد را بررسی کنید",
    missingCode: "کد جلسه موجود نیست",
    readyHosted: "آماده — نیازی به تنظیم نیست. شروع را بزنید و به مایکروفون اجازه دهید.",
    footTag: "ترجمه و رونویسی زنده",
    footAsk: "سوال یا نظر دارید؟ با پاول در تماس شوید",
    footPriv: "کلیدهای API فقط روی همین دستگاه ذخیره می‌شوند و هرگز به سرور ما فرستاده نمی‌شوند.",
  },
  zh: {
    stateIdle: "未開始", stateLive: "直播中", stateEnded: "已結束",
    tagline: "英文／中文 → 任何語言",
    titleLabel: "這場的標題", titlePh: "主日聚會 · Sunday Service",
    targetsLabel: "翻譯成（最多 3 種 — 選越少越快越省）",
    start: "▶ 開始", stop: "■ 結束", newSession: "↻ 開始新場次",
    download: "下載錄音", settings: "⚙ 設定",
    audienceHead: "觀眾掃這個", copyLink: "複製連結", copied: "已複製 ✓",
    copyManual: "請手動複製", preview: "預覽觀眾畫面",
    advanced: "進階設定 — 詞彙表、背景、來源語言、金鑰",
    glossaryLabel: "詞彙表 — 準確度的最大關鍵",
    glossaryPh: "一行一個：\n雅偉 = یهوه\nPastor Raymond = پاستور ریموند\n羅馬書 = رومیان",
    glossaryHint: "人名、地名、聖經書卷、專有名詞。填這個比換更貴的模型有效。",
    srcLangLabel: "來源語言",
    srcAuto: "自動偵測（中英夾雜）", srcEn: "English", srcZh: "中文",
    contextLabel: "場次背景（給 AI 參考）",
    contextPh: "例：主日講道，講員 Pastor Raymond，羅馬書第八章。",
    keysHead: "金鑰",
    groqLabel: "Groq — 辨識與翻譯都用這一把",
    groqHint: "這一把就夠了。額度用盡時才會換到備援。",
    testKey: "測試金鑰", backupKeys: "備援金鑰（平常不用動）",
    moreGroq: "更多 Groq 金鑰 — 一行一把",
    moreGroqHint: "每把金鑰有自己的額度上限，多備幾把長講道才夠用，系統會自動輪替。",
    keyPool: (n) => `${n} 把 Groq 金鑰輪替中`,
    needGroq: "⚠️ 還沒有 Groq 金鑰 — 打開下面的進階設定填一個。",
    ready: (l) => `已就緒：${l}　·　按開始後請允許麥克風權限。`,
    noGroq: "請先填入 Groq 金鑰。", cantStart: "無法開始：",
    testing: "測試中…", wrapUp: "收尾中…",
    endedMsg: "已結束 — 錄音仍可下載。",
    translating: "翻譯中…", maxLangs: "最多 3 種 — 先取消一個。",
    langNote: (n) => `${n}　·　第一個是主要語言，觀眾可自行切換。`,
    langWarn: (n) => `${n} — 3 種語言會用掉約 3 倍輸出額度，長講道可能觸發限速。`,
    publishFail: "發佈失敗 ",
    codeHint: "可自行修改 — 沿用同一組代碼，舊連結就一直有效。",
    codeInvalid: "只能 4–12 個英數字。",
    codeTaken: "這組代碼已被其他裝置使用，請換一組。",
    codeLocked: "直播中無法更改代碼。",
    codeSaved: "已儲存 — 請分享新連結。",
    srcBtn: "原文",
    connecting: "連線中…",
    waiting: "已就緒 — 等待講者",
    notStarted: "這場尚未開始",
    sessionEnded: "— 已結束 —",
    notFound: "找不到場次",
    checkCode: "請確認代碼",
    missingCode: "缺少場次代碼",
    readyHosted: "已就緒 — 免設定。按開始並允許麥克風權限即可。",
    footTag: "即時聽打與翻譯",
    footAsk: "有問題或建議？聯絡 Paul",
    footPriv: "您的 API 金鑰只存在這台裝置上，不會傳送到我們的伺服器。",
  },
};

const UI_LANGS = [
  { c: "en",  label: "EN" },
  { c: "prs", label: "دری" },
  { c: "zh",  label: "中文" },
];
const RTL_UI = new Set(["prs"]);

function detect() {
  try {
    const saved = localStorage.getItem("live.ui");
    if (saved && DICT[saved]) return saved;
  } catch {}
  return "en";                          // English is the default, always
}

let cur = detect();

export function uiLang() { return cur; }
export function setUiLang(c) {
  if (!DICT[c]) return;
  cur = c;
  try { localStorage.setItem("live.ui", c); } catch {}
  applyI18n();
  window.dispatchEvent(new CustomEvent("ui:lang", { detail: c }));
}
export function t(key, ...args) {
  const v = (DICT[cur] && DICT[cur][key]) ?? DICT.en[key] ?? key;
  return typeof v === "function" ? v(...args) : v;
}

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
  document.documentElement.lang = cur === "zh" ? "zh-Hant" : cur === "prs" ? "prs" : "en";
  // Mirror the whole console for an RTL operator — the layout is flex, so it flips.
  document.documentElement.dir = RTL_UI.has(cur) ? "rtl" : "ltr";
  document.body.classList.toggle("ui-rtl", RTL_UI.has(cur));
}

/** Renders the EN / 中文 switch into `el`. */
export function mountUiSwitch(el) {
  if (!el) return;
  const draw = () => {
    el.innerHTML = UI_LANGS.map((l) =>
      `<button class="uibtn ${l.c === cur ? "on" : ""}" data-ui="${l.c}">${l.label}</button>`).join("");
    for (const b of el.querySelectorAll("[data-ui]")) b.onclick = () => { setUiLang(b.dataset.ui); draw(); };
  };
  draw();
}
