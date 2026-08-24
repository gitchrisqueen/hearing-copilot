#!/usr/bin/env python3
"""Speaker-ID sidecar for Hearing Copilot (Phase 2: shadow + assist). Localhost only.

The browser POSTs each finalized utterance WAV here in parallel with transcription; this embeds
the voice (speaker_engine.py: fixed-length CAM++ embedding, validated in eval/diarization), runs
online clustering, and answers with a verdict. Anonymous clusters map to parties via a histogram
of the "who is speaking" toggle; TAGGED voices (name and/or party via /label, or a /confirm
correction) become persistent profiles stored per case under voice-profiles/<case>/profiles.json,
so the judge enrolled at one hearing is recognized at the next. Voice fingerprints of real people:
local-only by design, git-ignored, deletable via DELETE /profiles/<pid>.

Endpoints (JSON out, CORS open for the localhost app):
  POST /identify?ts=..&voiced=..&hint=<speakerId>&case=<caseId>   body = 16 kHz mono s16 WAV
       -> {ok, ts, decision, cluster, name, speaker, sim, marginPct, clusterN,
           mapped:{speaker,conf,n}|null}
  POST /label    {case, cluster, speaker?, name?}  tag a voice once -> {ok, profile}
  POST /confirm  {case, ts, speaker, name?}  user correction: chunk at ts belongs to speaker;
       trains (or creates) that party's profile on that exact embedding -> {ok, profile|null}
  GET  /voices?case=..   -> {ok, clusters:[{cluster,name,speaker,n,persistent,mapped,lastTs}]}
  GET  /profiles?case=.. -> {ok, profiles:[...persistent only...]}
  DELETE /profiles/<pid>?case=..  forget a stored voice -> {ok, removed}
  GET  /health   -> {ok, model, mode, case, clusters}
  POST /reset?case=..    drop session clusters and hint history, KEEP persistent profiles -> {ok}

Usage: python3 speaker-server.py <port> <model.onnx> [profiles-root]
Needs: pip install sherpa-onnx numpy (launch.command prefers eval/diarization/venv).
"""
import io, json, os, re, sys, threading, time, wave
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speaker_engine import SpeakerEngine  # noqa: E402

# A cluster maps to a party once it has enough toggle history and a clear majority. Below either
# bar the app shows the cluster as "unmatched" and never chips a suggestion from it.
MAP_MIN_CHUNKS = 3
MAP_MIN_SHARE = 0.6
SAVE_DEBOUNCE_S = 10          # passive centroid drift saves at most this often; label/confirm save now


def slug(case_id):
    s = re.sub(r"[^a-z0-9_-]", "", (case_id or "").lower())
    return s or "default"


class State:
    def __init__(self, model_path, profiles_root):
        self.engine = SpeakerEngine(model_path)
        self.lock = threading.Lock()          # sherpa streams are not assumed reentrant
        self.hints = defaultdict(Counter)     # cluster -> Counter of toggle speaker ids
        self.last_ts = {}                     # cluster -> last chunk ts (ms, from the app)
        self.model = os.path.basename(model_path)
        self.profiles_root = profiles_root
        self.case = None                      # bound by the first request that names one
        self.dirty = False
        self.last_save = 0.0

    def store_path(self):
        return os.path.join(self.profiles_root, slug(self.case), "profiles.json")

    def bind_case(self, case_id):
        """First case named by the app wins for this session; loads its stored profiles."""
        if not case_id or self.case is not None:
            return
        self.case = slug(case_id)
        n = self.engine.load(self.store_path())
        print("[speaker] case %s: loaded %d stored voice profile(s)" % (self.case, n), flush=True)

    def save(self, force=False):
        if self.case is None or (not self.dirty and not force):
            return
        if not force and time.time() - self.last_save < SAVE_DEBOUNCE_S:
            return
        self.engine.save(self.store_path())
        self.dirty = False
        self.last_save = time.time()

    def mapped(self, cluster):
        c = self.hints.get(cluster)
        if not c:
            return None
        n = sum(c.values())
        spk, cnt = c.most_common(1)[0]
        if n < MAP_MIN_CHUNKS or cnt / n < MAP_MIN_SHARE:
            return None
        return dict(speaker=spk, conf=round(cnt / n, 3), n=n)

    def voice_row(self, p):
        return dict(cluster=p.pid, name=p.name, speaker=p.speaker, n=p.n,
                    persistent=p.persistent, mapped=self.mapped(p.pid),
                    lastTs=self.last_ts.get(p.pid))


STATE = None


