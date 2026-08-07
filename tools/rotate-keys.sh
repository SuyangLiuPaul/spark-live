#!/bin/bash
# Rotate the provider keys everywhere they live, in one pass.
#
# Written after the dev site publicly served /config.js containing all eight
# Groq keys plus the Gemini, Kimi and GLM ones. Rotating them by hand means
# touching four places — the local env file, the browser pre-config, and the
# GROQ_KEY_POOL variable on two Netlify sites — and missing one leaves either a
# dead pool or a live exposed key. Both failures are silent.
#
# You create the new keys in each provider's console (nothing here can do that).
# This does everything after: validates every new key against the real API
# BEFORE writing anything, updates all four locations, tells you which old keys
# are still live and therefore still need revoking, and finishes by running the
# smoke suite against both sites.
#
# Usage:
#   1. Create new keys in the provider consoles.
#   2. Write them to ~/.config/spark-transcribe/new-keys.env:
#
#        GROQ_KEY_POOL=gsk_aaa,gsk_bbb,gsk_ccc
#        GEMINI_API_KEY=AIza...        # optional
#        KIMI_API_KEY=...              # optional
#        GLM_API_KEY=...               # optional
#
#   3. ./tools/rotate-keys.sh
#   4. Revoke the old keys in the consoles, then re-run with --verify.
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="$HOME/.config/spark-transcribe/spark.env"
NEW_FILE="$HOME/.config/spark-transcribe/new-keys.env"
CONFIG_JS="public/config.js"
PROD_SITE=dfc66b59-da3d-4526-87a1-999e9b101977
DEV_SITE=67cd303e-eaf8-4fc4-9e9d-516ba4a29110

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
tail4() { printf '...%s' "${1: -4}"; }        # never print a whole key

netlify_token() {
  python3 -c "import json,os;print(list(json.load(open(os.path.expanduser('~/Library/Preferences/netlify/config.json')))['users'].values())[0]['auth']['token'])"
}

# ── which of the CURRENT keys still work? ────────────────────────────────
# The point of rotation is that these stop working. Until every one reports
# dead, the exposure is still open.
verify_old() {
  bold "Old keys still accepted by Groq (these still need revoking):"
  local any=0 n=0
  while read -r k; do
    [ -z "$k" ] && continue
    n=$((n + 1))
    local code
    code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' https://api.groq.com/openai/v1/models -H "Authorization: Bearer $k")
    if [ "$code" = "200" ]; then red "  $(tail4 "$k")  STILL LIVE"; any=1
    else grn "  $(tail4 "$k")  revoked ($code)"; fi
  done < <(grep -oE 'gsk_[A-Za-z0-9]+' "$ENV_FILE" | sort -u)
  [ "$n" -eq 0 ] && echo "  (no groq keys found in $ENV_FILE)"
  return $any
}

if [ "${1:-}" = "--verify" ]; then verify_old; exit $?; fi

