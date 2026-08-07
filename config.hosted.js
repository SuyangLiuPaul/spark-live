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
  defaults: {
    lang: "auto",
    title: "Sunday Service",
  },
};
