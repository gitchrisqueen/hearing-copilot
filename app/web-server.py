#!/usr/bin/env python3
"""Static file server for Hearing Copilot. Thin wrapper: the no-cache handler and %KEY% secret
injection live in copilot_core.webserver -- this file adds the one thing that's specific to this
app: serving the active hearing profile's data.js (window.CASE) as a virtual route, the same way
it always has.

Usage: python3 web-server.py <root-dir> <port>

Env vars (all optional, used by the private monorepo wrapper in Phase D re-integration; a
standalone checkout of this repo needs none of them):
  COPILOT_HEARINGS_DIR   where hearing profiles live (default: <this repo>/hearings)
  COPILOT_ENV_FILE       where the .env secrets file is (default: <this repo>/.env)
  HEARING                which profile is active (default: example)
"""
import os
import sys

from copilot_core.webserver import serve

APPDIR = os.path.dirname(os.path.abspath(__file__))          # .../hearing-copilot/app
REPO_DIR = os.path.join(APPDIR, "..")                         # .../hearing-copilot
ROOT = sys.argv[1] if len(sys.argv) > 1 else REPO_DIR
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8777
ENV_PATH = os.environ.get("COPILOT_ENV_FILE") or os.path.join(REPO_DIR, ".env")
CONFIG_PATH = os.path.join(APPDIR, "config.js")
KEYS = ("OPENAI_API_KEY", "GROQ_API_KEY", "OLLAMA_API_KEY", "TOGETHER_API_KEY")

# Interchangeable hearing profile. launch.command exports HEARING=<profile>; a request for
# /app/data.js is served from <HEARINGS_DIR>/<HEARING>/data.js (the active window.CASE). Switch
# hearings by relaunching with a different profile: ./launch.command <profile>
HEARING = os.environ.get("HEARING", "example")
HEARINGS_DIR = os.environ.get("COPILOT_HEARINGS_DIR") or os.path.join(REPO_DIR, "hearings")
DATA_PATH = os.path.join(HEARINGS_DIR, HEARING, "data.js")


def render_data():
    """Serve the active hearing profile's data.js (window.CASE) for /app/data.js."""
    try:
        with open(DATA_PATH, encoding="utf-8") as f:
            return f.read().encode("utf-8")
    except FileNotFoundError:
        avail = ", ".join(sorted(os.listdir(HEARINGS_DIR))) if os.path.isdir(HEARINGS_DIR) else "(none)"
        return (("/* Hearing profile %r not found at %s. Available: %s */\n"
                 "window.CASE = { title: 'Hearing profile not found: %s', hearingConfig:{}, parties:{}, "
                 "priority:{}, linchpins:[], traps:[], powerPhrases:[], docPaths:{}, defendantsTabs:[], "
                 "plaintiffTabs:[], rebuttals:[], objections:[], preservationTail:'' };")
                % (HEARING, DATA_PATH, avail, HEARING)).encode("utf-8")


if __name__ == "__main__":
    _drel = os.path.relpath(DATA_PATH, ROOT) if os.path.exists(DATA_PATH) else "MISSING (%s)" % DATA_PATH
    print("[web] hearing profile: %s  (/app/data.js -> %s)" % (HEARING, _drel), flush=True)
    serve(root=ROOT, port=PORT, config_path=CONFIG_PATH, env_path=ENV_PATH, keys=KEYS,
          routes={"/app/data.js": render_data})
