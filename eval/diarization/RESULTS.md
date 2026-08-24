# Phase 0 bake-off results (July 24, 2026)

Verdict: **GO on the local-only stack.** sherpa-onnx + 3D-Speaker CAM++ clears every Phase 0
pass criterion from [SPEAKER-AUTO-ID-PLAN.md](../../SPEAKER-AUTO-ID-PLAN.md) section 10.5 on
real courtroom audio, on the actual hearing machine (Intel Mac, CPU only), with headroom.
Calibrated config for Phase 1: **accept 0.65, suggest 0.45, margin 15%, EMA 0.10**.

## Test conditions

- Machine: Intel x86_64 Mac (the CPU-bound case from the plan), macOS 15.7, Python 3.10,
  sherpa-onnx 1.13.4, CPU only, 2 threads.
- Assets: two real SCOTUS oral arguments with Oyez speaker-aligned transcripts as ground truth.
  *Bowe v. United States* (24-5438, argued Oct 14, 2025, 91 min, 12 speakers) and
  *Berk v. Choy* (24-440, argued Oct 6, 2025, 64 min, 11 speakers). Same nine justices, four
  distinct advocates. 12 speakers is twice the plan's 2-6 speaker hearing condition, so this is
  the stress case for confusability, though the audio is cleaner than Zoom.
- All replays go through the exact VAD parameters of app/asr.js (via vad.py), so chunking
  matches what the live app would feed the sidecar.

## The runs

| Run | Condition | Coverage (auto-accepted) | Accuracy on accepted | Wrong-name rate | Labeled accuracy | Flicker/min |
|---|---|---|---|---|---|---|
| Enrolled, train on | 20 s/speaker enrollment, eval on remaining 17 min | 92.6% | 99.2% | 0.8% | 97.8% | 0.12 |
| Cold start, full 91 min | zero enrollment, online clustering only | 89.8% | 99.2% | 0.79% | 97.8% | 0.18 |
| Cross-hearing warm start | enroll on Bowe, replay Berk cold (64 min) | 89.8% | see below | see below | 97.0% | 0.0 |
| Poisoned (10% wrong updates) | enrolled + every 10th train absorbed wrong | 92.6% | 99.0% | 1.01% | 98.4% | 0.12 |
| WeSpeaker ResNet34 (alt model) | enrolled, train on | 0% (sim scale differs) | n/a | n/a | 84.4% top-1 | 1.47 |

Cross-hearing detail (the feature's headline claim, plan section 10.4):

- Justices enrolled at hearing 1, named at hearing 2: **96% of chunks** (194/202), each locking
  in within 27 seconds of that speaker's audio. Target was >= 85%.
- The two never-enrolled advocates: **1.9%** of their chunks (6/320) briefly got an enrolled
  name; the rest correctly stayed anonymous, and online clustering spawned **exactly two new
  clusters for exactly two new voices**. This is the intended behavior: known people recognized,
  new people become "Voice N" to tag once.

Cold-start detail: over 1.5 hours with no enrollment at all, the engine discovered 13 clusters
for 12 speakers with 99.2% accuracy on auto-accepted chunks. Tag-once-and-propagate would have
worked from minute one.

## Pass criteria vs plan section 10.5

| Criterion (plan) | Target | Measured | Pass |
|---|---|---|---|
| Chunk attribution after enrollment, acoustic only | >= 90% | 97.8% (12 speakers) | Yes |
| Wrong-name rate at accept threshold | <= 1% | 0.8% (0.33% at accept 0.70) | Yes |
| Added latency per chunk on the hearing Mac | <= 500 ms median | 59 ms p50, 80 ms p95 | Yes |
| Cross-hearing auto-naming, zero manual tags | >= 85% | 96% | Yes |
| Poisoning: 10% wrong confirmations | within ~2 pts of clean | +0.6 / -0.2 pts | Yes |
| Streaming DER <= 20% | <= 20% | ~2-3% attribution error time-weighted (proxy, see notes) | Yes (proxy) |

## Threshold calibration (CAM++, both main runs)

| accept | Coverage | Accuracy on accepted | Wrong-name |
|---|---|---|---|
| 0.55 | 94-96% | 98.9-99.2% | 0.78-1.07% |
| 0.62 (plan draft) | 92-93% | 99.2% | 0.79-0.80% |
| **0.65 (chosen)** | 91-92% | 99.2-99.4% | 0.64-0.81% |
| 0.70 | 86-88% | 99.7-100% | 0.00-0.33% |

0.65 keeps coverage above 90% with wrong-name comfortably under 1%. 0.70 is the paranoid
setting if early live use shows Zoom audio shifting the distributions; both stay in config.

## The engineering find that made it work

The sherpa-onnx CAM++ export returns **garbage embeddings for certain input durations**
(3, 5, 7, 8.5, and 15 s were broken while 2, 4, 6, 8, 10, 12, and 20 s were fine, independent
of content and fully deterministic). Since VAD chunks have arbitrary durations, roughly half of
all chunks embedded as noise, which produced 44% wrong-name rates and mongrel clusters in the
first uncalibrated runs. Fix in engine.py, verified: **standardize every embedding input to a
fixed 6.0 s window** (center-crop longer audio, tile shorter audio). After the fix, same-speaker
similarity is stable at every length (0.71-0.98) and cross-speaker separation is wide
(-0.06 to 0.26 between advocates and justices).

Consequences: the Phase 1 sidecar must keep the fixed-length standardization (it is load-bearing,
not an optimization), enrollment embeds long clips in 6 s windows and averages, and an upstream
issue should be filed against sherpa-onnx with the length table. Bonus: fixed-length inputs are
also faster (59 ms vs 90 ms p50).

Also confirmed on the way: whisper-verified that Oyez turn timestamps align to the delivery
audio within about a second, so Oyez ground truth needs no offset correction.

## Honest caveats

- SCOTUS bench audio is cleaner than a Zoom hearing through BlackHole. The 12-speaker condition
  is harder than a motion hearing, but the mock-Zoom rig recording (plan section 10.1) is still
  the required test before assist or auto mode goes live in a real hearing. Shadow mode (Phase 1)
  does not need to wait for it.
- Residual errors concentrate exactly where the plan predicted (section 7.4): sub-2-second
  interjections and cross-talk boundaries. These fall to suggest or unknown rather than wrong
  names, which is the designed behavior.
- "Streaming DER" in the pass table is approximated by time-weighted chunk attribution error on
  VAD-voiced audio, not NIST-collar DER on frames; word-level WDER needs the ASR words and lands
  with the Phase 3 fusion work.
- Cold-start numbers use the scorer's optimistic greedy cluster-to-speaker mapping, the standard
  convention for unnamed clustering.
- ResNet34's 0% coverage is a threshold-scale artifact (its similarity scale sits lower); its
  threshold-free top-1 accuracy of 84.4% vs CAM++'s 97.8% plus 2.4x the latency rules it out
  regardless of calibration.

## What Phase 1 inherits

- engine.py as-is (fixed-length embedding, two thresholds + margin, confidence-gated EMA,
  spawn/unknown policy) wrapped in speaker-server.py on port 8791.
- Config: accept 0.65, suggest 0.45, margin_pct 15, ema 0.10, min_train_ms 1500,
  min_spawn_ms 2000.
- The CAM++ model file and the fetch step for launch.command.
- Next eval work (parallel to Phase 1, before Phase 2 live use): the mock-Zoom rig recording
  through the real BlackHole chain, one Florida hearing asset, and a WDER pass once ASR words
  are in the loop.
