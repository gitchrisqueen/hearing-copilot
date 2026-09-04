# CLAUDE.md

Guidance for Claude Code (and the Claude Agent SDK) when working in this project.

## What this is

Hearing Copilot: a real-time assistant for a pro se litigant arguing a civil motion hearing. It
captures both sides' audio, transcribes live, matches what opposing counsel says against a
prepared rebuttal/objection catalog, tracks an On-deck list, periodically reconciles that list
against the whole transcript so far, and can compose a woven spoken rebuttal. It is an assist
tool, not legal advice; the header disclaimer must stay.

This repo depends on **[copilot-core](https://github.com/gitchrisqueen/copilot-core)** (npm +
pip), a small package shared with the sibling
[tech-interview-copilot](https://github.com/gitchrisqueen/tech-interview-copilot) repo.
Transcription, the LLM provider-failover transport, the transcript store, layout, settings
persistence, the secret-injecting web server, and the transcript/settings/ASR-proxy log server
all live there. Everything in `app/` here is this app's own domain logic. See `index.html` for
the exact script load order (core scripts, then app scripts).

**This repo is public.** Never commit a real hearing profile -- `hearings/` is git-ignored except
`hearings/example/` (the fictional demo). See `hearings/README.md` and the `scrub` CI job.

## Architecture map

| File | Role |
|---|---|
| `index.html` | app shell: left tabs (Openings/Rebuttals/Objections/On deck/Rebuttal Script/Full script), binder + live-transcript pane, copilot tabs (Live/Who Am I/Timing); script load order matters -- `app/data.js` first (sets `window.CASE`), then `app/config.js` (reads `window.CASE.hearingConfig` for its fallbacks and sets `window.CopilotCore`), then copilot-core's `md.js`/`shell.js`/`settings.js`/`transcript.js`/`asr.js`/`llm-transport.js`, then this app's `llm.js`/`app.js`, then core's `layout.js` last |
| `app/data.js` | static fallback stub only; the REAL `window.CASE` is served dynamically by `web-server.py` from `hearings/<HEARING>/data.js` (see below) |
| `app/config.js` | committed defaults + `%KEY%` secret placeholders + `window.CopilotCore` (namespace `hc`, `transcript.roleField: "speaker"` -- see "Do not break" below, and the `asr.identifyParams` hook that carries the "who's speaking" toggle hint to the voice sidecar) |
| `app/domain.css` | this app's styles; the shared shell (grid, panels, dividers, cards, chips, transcript list, voice pills) is copilot-core's `css/base.css`, loaded first |
| **from copilot-core** (`node_modules/@gitchrisqueen/copilot-core/js/`) | `md.js`, `shell.js` (`el`/`esc`/`makeLogger`/`makeNotifier`, used by `app.js`), `settings.js`, `transcript.js` (`TLOG` -- configured with `roleField: "speaker"` so this app's ~50 `seg.speaker` reads keep working unchanged), `asr.js` (`ASR`), `llm-transport.js` (`LLM` provider chain + `registerTask`/`runTask`, unused by this app -- see `app/llm.js`) |
| `app/llm.js` | **adds onto** `window.LLM` (never replaces it). Five tasks: `match`, `sortOnDeck`, `reconcile`, `classifySpeaker`, `composeRebuttal`, plus the compose-QA post-processing (`ensureObjections`/`applyEmphasis`/`capEmphasisRepeats`). The ONLY genuinely case-specific text among the five prompts -- real party names and the specific legal theory -- comes from the active hearing profile via `window.CASE.hearingConfig` (`hearingTypePhrase`, `reconcileHearingPhrase`, `plaintiffRoleDescription`, `defendantRoleDescription`), with fully generic defaults when unset. See `test/llm.test.js` for the contract this parameterization must keep. |
| `app/app.js` | all rendering + wiring; uses `CopilotShell` (`el`/`esc`/`dbg`/notifier) from core rather than redefining them; binder/PDF viewer (`resolvePdf`, `showTab` -- HEAD-checks a PDF before embedding it, so a profile with a placeholder path shows a plain "document not available" message instead of the browser's raw 404 inside the iframe); On-deck tracker; Rebuttal Script composer UI; Timing tab; Who Am I tab; Voices strip + naming/reassignment; `window.HearingCopilot` plugin API |
| `app/speaker-server.py` + `app/speaker_engine.py` | voice-ID sidecar, **fully app-local** (does NOT import from copilot-core, unlike the web/log servers). Its `Profile.speaker` field, `enroll()`, and the toggle-history-to-party mapping in `speaker-server.py`'s `State.hints`/`State.mapped()` are specific to courtroom party-mapping and meaningfully diverge from copilot-core's simpler name-only engine (used by tech-interview-copilot) -- do not try to unify them without a real reason; see the breakout plan's adversarial-review notes if this needs revisiting later. |
| `app/web-server.py`, `app/log-server.py` | thin wrappers around `copilot_core.webserver.serve()` / `copilot_core.logserver.serve()`. `web-server.py` additionally serves the active hearing's `data.js` as a virtual route (`HEARING` env var selects the profile; `COPILOT_HEARINGS_DIR`/`COPILOT_SERVE_ROOT`/`COPILOT_ENV_FILE` env vars support the private-monorepo re-integration case -- see `hearings/README.md`) |
| `hearings/<id>/data.js` | one hearing's case payload: parties, prepared rebuttal/objection catalog, binder tab lists, `hearingConfig`. `hearings/example/` is the only one committed to this repo. |
| `eval/diarization/` | offline diarization bake-off harness (not unit tests): `replay.py`/`score.py` against Oyez SCOTUS oral-argument audio (public domain), `test_server_phase2.py` (a real HTTP regression test against the live sidecar), `RESULTS.md` (97.8% labeled accuracy on the original 12-speaker courtroom recording this was tuned against). `engine.py` is a shim re-exporting `copilot_core.speaker.engine` for `replay.py`'s imports -- NOT the same as `app/speaker_engine.py` (the shared math engine vs. this app's party-mapping engine are different modules; see above). |

Ports: web **8777**, log/settings **8790**, voice profiles **8791**, ollama bridge **11500**,
whisper **8089**. Deliberately distinct from the sibling tech-interview-copilot's ports; do not
change them casually.

## Conventions (follow these)

- **Frontend**: vanilla JS in IIFEs attaching to window globals (`CONFIG`, `CopilotCore`, `CASE`,
  `SETTINGS`, `CopilotShell`, `ASR`, `LLM`, `TLOG`, `MD`, `HearingCopilot`). No frameworks, no
  bundler, no build step, no CDN or external requests from the page (copilot-core is loaded from
  `node_modules/` via plain `<script>` tags, same as any other file here).
- **Backend**: Python 3 stdlib only, plus `copilot_core` (also stdlib-only at its core, used by
  `web-server.py`/`log-server.py` only) and the `eval/diarization` venv's `numpy`/`sherpa-onnx`
  (used by `speaker-server.py` only, a SEPARATE venv from the core one).
- **When a change belongs in copilot-core, not here**: if you're touching something that would
  also help tech-interview-copilot (the ASR pipeline, the LLM transport, layout, settings
  persistence), it probably belongs in copilot-core instead. The speaker-embedding MATH could in
  principle move there too (v0.2+); the party-mapping POLICY around it should not.
- **Secrets** live only in the git-ignored `.env`, injected into `config.js` placeholders at
  serve time. Never write a key into `config.js`, `settings.json`, localStorage, or the repo.
- **Case content stays out of this repo.** The five LLM prompts in `app/llm.js` must never regain
  a hardcoded real party name, case number, or jurisdiction detail -- that content belongs only in
  a private `hearings/<id>/data.js`'s `hearingConfig`, which is git-ignored.
- **Every network dependency degrades gracefully**: LLM down -> keyword-only matching; RAG/voice
  sidecar down -> toggle-only tagging; Together down -> local whisper -> Web Speech. Preserve this.

## Do not break

- **`transcript.js`'s `roleField: "speaker"` config in `app/config.js`.** This app's transcript
  segments have always used `speaker` as the field name (not copilot-core's default `role`), and
  `app.js` has roughly 50 call sites reading `seg.speaker`/`s.speaker`/`cur.speaker`. Removing
  this config option (or changing the field name) breaks every one of them silently -- speaker
  labels would just read `undefined`.
- **`TLOG.add(role, text, extra)`'s 3rd-argument contract.** copilot-core's version treats a
  truthy 3rd argument as an object to merge onto the segment (`Object.keys(extra).forEach(...)`).
  This app's original `transcript.js` took a plain display-name STRING there instead. The one call
  site that used to pass a bare name (`mergeOrAdd` in `app.js`) now wraps it: `name ? { name:
  name } : undefined`. Any new caller passing a 3rd argument must do the same, or a string will be
  destructively iterated by character index instead of setting `.name`.
- **The classifySpeaker/reconcile/composeRebuttal parameterization.** These three prompts read
  `window.CASE.hearingConfig` for the only genuinely case-specific text among the five LLM tasks.
  Do not hardcode a real party name, case number, or jurisdiction phrase back into `app/llm.js` --
  it would leak into this public repo's git history. Generic defaults must always remain
  functional on their own (see `test/llm.test.js`).
- **The `/asr` proxy serialization + circuit breaker** and the **provider `sequence()` fallback**
  (both copilot-core).
- **The grounding filter** in `match()`/`reconcile()` (`quoteSupported`, >= 3 consecutive words
  copied verbatim) -- it is the guard against topic-drift matches queuing a rebuttal nobody
  actually argued.
- **The reconcile REMOVE/ADD delta contract**: `reconcile()` never returns a rewritten on-deck
  list, only what to remove and add; anything not named is kept, so a lazy/truncated model
  response can never silently wipe the deck.
- **The compose QA passes** (`ensureObjections`, `applyEmphasis`, `capEmphasisRepeats`): every
  on-deck objection's substance must survive into the composed rebuttal (verbatim-spliced as a
  last resort), and emphasis markers land on load-bearing phrases without inflating past the cap.
- **The fixed-length embedding standardization** in `app/speaker_engine.py` (`EMBED_SAMPLES`):
  the CAM++ export returns garbage for certain input durations, so every chunk is center-cropped
  or tiled to exactly 6 s. Removing it silently destroys voice identification.
- **Voice naming/reassignment is retroactive**: renaming or reassigning a voice patches every past
  transcript line of that cluster, both in the browser copy and the durable disk log.
- **`resolvePdf()`'s HEAD-check before embedding an iframe** (`showTab()` in `app.js`). Without
  it, a hearing profile whose binder path doesn't resolve to a real file (like the shipped
  `hearings/example/` demo, deliberately) renders the browser's raw 404 page inside the pane
  instead of a clean "document not available" message.
- **The script load order** in `index.html` -- see the Architecture map row above.
- **`app/llm.js` must ADD to `window.LLM`, never replace it**, and its `LLM.last()` override must
  keep merging core's transport-tracked `lastUsed` with `composeRebuttal`'s own (it calls
  `composeOne()` directly, bypassing core's `chatJSON`, so it tracks its own).

## How to run / test

- `./launch.command [profile]` bootstraps `npm install` + a Python venv with `copilot-core`
  installed (for the web/log servers) if needed, then starts everything with the named hearing
  profile (default `example`); `./stop.command` kills the five ports.
- `npm test` (or `node --test test/*.test.js`) -- `test/llm.test.js` covers `classifySpeaker`'s
  generic-vs-override parameterization (the privacy-critical mechanism), the grounding filter, the
  emphasis QA passes, and `reconcile()`'s short-circuit/ceiling behavior, all via a stubbed
  `window.LLM` transport (no real network calls). No dedicated tests for `app.js` yet.
- Drive the pipeline without audio hardware from the browser console:
  `HearingCopilot.logSegment("plaintiff", "We respectfully request summary judgment.")`.
- Server smoke tests: `curl localhost:8790/settings`, `curl localhost:8791/health`.
- `eval/diarization/`: `replay.py`/`score.py` against Oyez audio for the voice-ID engine;
  `test_server_phase2.py` is a real HTTP regression test against the live `speaker-server.py`
  sidecar (label/confirm/persist-across-restart/delete/reset).
- Manual smoke checklist: tabs render and dividers drag; binder tabs list and a wired PDF loads
  (or shows "document not available" cleanly for `hearings/example`'s placeholder paths); the Live
  Copilot toggle starts capture; a keyword match queues an On-deck item; Generate composes a
  rebuttal with emphasis; the Timing tab tracks elapsed/remaining time; Who Am I changes which
  side the composer argues for; two voices produce two pills, naming one relabels its past lines.

## Writing style

Plain English, no em dashes (use periods or commas). Comments state constraints the code cannot
show, in the voice of the surrounding files.

## Cross-project context
Global rules for every session live in `~/.claude/CLAUDE.md` (sourced from the CQC Boss Vault, `00-Home/CLAUDE.global.md`). The vault is at `$CQC_VAULT` (fallback: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/CQC Boss Vault`); read it as plain files.
- This project's vault note: `60-Projects/Hearing-Copilot.md` (create it per `00-Home/Vault-Conventions.md` if missing).
- Handoff packets: `80-Handoffs/HO-<date>-<n>-<slug>.md` per `80-Handoffs/Handoff-Protocol.md`.
- Tracker: none recorded.
- Other projects: look them up in `00-Home/Source-Map.md`; write anything another project needs to the vault, not to auto-memory.
- Decisions for Christopher: options with a recommendation, in chat (see `00-Home/Working-With-Christopher.md`).
