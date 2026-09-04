# Hearing Copilot

A local, two-pane courtroom assistant for a pro se litigant arguing a civil motion hearing. It
shows prepared openings/rebuttals/objections on the left and a document binder + live transcript
on the right. While the hearing runs it captures audio, transcribes it, tags who is speaking,
matches what the other side says against a prepared rebuttal catalog (keyword + LLM), queues
matched points to an "On deck" list, and can compose a single woven spoken rebuttal.

Built on [copilot-core](https://github.com/gitchrisqueen/copilot-core), a small shared package of
browser modules and Python sidecars used by this app and its sibling,
[tech-interview-copilot](https://github.com/gitchrisqueen/tech-interview-copilot).
Transcription, the LLM provider-failover transport, the transcript store, layout, settings
persistence, the secret-injecting web server, and the transcript/settings/ASR-proxy log server
all live there. This app's own domain logic -- the rebuttal/objection matcher, the whole-
transcript reconciliation pass, the composed-rebuttal writer, the courtroom-specific speaker-ID
sidecar, and the binder viewer -- lives here in `app/`.

## Not legal advice

This is an assist tool, not a substitute for legal judgment. It can misattribute a speaker,
mis-transcribe a word, or match the wrong prepared point. Read what it surfaces before relying on
it out loud. **Confirm that recording is permitted in your courtroom or venue before using this
tool live** -- rules on recording hearings vary by jurisdiction and by judge, and some prohibit it
entirely.

## Quickstart (macOS)

```bash
# 1) Core tools
brew install ollama blackhole-2ch

# 2) Secrets (optional; with a Together AI key the app uses hosted transcription first)
cp example.env .env      # then edit .env and fill in your keys

# 3) Launch with the fictional demo hearing profile
./launch.command example
```

`launch.command` bootstraps `npm install` and a Python venv with `copilot-core` installed
automatically on first run. See "Local models and audio setup" below for whisper.cpp and the
speaker-ID sidecar (both optional).

For a real hearing, **never commit your hearing profile to this repo** -- see
[hearings/README.md](hearings/README.md) for how to keep it private.

## What works right now

- Live transcription of both sides (a meeting/courtroom audio feed via BlackHole, and your own
  mic). With a Together AI key, hosted transcription is tried first and falls back to a local
  whisper.cpp server automatically. The browser's Web Speech API is a separate engine you select
  by hand (`asr.engine: "webspeech"` in `app/config.js`), not an automatic third tier.
- Keyword + LLM matching of what the other side says against your prepared rebuttal/objection
  catalog, queued to an On-deck list, reordered by defense strength.
- A whole-transcript reconciliation pass that periodically re-checks the On-deck list against the
  full opposing-side transcript so far, pruning items nothing actually argued and adding ones
  that were missed by the fast per-line matcher.
- A composed spoken rebuttal woven from the On-deck points, with **emphasis** on the phrases you
  should slow down and land, sized to fit your remaining speaking time.
- Voice-ID (shadow/assist/auto modes, `speakerId.mode` in `app/config.js`): fingerprints each utterance so a panel of unnamed speakers
  becomes separate tagged voices, mapped to parties from your own "who's speaking" toggle history.
- A document binder pane (PDF viewer) for both sides' exhibits, and a Who Am I tab to set which
  party you represent.

## The plugin API

`window.HearingCopilot` exposes `trigger(id)`, `markHandled(id)`, `openTab(tabRef)` (a binder tab
reference such as `"Tab 3"` or `"P-2"`), `setLive(on)`, `logSegment(speaker, text)`, `sortOnDeck()`,
`items()`, `getState()` -- useful from the browser console for testing, or for driving the app from
another tool.

## Architecture and ports

```
mic + BlackHole -> asr.js (core, VAD chunking, WAV) -> Together /asr proxy | whisper.cpp
     -> transcript (TLOG, core) -> app.js keyword matcher + llm.js match()
     -> On-deck list -> llm.js reconcile() (whole-transcript QA pass, periodic)
     -> llm.js composeRebuttal() -> Rebuttal Script pane
     (each utterance is also fingerprinted by speaker-server.py -> named voices in the
      transcript; the Timing tab sizes the composed response to your remaining share)
```

| Service | Port | Required | Source |
|---|---|---|---|
| `app/web-server.py` -- static app + .env injection + active hearing's `data.js` | 8777 | yes | thin wrapper over `copilot_core.webserver` |
| `app/log-server.py` -- transcript log, /settings, /asr proxy | 8790 | yes | thin wrapper over `copilot_core.logserver` |
| `app/speaker-server.py` -- voice profiles (multiple speakers, party mapping) | 8791 | optional | fully app-local (see below) |
| `ollama serve` -- bridge to Ollama Cloud / local LLM fallback | 11500 | for LLM | external |
| whisper.cpp server -- local ASR fallback | 8089 | optional | external |

All ports are distinct from the sibling tech-interview-copilot project, so both can run at once.
Frontend: vanilla JS, no bundler, no build step, no CDN -- `js/*.js` from
`@gitchrisqueen/copilot-core` plus this app's own `app/*.js`, loaded via plain `<script>` tags
(see `index.html` for the required order). Backend: Python 3 stdlib sidecars (the only pip
dependency for the web/log servers is `copilot-core` itself; the speaker-ID sidecar separately
needs `numpy` + `sherpa-onnx`, in its own venv -- see `eval/diarization/requirements.txt`, which
also pins `copilot-core` because the offline eval harness in that directory imports the shared
engine from it).

**Why the speaker-ID sidecar isn't part of copilot-core**: the voice-embedding and clustering
engine itself is shared and does live in copilot-core (`copilot_core.speaker.engine`, which
`eval/diarization/engine.py` imports). This app still ships its own diverged fork of that engine
as `app/speaker_engine.py` (same embedding and clustering math, but a different API: a per-profile
party field, `enroll()`, and `confirm()` keyed by party rather than profile id; it imports only
`numpy` and `sherpa-onnx`, not copilot-core), and `app/speaker-server.py` adds the part that is
specific to this app: mapping anonymous voice clusters to courtroom parties from your toggle
history. Reconciling the app's fork with the shared module is not done yet.

## Local models and audio setup

### The LLM (matching + On-deck ordering)

Default provider chain: local Ollama (bridging Ollama Cloud) -> OpenAI -> Groq, all
OpenAI-compatible/JSON-mode (`llm.fallback` in `app/config.js`). The reconciliation pass has its
own shorter list, Ollama -> OpenAI (`reconcile.providers`). Everything fails soft to keyword-only
matching if no LLM answers.
Put your keys in `.env` (see `example.env`); `web-server.py` injects them into `config.js` at
serve time and they never enter the repo or the browser's localStorage.

### Audio -- BlackHole (free virtual audio device)

The app hears the other side through BlackHole. A Multi-Output Device duplicates the meeting/
courtroom audio to BOTH your headphones/speakers and BlackHole, so you still hear everything
normally.

1. `brew install blackhole-2ch`, then restart the browser.
2. Open **Audio MIDI Setup** (Applications > Utilities). **+** > **Create Multi-Output Device**;
   check your headphones/speakers AND **BlackHole 2ch**. Set your headphones as primary and
   enable Drift Correction on BlackHole.
3. Set the meeting/system output to the Multi-Output Device.
4. In `app/config.js`, set `asr.inputDeviceLabel` to match BlackHole's device name. (The
   log server exposes a `/settings` store for a per-machine `app/settings.json`, but this app
   does not set `CONFIG.settingsUrl` and never calls it, so edits belong in `config.js` for now.)

### Transcription -- local whisper.cpp (optional fallback)

`launch.command` starts a local `whisper-server` if it finds a binary and a model
(`WHISPER_SERVER_BIN` / `WHISPER_MODEL` env vars, or the defaults it checks). Without a Together
key, local whisper.cpp is the only transcriber the default config uses; if neither is available,
switch `asr.engine` to `"webspeech"` in `app/config.js` to use the browser's Web Speech API.

### Speaker auto-detection (voice profiles)

Optional. `launch.command` sets up its own Python venv under `eval/diarization/venv` (separate
from the venv used for the web/log servers) from `eval/diarization/requirements.txt`, and
downloads a ~28 MiB CAM++ embedding model on first run. Without it, every remote line is labeled by your manual
"who's speaking" toggle only -- nothing else breaks.

### Tuning transcription and matching

See the heavily-commented `app/config.js` for VAD thresholds (`asr.vad`), match strength
(`match.minMatchScore`), and the reconciliation pass's ceilings (`reconcile.maxPoints`/
`maxObjections`). A hearing profile's `hearingConfig` can override the match strength per hearing
(`minMatchScore`); the VAD thresholds and reconciliation ceilings are `config.js`-only -- see
[hearings/README.md](hearings/README.md).

