// Spark Live — HOSTED site config. This is the file that ships.
//
// It carries no key and never will: on a hosted deployment the Groq pool lives
// in the site's GROQ_KEY_POOL environment variable and is added server-side by
// /api/asr and /api/chat, so the browser never sees one. `proxy: true` is what
// puts the presenter console into "no setup needed" mode.
//
// The dev machine keeps a different public/config.js containing real keys for
// working without the proxy. That file is gitignored AND must never be
// published — it was once served publicly by the dev site, exposing the whole
// pool. Deploys therefore publish THIS file as config.js instead; see
// deploy.sh, which swaps them and refuses to run if a key reaches the tree.
window.SPARK_LIVE_CONFIG = {
  proxy: true,
  // Gemini streaming ASR through the relay Worker in relay/. A URL here is NOT
  // a credential — the Gemini key stays in the Worker's secret store, which is
  // the entire reason the relay exists. Filling this in is what makes the
  // Gemini option usable with no key typed on any device; left empty, the
  // option stays disabled unless a presenter supplies their own key.
  //   wss://spark-live-asr.<your-subdomain>.workers.dev/asr
  // The Worker gates on Origin, not on a code in this URL — a code shipped here
  // would be readable by every visitor and protect nothing.
  asrRelay: "wss://spark-live-asr.lsy95112.workers.dev/asr",
  defaults: {
    lang: "auto",
    title: "Sunday Service",
  },
};