def parse_wav(body):
    with wave.open(io.BytesIO(body), "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16 kHz mono s16 WAV")
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[speaker] " + (fmt % args) + "\n")

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json_body(self):
        n = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        STATE.bind_case((q.get("case") or [None])[0])
        if u.path == "/health":
            self._send(200, dict(ok=True, model=STATE.model, mode="shadow+assist",
                                 case=STATE.case, clusters=len(STATE.engine.profiles)))
        elif u.path == "/voices":
            with STATE.lock:
                out = [STATE.voice_row(p) for p in STATE.engine.profiles]
            self._send(200, dict(ok=True, clusters=out))
        elif u.path == "/profiles":
            with STATE.lock:
                out = [STATE.voice_row(p) for p in STATE.engine.profiles if p.persistent]
            self._send(200, dict(ok=True, profiles=out))
        else:
            self._send(404, dict(ok=False, error="unknown path"))

    def do_DELETE(self):
        u = urlparse(self.path)
        m = re.match(r"^/profiles/([\w:.-]+)$", u.path)
        if not m:
            self._send(404, dict(ok=False, error="unknown path"))
            return
        with STATE.lock:
            removed = STATE.engine.remove(m.group(1))
            STATE.dirty = True
            STATE.save(force=True)
        self._send(200, dict(ok=True, removed=removed))

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/identify":
                self._identify(u, q)
            elif u.path == "/label":
                b = self._json_body()
                STATE.bind_case(b.get("case"))
                with STATE.lock:
                    p = STATE.engine.label(b.get("cluster"), name=b.get("name"),
                                           speaker=b.get("speaker"))
                    STATE.dirty = True
                    STATE.save(force=True)
                    row = STATE.voice_row(p) if p else None
                self._send(200, dict(ok=bool(p), profile=row,
                                     error=None if p else "unknown cluster"))
            elif u.path == "/confirm":
                b = self._json_body()
                STATE.bind_case(b.get("case"))
                with STATE.lock:
                    p = STATE.engine.confirm(int(b.get("ts", 0)), b.get("speaker"),
                                             name=b.get("name"))
                    if p:
                        STATE.hints[p.pid][b.get("speaker")] += 2   # corrections weigh double
                        STATE.dirty = True
                        STATE.save(force=True)
                    row = STATE.voice_row(p) if p else None
                self._send(200, dict(ok=True, profile=row))
            elif u.path == "/reset":
                STATE.bind_case((q.get("case") or [None])[0])
                with STATE.lock:
                    STATE.engine.profiles = [p for p in STATE.engine.profiles if p.persistent]
                    STATE.hints.clear()
                    STATE.last_ts.clear()
                self._send(200, dict(ok=True, kept=len(STATE.engine.profiles)))
            else:
                self._send(404, dict(ok=False, error="unknown path"))
        except Exception as e:
            self._send(200, dict(ok=False, error=str(e)))   # 200 so the browser logs, never breaks

    def _identify(self, u, q):
        ts = int(float(q.get("ts", ["0"])[0]))
        voiced = float(q.get("voiced", ["0"])[0])
        hint = (q.get("hint", [""])[0] or "").strip()
        STATE.bind_case((q.get("case") or [None])[0])
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        samples = parse_wav(body)
        t0 = time.time()
        with STATE.lock:
            v = STATE.engine.identify(samples, voiced, ts=ts)
            cluster = v.get("cluster")
            cluster_n = 0
            if cluster:
                STATE.last_ts[cluster] = ts
                p = [x for x in STATE.engine.profiles if x.pid == cluster]
                cluster_n = p[0].n if p else 0
                if p and p[0].persistent and v.get("decision") == "accept":
                    STATE.dirty = True          # passive EMA drift on a stored profile
            mapped = STATE.mapped(cluster) if cluster else None
            # Count the toggle hint AFTER computing mapped, so this chunk's own hint never
            # vouches for itself (the chip should reflect prior history only).
            if cluster and hint and v.get("decision") in ("accept", "suggest", "new"):
                STATE.hints[cluster][hint] += 1
            STATE.save()
        self._send(200, dict(ok=True, ts=ts, decision=v.get("decision"), cluster=cluster,
                             name=v.get("name"), speaker=v.get("speaker"), sim=v.get("sim"),
                             marginPct=v.get("margin_pct"), clusterN=cluster_n,
                             mapped=mapped, ms=round((time.time() - t0) * 1000)))


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: speaker-server.py <port> <model.onnx> [profiles-root]")
    port, model = int(sys.argv[1]), sys.argv[2]
    root = sys.argv[3] if len(sys.argv) > 3 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "voice-profiles")
    if not os.path.isfile(model):
        sys.exit("model not found: " + model)
    global STATE
    STATE = State(model, root)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("[speaker] ready on %d (model %s, profiles under %s)" % (port, STATE.model, root),
          flush=True)
    try:
        srv.serve_forever()
    finally:
        STATE.save(force=True)


if __name__ == "__main__":
    main()
