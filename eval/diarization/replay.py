# Replay a recording through the app's exact VAD chunking and the speaker engine, writing one
# JSONL verdict per chunk. This is the bake-off driver (SPEAKER-AUTO-ID-PLAN.md section 10.2).
#
#   python replay.py --audio assets/X/audio-16k.wav --model models/campplus.onnx \
#       [--truth assets/X/ground_truth.json --enroll-sec 60] [--max-minutes 20] \
#       [--accept 0.62 --suggest 0.45 --margin-pct 15] --out results/run.jsonl
#
# --enroll-sec N simulates roll-call enrollment: for each ground-truth speaker, their first N
# seconds of speech (only turns wholly inside the enrollment window budget) build a named profile
# before the replay starts, mimicking "state your appearances" (plan section 9.3). Without
# --enroll-sec the run is cold-start clustering (anonymous V1..Vn).

import argparse, io, json, os, time, urllib.parse, urllib.request, wave
import numpy as np
from vad import chunk_stream, DEFAULTS
from engine import SpeakerEngine
from score import dominant_speaker


def read_wav_16k_mono(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, \
            "expected 16 kHz mono s16 WAV (use ffmpeg -ac 1 -ar 16000 -sample_fmt s16)"
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def build_enrollment(samples, truth, per_speaker_sec):
    """First `per_speaker_sec` seconds of speech per ground-truth speaker, plus the timestamp
    where the last enrollment clip ends (evaluation must not score audio it peeked at)."""
    spans = {}
    last_end = 0.0
    for t in truth["turns"]:
        got = sum(e - s for s, e in spans.get(t["speaker"], []))
        if got >= per_speaker_sec:
            continue
        take = min(t["stop"] - t["start"], per_speaker_sec - got)
        if take >= 1.0:
            spans.setdefault(t["speaker"], []).append((t["start"], t["start"] + take))
            last_end = max(last_end, t["start"] + take)
    clips = {spk: [samples[int(s * 16000):int(e * 16000)] for s, e in sp]
             for spk, sp in spans.items()}
    return clips, last_end


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--truth")
    ap.add_argument("--enroll-sec", type=float, default=0)
    # Cross-hearing warm start (plan section 10.4): enroll from a DIFFERENT recording, then
    # replay this one cold. Persistent profiles are the feature's headline claim.
    ap.add_argument("--enroll-audio")
    ap.add_argument("--enroll-truth")
    ap.add_argument("--max-minutes", type=float, default=0)
    ap.add_argument("--accept", type=float, default=0.65)   # calibrated in Phase 0, see RESULTS.md
    ap.add_argument("--suggest", type=float, default=0.45)
    ap.add_argument("--margin-pct", type=float, default=15.0)
    ap.add_argument("--ema", type=float, default=0.10)
    ap.add_argument("--no-train", action="store_true")
    ap.add_argument("--threads", type=int, default=2)
    # Poisoning-resistance test (plan section 10.4): every Nth centroid update is deliberately
    # absorbed into the runner-up profile, simulating wrong confirmations. 10 = 10% poison.
    ap.add_argument("--poison-every", type=int, default=0)
    # End-to-end sidecar test: drive a running speaker-server over HTTP instead of the in-process
    # engine. Ground-truth speakers are sent as the toggle hint (a perfect toggle), so the scored
    # "name" is the server's hint-derived cluster mapping: this validates the whole Phase 1 HTTP
    # path, chunk encoding included. Enrollment flags do not apply (no enroll endpoint in shadow).
    ap.add_argument("--url")
    a = ap.parse_args()
    assert not (a.url and a.enroll_sec), "--url mode has no enrollment (Phase 1 shadow)"

    samples = read_wav_16k_mono(a.audio)

    eng = SpeakerEngine(a.model, num_threads=a.threads, accept=a.accept,
                        suggest=a.suggest, min_margin_pct=a.margin_pct, ema=a.ema,
                        poison_every=a.poison_every)

    # Enrollment clips are cut from the FULL recording (a speaker's first words may come late),
    # then the replay itself may be truncated. score.py excludes pre-enrolled_from chunks.
    enrolled_from = 0.0
    if a.enroll_sec:
        if a.enroll_audio:
            e_samples = read_wav_16k_mono(a.enroll_audio)
            e_truth = json.load(open(a.enroll_truth or a.truth))
            clips, _ = build_enrollment(e_samples, e_truth, a.enroll_sec)
            # enrollment came from other audio: every chunk of THIS replay is evaluable
        else:
            assert a.truth, "--enroll-sec needs --truth"
            truth = json.load(open(a.truth))
            clips, enrolled_from = build_enrollment(samples, truth, a.enroll_sec)
        done = [spk for spk, cl in sorted(clips.items()) if eng.enroll(spk, cl)]
        print("enrolled %d/%d speakers; evaluation starts after t=%.1fs"
              % (len(done), len(clips), enrolled_from))

    if a.max_minutes:
        samples = samples[:int(a.max_minutes * 60 * 16000)]

    truth_turns = json.load(open(a.truth))["turns"] if (a.url and a.truth) else None
    if a.url:
        urllib.request.urlopen(urllib.request.Request(a.url + "/reset", data=b""), timeout=10)

    def http_identify(chunk, voiced_ms, start, end):
        b = io.BytesIO()
        with wave.open(b, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes((np.clip(chunk, -1, 1) * 32767).astype(np.int16).tobytes())
        hint = dominant_speaker(truth_turns, start, end)[0] or "" if truth_turns else ""
        req = urllib.request.Request(
            "%s/identify?ts=%d&voiced=%d&hint=%s" % (a.url, start * 1000, voiced_ms,
                                                     urllib.parse.quote(hint)),
            data=b.getvalue(), headers={"Content-Type": "audio/wav"})
        r = json.load(urllib.request.urlopen(req, timeout=15))
        m = r.get("mapped") or {}
        return dict(decision=r.get("decision"), cluster=r.get("cluster"),
                    name=m.get("speaker"), sim=r.get("sim"), margin_pct=r.get("marginPct"))

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    lat = []
    n = 0
    with open(a.out, "w") as f:
        meta = dict(kind="meta", audio=a.audio,
                    model=("server:" + a.url) if a.url else os.path.basename(a.model),
                    accept=a.accept, suggest=a.suggest, margin_pct=a.margin_pct,
                    ema=a.ema, enroll_sec=a.enroll_sec, enrolled_from=enrolled_from,
                    enrolled=[p.name for p in eng.profiles if p.enrolled],
                    poison_every=a.poison_every, vad=DEFAULTS)
        f.write(json.dumps(meta) + "\n")
        for start, end, voiced_ms, chunk in chunk_stream(samples):
            t0 = time.time()
            if a.url:
                v = http_identify(chunk, voiced_ms, start, end)
            else:
                v = eng.identify(chunk, voiced_ms, train=not a.no_train)
            lat.append(time.time() - t0)
            v.update(kind="chunk", start=round(start, 2), end=round(end, 2),
                     voiced_ms=int(voiced_ms))
            f.write(json.dumps(v) + "\n")
            n += 1
        lat_ms = sorted(x * 1000 for x in lat)
        stats = dict(kind="stats", chunks=n,
                     p50_ms=round(lat_ms[len(lat_ms) // 2], 1) if lat_ms else None,
                     p95_ms=round(lat_ms[int(len(lat_ms) * 0.95)], 1) if lat_ms else None,
                     clusters=[dict(pid=p.pid, name=p.name, n=p.n) for p in eng.profiles])
        f.write(json.dumps(stats) + "\n")
    print("wrote %s: %d chunks, embed p50 %.0f ms, p95 %.0f ms, %d clusters/profiles"
          % (a.out, n, stats["p50_ms"] or -1, stats["p95_ms"] or -1, len(eng.profiles)))


if __name__ == "__main__":
    main()