# ── read and validate the new keys BEFORE touching anything ──────────────
[ -f "$NEW_FILE" ] || { red "missing $NEW_FILE — see the usage note at the top of this script"; exit 1; }
# shellcheck disable=SC1090
NEW_GROQ=$(grep -E '^GROQ_KEY_POOL=' "$NEW_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
NEW_GEMINI=$(grep -E '^GEMINI_API_KEY=' "$NEW_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
NEW_KIMI=$(grep -E '^KIMI_API_KEY=' "$NEW_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
NEW_GLM=$(grep -E '^GLM_API_KEY=' "$NEW_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")

[ -n "$NEW_GROQ" ] || { red "GROQ_KEY_POOL is required in $NEW_FILE"; exit 1; }

bold "Validating new keys against the live APIs"
IFS=',' read -ra GROQ_KEYS <<< "$(echo "$NEW_GROQ" | tr -d '[:space:]')"
fail=0
for k in "${GROQ_KEYS[@]}"; do
  [ -z "$k" ] && continue
  code=$(curl -s -m 25 -o /dev/null -w '%{http_code}' https://api.groq.com/openai/v1/models -H "Authorization: Bearer $k")
  if [ "$code" = "200" ]; then grn "  groq $(tail4 "$k")  ok"; else red "  groq $(tail4 "$k")  HTTP $code"; fail=1; fi
done
if [ -n "$NEW_GEMINI" ]; then
  code=$(curl -s -m 25 -o /dev/null -w '%{http_code}' "https://generativelanguage.googleapis.com/v1beta/models?key=$NEW_GEMINI")
  if [ "$code" = "200" ]; then grn "  gemini $(tail4 "$NEW_GEMINI")  ok"; else red "  gemini $(tail4 "$NEW_GEMINI")  HTTP $code"; fail=1; fi
fi
# A bad key must never reach the sites: a half-rotated pool is worse than an
# un-rotated one, because it fails during a service instead of right now.
[ "$fail" -eq 0 ] || { red "aborting — nothing written"; exit 1; }

# ── 1. local env file ────────────────────────────────────────────────────
bold "Updating $ENV_FILE"
cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
python3 - "$ENV_FILE" "$NEW_GROQ" "$NEW_GEMINI" "$NEW_KIMI" "$NEW_GLM" <<'PY'
import sys, re
path, groq, gem, kimi, glm = sys.argv[1:6]
first = groq.split(",")[0]
repl = {
    "SPARK_GROQ_KEY_POOL": groq,
    "SPARK_GROQ_API_KEY": first,
}
if gem:  repl["SPARK_GEMINI_API_KEY"] = gem
if kimi: repl["KIMI_API_KEY"] = kimi
if glm:  repl["SPARK_GLM_API_KEY"] = glm

lines = open(path).read().split("\n")
seen = set()
for i, ln in enumerate(lines):
    m = re.match(r'^([A-Z0-9_]+)=', ln)
    if m and m.group(1) in repl:
        lines[i] = f"{m.group(1)}={repl[m.group(1)]}"
        seen.add(m.group(1))
for k, v in repl.items():
    if k not in seen: lines.append(f"{k}={v}")
open(path, "w").write("\n".join(lines))
print("   " + ", ".join(sorted(repl)))
PY
chmod 600 "$ENV_FILE"

# ── 2. the browser pre-config used for local development ─────────────────
bold "Regenerating $CONFIG_JS"
python3 - "$CONFIG_JS" "$NEW_GROQ" "$NEW_GEMINI" "$NEW_KIMI" "$NEW_GLM" <<'PY'
import sys, json
path, groq, gem, kimi, glm = sys.argv[1:6]
keys = [k for k in groq.split(",") if k]
cfg = {"groqKey": keys[0], "geminiKey": gem, "kimiKey": kimi, "glmKey": glm,
       "defaults": {"lang": "auto", "title": "Sunday Service"}, "groqKeys": keys}
open(path, "w").write(
    "// Spark Live — DEV pre-config. Gitignored: never commit, never deploy.\n"
    "// Regenerate with tools/rotate-keys.sh. deploy.sh swaps this out for\n"
    "// config.hosted.js and refuses to publish a tree containing a key.\n"
    "window.SPARK_LIVE_CONFIG = " + json.dumps(cfg, indent=2) + ";\n")
print(f"   {len(keys)} groq keys written")
PY

# ── 3. both Netlify sites ────────────────────────────────────────────────
bold "Updating GROQ_KEY_POOL on Netlify"
TOKEN=$(netlify_token)
ACC=$(curl -s -H "Authorization: Bearer $TOKEN" "https://api.netlify.com/api/v1/accounts" \
        | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['slug'])")
for pair in "prod:$PROD_SITE" "dev:$DEV_SITE"; do
  name=${pair%%:*}; sid=${pair##*:}
  # PUT replaces the value for an existing key; the API rejects `scopes` on
  # this plan, so it is deliberately omitted.
  out=$(curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
    "https://api.netlify.com/api/v1/accounts/$ACC/env/GROQ_KEY_POOL?site_id=$sid" \
    -d "$(python3 -c "import json,sys;print(json.dumps({'context':'all','value':sys.argv[1]}))" "$NEW_GROQ")" \
    -w '|%{http_code}')
  code=${out##*|}
  if [ "$code" = "200" ] || [ "$code" = "201" ]; then grn "  $name updated"; else red "  $name FAILED (HTTP $code)"; fi
done

# ── 4. redeploy, so the functions pick the new pool up ───────────────────
bold "Redeploying both sites"
./deploy.sh both "rotate keys" >/dev/null 2>&1 && grn "  deployed" || red "  deploy failed — run ./deploy.sh both"

# ── 5. prove it works, and say what is still exposed ─────────────────────
bold "Smoke test"
node tools/smoke.mjs https://spark-live-dev.netlify.app       | tail -1
node tools/smoke.mjs https://spark-live-translate.netlify.app | tail -1

echo
verify_old || true
echo
bold "Now: revoke the old keys in the provider consoles, then re-run"
echo "  ./tools/rotate-keys.sh --verify"
echo "  rm $NEW_FILE"
