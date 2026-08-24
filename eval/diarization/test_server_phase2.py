# Server-level regression test for the Phase 2 sidecar: tag-once labeling, confirm-training,
# per-case persistence across a server restart, delete, and reset semantics. Uses real courtroom
# chunks from the Bowe asset (run oyez_fetch first) and a scratch profiles dir.
#
#   ./venv/bin/python test_server_phase2.py
#
# Exits nonzero on the first failed assertion. Prints one line per check.

import io, json, os, shutil, subprocess, sys, tempfile, time, urllib.request, wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "..", "app")
MODEL = os.path.join(HERE, "models", "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx")
AUDIO = os.path.join(HERE, "assets", "2025-24-5438", "audio-16k.wav")
TRUTH = os.path.join(HERE, "assets", "2025-24-5438", "ground_truth.json")
PORT = 8797
BASE = "http://localhost:%d" % PORT
CASE = "test-case"


def wav_bytes(x):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    return b.getvalue()


def call(path, data=None, method=None):
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"}
                                 if data and not path.startswith("/identify") else {})
    return json.load(urllib.request.urlopen(req, timeout=20))


def identify(chunk, ts, hint=""):
    req = urllib.request.Request(
        "%s/identify?ts=%d&voiced=6000&hint=%s&case=%s" % (BASE, ts, hint, CASE),
        data=wav_bytes(chunk), headers={"Content-Type": "audio/wav"})
    return json.load(urllib.request.urlopen(req, timeout=20))


def start_server(root):
    proc = subprocess.Popen([sys.executable, os.path.join(APP, "speaker-server.py"),
                             str(PORT), MODEL, root],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            call("/health?case=" + CASE)
            return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    sys.exit("server did not come up")


def check(label, ok):
    print(("PASS  " if ok else "FAIL  ") + label)
    if not ok:
        sys.exit(1)


def main():
    with wave.open(AUDIO, "rb") as w:
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16) \
                    .astype(np.float32) / 32768.0
    turns = json.load(open(TRUTH))["turns"]

    def clip(speaker, idx, dur=6):
        ts = [t for t in turns if t["speaker"] == speaker and t["stop"] - t["start"] > dur + 2]
        t = ts[idx]
        s = int((t["start"] + 1) * 16000)
        return samples[s:s + 16000 * dur]

    root = tempfile.mkdtemp(prefix="hc-voice-test-")
    proc = start_server(root)
    try:
        # 1) two voices cluster apart
        v1 = identify(clip("Andrew L. Adler", 0), ts=1000, hint="plaintiff")
        v2 = identify(clip("Clarence Thomas", 0), ts=2000, hint="court")
        v3 = identify(clip("Andrew L. Adler", 1), ts=3000, hint="plaintiff")
        check("distinct clusters for distinct voices", v1["cluster"] != v2["cluster"])
        check("same voice re-identified", v3["cluster"] == v1["cluster"]
              and v3["decision"] == "accept")
        check("verdict carries no name before labeling", not v3.get("name"))

        # 2) tag once
        r = call("/label", json.dumps(dict(case=CASE, cluster=v1["cluster"],
                                           speaker="plaintiff", name="Adler Test")).encode())
        check("label ok", r["ok"] and r["profile"]["persistent"])
        v4 = identify(clip("Andrew L. Adler", 2), ts=4000, hint="plaintiff")
        check("post-label verdict carries name+party",
              v4.get("name") == "Adler Test" and v4.get("speaker") == "plaintiff")

        # 3) confirm trains (creates the court party profile from Thomas's chunk at ts=2000)
        r = call("/confirm", json.dumps(dict(case=CASE, ts=2000, speaker="court",
                                             name="Judge Test")).encode())
        check("confirm creates/trains party profile",
              r["ok"] and r["profile"] and r["profile"]["speaker"] == "court")
        v5 = identify(clip("Clarence Thomas", 1), ts=5000, hint="court")
        check("confirmed voice recognized with party",
              v5.get("speaker") == "court" or v5["cluster"] == v2["cluster"])

        # 4) reset keeps persistent profiles, drops anonymous clusters
        before = call("/voices?case=" + CASE)["clusters"]
        call("/reset?case=" + CASE, data=b"")
        after = call("/voices?case=" + CASE)["clusters"]
        check("reset keeps only persistent profiles",
              len(after) < len(before) and all(p["persistent"] for p in after))

        # 5) persistence across a restart
        proc.terminate(); proc.wait(timeout=10)
        proc = start_server(root)
        v6 = identify(clip("Andrew L. Adler", 3), ts=6000)
        check("stored profile recognized after restart on first chunk",
              v6.get("name") == "Adler Test" and v6.get("speaker") == "plaintiff")
        profs = call("/profiles?case=" + CASE)["profiles"]
        check("profiles listed", any(p["name"] == "Adler Test" for p in profs))

        # 6) delete forgets the voice
        pid = [p for p in profs if p["name"] == "Adler Test"][0]["cluster"]
        r = call("/profiles/" + pid + "?case=" + CASE, method="DELETE")
        check("delete removes stored profile", r["ok"] and r["removed"])
        v7 = identify(clip("Andrew L. Adler", 4), ts=7000)
        check("deleted voice is anonymous again", not v7.get("name"))
        print("ALL PASS")
    finally:
        proc.terminate()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
