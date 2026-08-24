# Python port of the app's voice-activity chunker (app/asr.js). The whole point of this harness
# is to evaluate speaker-ID on the SAME 1.2-9 s utterance chunks the live app produces, not on
# whole files, so the cutting logic and defaults here must mirror asr.js exactly:
#   - a frame is "voiced" when its RMS exceeds `threshold`
#   - a chunk flushes when it is voiced, at least `min_ms` long, and `silence_ms` of quiet passed
#   - or unconditionally at `max_ms` (long monologue cap; config.js lowered this to 9000)
#   - a flushed chunk is DROPPED unless it has >= `min_voiced_ms` of voiced audio and an overall
#     RMS >= `min_rms` (the whisper-hallucination guards)
# asr.js processes 4096-sample frames at the AudioContext rate (typically 48 kHz -> ~85.3 ms).
# We process 16 kHz mono input with the same ~85.3 ms frame so the timing granularity matches.

import numpy as np

DEFAULTS = dict(threshold=0.015, silence_ms=650, min_ms=1200, max_ms=9000,
                min_voiced_ms=450, min_rms=0.006)
FRAME_MS = 4096 / 48000 * 1000.0   # ~85.33 ms, same cadence as the browser's ScriptProcessor


def rms(x):
    return float(np.sqrt(np.mean(x * x))) if len(x) else 0.0


def chunk_stream(samples, sample_rate=16000, **kw):
    """Yield (start_s, end_s, voiced_ms, chunk_samples) exactly as asr.js would flush them.

    `samples` is a float32 mono array in [-1, 1] at `sample_rate`.
    """
    cfg = dict(DEFAULTS, **{k: v for k, v in kw.items() if v is not None})
    frame_len = max(1, int(round(sample_rate * FRAME_MS / 1000.0)))
    frames = range(0, len(samples), frame_len)

    buf = []            # frames of the current utterance (includes leading/trailing quiet)
    acc_ms = sil_ms = voiced_ms = 0.0
    voiced = False
    start_idx = 0       # sample index where the current utterance began

    def flush(end_idx):
        nonlocal buf, acc_ms, sil_ms, voiced_ms, voiced
        out = None
        if buf and voiced and voiced_ms >= cfg["min_voiced_ms"]:
            chunk = np.concatenate(buf)
            if rms(chunk) >= cfg["min_rms"]:
                out = (start_idx / sample_rate, end_idx / sample_rate, voiced_ms, chunk)
        buf = []
        acc_ms = sil_ms = voiced_ms = 0.0
        voiced = False
        return out

    for off in frames:
        frame = samples[off:off + frame_len]
        if not len(frame):
            break
        if not buf:
            start_idx = off
        buf.append(frame)
        frame_ms = len(frame) / sample_rate * 1000.0
        acc_ms += frame_ms
        if rms(frame) > cfg["threshold"]:
            voiced = True
            sil_ms = 0.0
            voiced_ms += frame_ms
        else:
            sil_ms += frame_ms
        end_idx = off + len(frame)
        if (voiced and acc_ms >= cfg["min_ms"] and sil_ms >= cfg["silence_ms"]) or acc_ms >= cfg["max_ms"]:
            out = flush(end_idx)
            if out:
                yield out

    out = flush(len(samples))
    if out:
        yield out
