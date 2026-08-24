#!/bin/bash
# Hearing Copilot launcher (macOS). Double-click to run.
# Bootstraps dependencies (npm + a Python venv with copilot-core), then starts: (1) the web app,
# (2) Ollama on a unique port (local LLM fallback), (3) a local whisper.cpp server for
# transcription, (4) the transcript log writer, (5) the voice-ID sidecar. Then opens the browser.
# Services it starts are stopped when you close this window / press Ctrl+C.
#
# Override paths if needed:
#   WHISPER_SERVER_BIN=/path/to/whisper-server  WHISPER_MODEL=/path/to/ggml-base.en.bin  ./launch.command
#
# Integration knobs (all optional; set by the private monorepo's own launch.command wrapper in
# Phase D re-integration -- a standalone checkout of this repo needs none of them):
#   COPILOT_SERVE_ROOT    serve a directory ABOVE this repo (e.g. so /cases/... paths resolve from
#                          a sibling case-documents tree). Defaults to this repo's own directory.
#   COPILOT_HEARINGS_DIR  where hearing profiles live. Defaults to <this repo>/hearings.
#   COPILOT_ENV_FILE      where the .env secrets file is. Defaults to <this repo>/.env.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # this repo's own directory

# ---- Hearing profile (interchangeable via launch arg) ----
# Usage: ./launch.command [profile]   e.g.  ./launch.command example
HEARINGS_DIR="${COPILOT_HEARINGS_DIR:-$DIR/hearings}"
export COPILOT_HEARINGS_DIR="$HEARINGS_DIR"
DEFAULT_HEARING="example"
HEARING="${1:-$DEFAULT_HEARING}"
if [ ! -f "$HEARINGS_DIR/$HEARING/data.js" ]; then
  echo "Unknown hearing profile: '$HEARING'"
  echo "Available profiles:"; ls -1 "$HEARINGS_DIR" 2>/dev/null | sed 's/^/  /'
  echo "Usage: ./launch.command [profile]    e.g.  ./launch.command example"
  exit 1
fi
export HEARING

SERVE_ROOT="${COPILOT_SERVE_ROOT:-$DIR}"
export COPILOT_SERVE_ROOT="$SERVE_ROOT"
ENV_FILE="${COPILOT_ENV_FILE:-$DIR/.env}"
export COPILOT_ENV_FILE="$ENV_FILE"

WEB_PORT=8777
OLLAMA_PORT=11500
WHISPER_PORT=8089
LOGSRV_PORT=8790
SPK_PORT=8791

# The app's own URL path, relative to whatever root is actually being served (usually this repo's
# own directory; the monorepo wrapper serves a directory above it, so this may be a subpath).
RELPATH="$(python3 -c "import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$DIR" "$SERVE_ROOT")"
if [ "$RELPATH" = "." ]; then URL="http://localhost:${WEB_PORT}/index.html"
else URL="http://localhost:${WEB_PORT}/${RELPATH}/index.html"; fi

