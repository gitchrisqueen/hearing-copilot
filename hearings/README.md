# Hearing profiles

A hearing profile is everything the copilot needs to know about one hearing: the parties, the
prepared rebuttal/objection catalog, binder document paths, and the LLM prompt parameters
(`hearingConfig`) that keep the prompts generic in this public repo while still letting a real
hearing supply its exact original wording.

## The shipped demo profile

`hearings/example/` is a fictional case ("Meridian Capital v. Placeholder Logistics") with a
small catalog of rebuttals and objections. `launch.command` uses it by default
(`./launch.command example`). It exists so the app works out of the box and demonstrates the
full `data.js` schema -- copy it as the starting point for a real profile.

## Adding a real hearing profile

**Never commit a real profile to this repo.** Case facts, party names, and prepared argument
text are exactly the kind of content that should stay on your machine or in a private repo you
control -- not in this public one.

1. Create `hearings/<your-hearing-id>/data.js` (and any binder PDFs / script markdown it
   references) following the shape in `hearings/example/data.js`.
2. Launch with it: `./launch.command <your-hearing-id>`.
3. `hearings/` beyond the `example/` entry is git-ignored (see `.gitignore`), so anything you add
   there never enters git history, no matter how you build or edit it.

### `hearingConfig` fields worth knowing about

Most of `hearingConfig` is app behavior (clock, match thresholds, page title). Four fields carry
the LLM prompt text that varies by hearing type and jurisdiction -- set these to your hearing's
exact wording if you want prompt behavior identical to a prior, more specific version:

- `hearingTypePhrase` / `reconcileHearingPhrase` -- e.g. `"a Florida civil summary-judgment hearing"`
- `plaintiffRoleDescription` / `defendantRoleDescription` -- the real party names and the specific
  legal theory in play (see `app/llm.js`'s `classifySpeaker` for where these land)

## Re-integrating into a private case-documents repo

If you keep hearing profiles inside a larger private legal-documents repository (so binder paths
can point at case files under a sibling `cases/` tree), see this repo's `launch.command` for the
`COPILOT_SERVE_ROOT` / `COPILOT_HEARINGS_DIR` / `COPILOT_ENV_FILE` environment variables -- they
let a wrapper script in that private repo pin this app to a specific released version, serve the
private repo's root (so absolute docPaths like `/cases/...` resolve), and point at hearing
profiles and secrets that live outside this checkout entirely.

## Schema

See `hearings/example/data.js` for the full shape: `title`, `hearingConfig`, `parties`
(plaintiff/defendant: label, name, counsel, role), `priority` (per-item strength), `linchpins`,
`traps`, `powerPhrases`, `docPaths`, `defendantsBinderBase`/`defendantsTabs`,
`plaintiffBinderBase`/`plaintiffTabs`, `rebuttals[]` (id, heard, keywords, tabs, script),
`objections[]` (same shape, trigger instead of heard), `preservationTail`.
