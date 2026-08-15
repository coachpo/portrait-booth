#!/bin/sh
# Start the app for a live demo.
#
# Three things go wrong when the dev servers are started by hand, and this
# script exists to make all three impossible rather than remembered:
#
#   1. The retrieval rate limit defaults to 30 per hour per IP (SPEC §9.3).
#      Behind the vite dev proxy the backend sees 127.0.0.1 for every device,
#      so that budget is shared by the whole room, and going over it answers
#      "photo unavailable" - indistinguishable from data loss, right after the
#      product has claimed a 30-day retention.
#   2. Every KEY and delete secret is derived from PORTRAIT_SECRET_KEY_BASE.
#      A fresh key per launch silently invalidates the codes generated during
#      rehearsal, so the key is persisted to .env on first run.
#   3. Staged photos live for the TTL, so the previous audience's photos are
#      still there during the privacy part of the next demo. --reset clears
#      them deliberately.
#
# Usage:
#   scripts/demo.sh            start backend and frontend
#   scripts/demo.sh --reset    wipe staged photos and the database first
#
# Open http://localhost:5173 - localhost is a secure context, so the camera and
# the Secure session cookie both work. Reaching the same server over a plain
# http://<LAN-IP> disables the camera and blocks staging by design.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

command -v uv >/dev/null 2>&1 || { echo "uv is not installed: https://docs.astral.sh/uv/" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is not installed (Node.js 24+ required)" >&2; exit 1; }

# .env is gitignored; the key is generated once and reused so retrieval codes
# survive a restart between rehearsal and the demo itself.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

if [ -z "${PORTRAIT_SECRET_KEY_BASE:-}" ]; then
  echo "no PORTRAIT_SECRET_KEY_BASE found; generating one into .env"
  KEY=$(uv run --directory backend python -c \
    "import secrets,base64;print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())")
  printf 'PORTRAIT_SECRET_KEY_BASE=%s\n' "$KEY" >> .env
  PORTRAIT_SECRET_KEY_BASE=$KEY
  export PORTRAIT_SECRET_KEY_BASE
fi

if [ "$RESET" -eq 1 ]; then
  echo "clearing staged photos and the database (backend/data)"
  rm -rf backend/data
fi

# Demo-only headroom. These raise a limit, they never disable it, and they are
# per-process: nothing here is written to a config file, so a normal launch is
# unaffected. Do not carry these values to a deployment reachable by strangers -
# the 6-character code space is enumerable without a tight per-IP cap.
export PORTRAIT_RESOLVE_IP_LIMIT="${PORTRAIT_RESOLVE_IP_LIMIT:-1000}"
export PORTRAIT_RESOLVE_FAIL_LIMIT="${PORTRAIT_RESOLVE_FAIL_LIMIT:-50}"

BACKEND_PID=""
FRONTEND_PID=""
cleanup() {
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "backend  : http://localhost:8000  (retrieval cap ${PORTRAIT_RESOLVE_IP_LIMIT}/hour per IP)"
echo "frontend : http://localhost:5173"
echo

(cd backend && uv run uvicorn app.main:app --port 8000) &
BACKEND_PID=$!

(cd frontend && npm run dev) &
FRONTEND_PID=$!

# Exit as soon as either side dies, rather than leaving half a stack running
# and a browser tab that half works.
wait -n 2>/dev/null || wait