### Logs

`logs/` (git-ignored) holds the durable transcript JSONL plus each service's stdout/stderr, for
debugging a session after the fact.

## Important caveats

- This tool assists; it does not argue for you and does not know the law better than you do.
  Verify every matched rebuttal and every composed sentence before you say it.
- Voice-ID is a hint, not ground truth -- it can misattribute a line, especially early in a
  session before a voice has enough audio to build a stable profile.
- Recording rules vary. Confirm with the court/venue before using live capture.
- This build targets macOS (BlackHole for loopback audio). Windows support (via VB-Cable) is a
  possible future addition, not implemented.
- The per-machine settings store (`app/settings.json` via the log server's `/settings`) is served
  but not wired into this app's browser code yet; configuration is `app/config.js` only.
- `app/speaker_engine.py` is a diverged fork of the engine that now lives in copilot-core
  (different `Profile`, `label`, and `confirm` signatures, plus `enroll()`); the app has not been
  reconciled with the shared module.

## Development, testing, and contributing

```bash
npm install && npm test          # node:test, against app/llm.js (fictional-profile fixtures only)
```

Test coverage is intentionally honest, not padded: `app/llm.js`'s pure logic (grounding checks,
emphasis rules, the classifySpeaker parameterization that keeps real party names out of this
public repo) is covered; `app.js` (all rendering/wiring) has no dedicated tests yet.
`codecov.yml`'s project target (12%) sits at or below the measured baseline and only ratchets up -- see
[CONTRIBUTING.md](CONTRIBUTING.md) for the branch protection and CI setup, including how a solo
maintainer satisfies a required-review gate.

## License

MIT. See [LICENSE](LICENSE).