PIDS=()
LOGDIR="$DIR/logs"
mkdir -p "$LOGDIR"
port_busy() { lsof -i ":$1" >/dev/null 2>&1; }
cleanup() { echo; echo "Stopping services..."; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

echo "Hearing Copilot"
echo "Repo:    $DIR"
echo "Serving: $SERVE_ROOT"
echo "Hearing: $HEARING   (switch: ./launch.command <profile>)"
echo

# ---- 0) Bootstrap: npm install (the copilot-core JS package) + a Python venv with copilot-core
# installed (used by web-server.py and log-server.py). Idempotent -- skipped once already
# installed. The speaker-ID sidecar has its own separate venv (step 5) since it needs
# sherpa-onnx/numpy, not copilot-core. ----
if [ ! -d "$DIR/node_modules/@gitchrisqueen/copilot-core" ]; then
  echo "[setup]   installing npm dependencies (@gitchrisqueen/copilot-core)..."
  ( cd "$DIR" && npm install ) || echo "[setup]   npm install failed; the app's core scripts will 404. Run 'npm install' manually."
fi
CORE_VENV="$DIR/.venv"
if [ ! -x "$CORE_VENV/bin/python" ]; then
  echo "[setup]   creating a Python venv for the web/log servers (.venv)..."
  python3 -m venv "$CORE_VENV" 2>/dev/null
fi
if [ -x "$CORE_VENV/bin/python" ] && ! "$CORE_VENV/bin/python" -c "import copilot_core" >/dev/null 2>&1; then
  echo "[setup]   installing copilot-core into .venv..."
  "$CORE_VENV/bin/pip" install -q -r "$DIR/requirements.txt" \
    || echo "[setup]   copilot-core install failed; web/log servers will not start."
fi
CORE_PY="$CORE_VENV/bin/python"
[ -x "$CORE_PY" ] || CORE_PY="$(command -v python3 || true)"

# ---- 1) Web server (serves the app +, when COPILOT_SERVE_ROOT points elsewhere, sibling docs) ----
if port_busy "$WEB_PORT"; then
  echo "[web]     port $WEB_PORT already in use; reusing it."
else
  "$CORE_PY" "$DIR/app/web-server.py" "$SERVE_ROOT" "$WEB_PORT" >"$LOGDIR/web.log" 2>&1 &
  PIDS+=($!); echo "[web]     serving on $WEB_PORT (no-cache; log: logs/web.log)"
fi

# ---- 2) Ollama (local LLM fallback) on a unique port ----
if command -v ollama >/dev/null 2>&1; then
  if port_busy "$OLLAMA_PORT"; then
    echo "[ollama]  port $OLLAMA_PORT already in use; reusing it."
  else
    OLLAMA_HOST="127.0.0.1:${OLLAMA_PORT}" OLLAMA_ORIGINS="http://localhost:${WEB_PORT}" ollama serve >"$LOGDIR/ollama.log" 2>&1 &
    PIDS+=($!); echo "[ollama]  serving on $OLLAMA_PORT (log: logs/ollama.log)"
  fi
else
  echo "[ollama]  not installed; skipping (app uses the cloud model or keyword fallback)."
fi

# ---- 3) whisper.cpp server for transcription ----
WBIN="${WHISPER_SERVER_BIN:-}"
if [ -z "$WBIN" ]; then
  if command -v whisper-server >/dev/null 2>&1; then WBIN="$(command -v whisper-server)"
  elif [ -x "$HOME/whisper.cpp/build/bin/whisper-server" ]; then WBIN="$HOME/whisper.cpp/build/bin/whisper-server"
  fi
fi
WMODEL="${WHISPER_MODEL:-$HOME/whisper-models/ggml-base.en.bin}"
if [ -n "$WBIN" ] && [ -f "$WMODEL" ]; then
  if port_busy "$WHISPER_PORT"; then
    echo "[whisper] port $WHISPER_PORT already in use; reusing it."
  else
    WTHREADS="${WHISPER_THREADS:-8}"
    "$WBIN" -m "$WMODEL" --host 127.0.0.1 --port "$WHISPER_PORT" -t "$WTHREADS" >"$LOGDIR/whisper.log" 2>&1 &
    PIDS+=($!); echo "[whisper] serving on $WHISPER_PORT (model: $(basename "$WMODEL"); ${WTHREADS} threads; log: logs/whisper.log)"
  fi
else
  echo "[whisper] not started. Need whisper-server + a model."
  echo "          binary: ${WBIN:-not found}   model: $WMODEL $( [ -f "$WMODEL" ] || echo '(missing)')"
  echo "          See README 'Local models and audio setup'."
fi

# ---- 4) transcript log writer (durable on-disk transcript) ----
if port_busy "$LOGSRV_PORT"; then
  echo "[log]     port $LOGSRV_PORT already in use; reusing it."
else
  "$CORE_PY" "$DIR/app/log-server.py" "$LOGDIR" "$LOGSRV_PORT" >"$LOGDIR/logserver.log" 2>&1 &
  PIDS+=($!); echo "[log]     transcript writer on $LOGSRV_PORT -> logs/transcript-<date>.jsonl"
  ( sleep 4; line="$(grep -m1 '\[asr\]' "$LOGDIR/logserver.log" 2>/dev/null)"; [ -n "$line" ] && echo "$line" ) &
fi

# ---- 5) speaker-ID sidecar (voice auto-detection, shadow mode) ----
# Fingerprints each utterance so the app can suggest who is speaking. Needs python with
# sherpa-onnx + numpy; its own venv (separate from the core venv above, since speaker_engine.py
# is app-local and doesn't need copilot-core). The app works fine without it (toggle-only
# tagging), so every failure here just skips the service.
SPKSRV="$DIR/app/speaker-server.py"
SPK_MODEL="${SPEAKER_MODEL:-$DIR/eval/diarization/models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx}"
SPK_VENV="$DIR/eval/diarization/venv"
if [ ! -x "$SPK_VENV/bin/python" ]; then
  python3 -m venv "$SPK_VENV" 2>/dev/null
  [ -x "$SPK_VENV/bin/python" ] && "$SPK_VENV/bin/pip" install -q -r "$DIR/eval/diarization/requirements.txt" 2>/dev/null
fi
SPK_PY="$SPK_VENV/bin/python"
[ -x "$SPK_PY" ] || SPK_PY="$(command -v python3 || true)"
if [ -f "$SPKSRV" ] && [ -n "$SPK_PY" ]; then
  if [ ! -f "$SPK_MODEL" ] && command -v curl >/dev/null 2>&1; then
    echo "[speaker] voice model missing; downloading (~28 MB, one time)..."
    mkdir -p "$(dirname "$SPK_MODEL")"
    curl -sfL --max-time 180 -o "$SPK_MODEL" \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx" \
      || { rm -f "$SPK_MODEL"; echo "[speaker] download failed; voice auto-ID off this session."; }
  fi
  if [ -f "$SPK_MODEL" ]; then
    if port_busy "$SPK_PORT"; then
      echo "[speaker] port $SPK_PORT already in use; reusing it."
    elif "$SPK_PY" -c "import sherpa_onnx, numpy" >/dev/null 2>&1; then
      "$SPK_PY" "$SPKSRV" "$SPK_PORT" "$SPK_MODEL" "$DIR/voice-profiles" >"$LOGDIR/speaker.log" 2>&1 &
      PIDS+=($!); echo "[speaker] voice auto-ID (shadow) on $SPK_PORT (log: logs/speaker.log)"
    else
      echo "[speaker] python deps missing; voice auto-ID off. To enable:"
      echo "          cd hearing-copilot/eval/diarization && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt"
    fi
  fi
fi

echo
echo "Open: $URL"
echo "Leave this window open. Press Ctrl+C to stop."
sleep 1
open "$URL"

# Keep running until interrupted.
while true; do sleep 3600; done
