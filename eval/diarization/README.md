# Diarization bake-off harness (Phase 0)

Offline evaluation for the speaker auto-detection feature. See
[SPEAKER-AUTO-ID-PLAN.md](../../SPEAKER-AUTO-ID-PLAN.md) section 10 for the protocol and
[RESULTS.md](RESULTS.md) for the findings. Nothing here touches the app; it proves the
engine on recorded courtroom audio first.

## Setup (one time)

```
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
mkdir -p models
curl -L -o models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx
```

(The release tag really is spelled `speaker-recongition-models`.) `ffmpeg` is needed for audio
conversion. Models, audio, and results stay git-ignored.

## The pieces

- `vad.py` mirrors the app's utterance chunker (app/asr.js) so evaluation happens on the same
  1.2-9 s chunks the live app produces.
- `engine.py` is the identification core the Phase 1 sidecar will wrap: fixed-length CAM++
  embeddings, named profiles, two-threshold decisions, confidence-gated EMA learning.
- `oyez_fetch.py` downloads SCOTUS argument audio plus Oyez's speaker-aligned transcript
  (free ground truth): `--list --term 2025`, then `--term 2025 --docket 24-5438`.
- `replay.py` runs a recording through VAD + engine and writes per-chunk verdicts (JSONL).
  Enrollment simulation with `--enroll-sec 20`; cross-hearing warm start with
  `--enroll-audio/--enroll-truth`; poisoning test with `--poison-every 10`.
- `score.py` joins verdicts against ground truth: attribution accuracy, wrong-name rate,
  decision mix, flicker, time-to-stable, per-speaker confusion.
- `test_server_phase2.py` is the sidecar regression test: labeling, confirm-training, per-case
  persistence across a restart, delete, and reset semantics, on real courtroom chunks.

## Typical run

```
./venv/bin/python oyez_fetch.py --term 2025 --docket 24-5438
./venv/bin/python replay.py \
  --audio assets/2025-24-5438/audio-16k.wav \
  --model models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx \
  --truth assets/2025-24-5438/ground_truth.json \
  --enroll-sec 20 --accept 0.65 --out results/run.jsonl
./venv/bin/python score.py --run results/run.jsonl \
  --truth assets/2025-24-5438/ground_truth.json
```
