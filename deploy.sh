#!/bin/bash
# Spark Live deploy.
#
# Exists because two separate incidents came from publishing the wrong
# config.js: once the dev machine's key-bearing file was served publicly by the
# dev site (all eight Groq keys readable by anyone who asked for /config.js),
# and once a deploy that simply omitted the file knocked the hosted site out of
# proxy mode so the presenter console demanded a key it does not need.
#
# So the swap is no longer done by hand:
#   public/config.js   — dev only, real keys, gitignored, never published
#   config.hosted.js   — what ships, published AS config.js, no keys
#
# It also greps the exact tree it is about to upload and refuses to continue if
# anything key-shaped is in it. The restore runs on every exit path, including
# a failed deploy or a Ctrl-C, so the dev file is never left displaced.
#
# Usage:  ./deploy.sh prod     -> spark-live-translate.netlify.app
#         ./deploy.sh dev      -> spark-live-dev.netlify.app
#         ./deploy.sh both
set -euo pipefail
cd "$(dirname "$0")"

PROD_SITE=dfc66b59-da3d-4526-87a1-999e9b101977
DEV_SITE=67cd303e-eaf8-4fc4-9e9d-516ba4a29110

# CI has no Mac-local checkout to borrow the CLI from, and this machine has no
# global install — resolve whichever exists rather than hardcoding either.
if [ -n "${NETLIFY_CLI:-}" ]; then NETLIFY="$NETLIFY_CLI"
elif [ -x "$HOME/Documents/CodingProject/SmartHome/node_modules/.bin/netlify" ]; then
  NETLIFY="$HOME/Documents/CodingProject/SmartHome/node_modules/.bin/netlify"
elif command -v netlify >/dev/null 2>&1; then NETLIFY="$(command -v netlify)"
else NETLIFY="npx --yes netlify-cli"
fi

STASH=".config.dev.stashed"
restore() {
  if [ -f "$STASH" ]; then mv -f "$STASH" public/config.js; fi
}
trap restore EXIT INT TERM

if [ ! -f config.hosted.js ]; then echo "missing config.hosted.js"; exit 1; fi
if [ -f public/config.js ]; then mv public/config.js "$STASH"; fi
cp config.hosted.js public/config.js

# The gate. Scan what is actually about to be uploaded, not what we intended.
if grep -rlE 'gsk_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|re_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}' public netlify 2>/dev/null; then
  echo "ABORT: a credential is present in the publish tree (files above)."
  exit 1
fi
echo "publish tree clean — no credentials"

deploy_to() {
  echo
  echo "── deploying to $1 ──"
  $NETLIFY deploy --prod --site "$2" \
    --dir public --functions netlify/functions \
    --message "${3:-manual deploy}"
}

case "${1:-}" in
  prod) deploy_to prod "$PROD_SITE" "${2:-}" ;;
  dev)  deploy_to dev  "$DEV_SITE"  "${2:-}" ;;
  both) deploy_to prod "$PROD_SITE" "${2:-}"; deploy_to dev "$DEV_SITE" "${2:-}" ;;
  *)    echo "usage: ./deploy.sh {prod|dev|both} [message]"; exit 1 ;;
esac

echo
echo "── post-deploy check ──"
for host in spark-live-translate spark-live-dev; do
  cfg=$(curl -s -m 20 "https://$host.netlify.app/config.js" || true)
  keys=$(printf '%s' "$cfg" | grep -coE 'gsk_[A-Za-z0-9]{20,}' || true)
  proxy=$(printf '%s' "$cfg" | grep -c 'proxy' || true)
  printf "  %-22s keys=%s  proxy-mode=%s\n" "$host" "$keys" "$([ "$proxy" -gt 0 ] && echo yes || echo NO)"
done
