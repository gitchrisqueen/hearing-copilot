// Hearing Copilot configuration. Edit to point at your local models/servers.
//
// SECRETS: this file contains NO real API keys. The apiKey fields below are %PLACEHOLDERS% that
// web-server.py substitutes at serve time from the git-ignored hearing-copilot/.env file (copy
// example.env -> .env and fill in your keys). The keys stay on your machine and never enter the repo.
// If you open config.js without the server, the placeholders stay literal and those providers simply
// won't authenticate (the app falls back to whatever else is configured).

// Namespacing + hooks consumed by copilot-core's shared modules. Must be set BEFORE those scripts
// load -- see index.html's script order. window.CASE (the active hearing profile) loads before
// this file, so its overrides are already in hand.
window.CopilotCore = {
  ns: "hc",
  transcript: {
    // This app's transcript segments have always used `speaker` (not `role`) as the field name,
    // and app.js has ~50 call sites reading it. roleField lets the shared transcript.js module
    // adopt that existing schema instead of forcing a rename sweep across this much legal-hearing
    // code -- see copilot-core's README for the option.
    roleField: "speaker",
    persistKeys: ["text", "speaker", "name"]
  },
  asr: {
    // The "who's speaking" toggle rides along as a hint the sidecar uses to map anonymous voice
    // clusters to parties. Only passed while FRESH (recently clicked), so a stale toggle never
    // teaches a cluster its own guess -- mirrors the original identifyVoice() logic.
    identifyParams: function (role, ts, voicedMs) {
      try {
        var st = window.HearingCopilot && window.HearingCopilot.getState();
        var sc = (window.CONFIG && window.CONFIG.speakerId) || {};
        var hint = (st && st.speaker) || "";
        if (sc.mode === "auto" && st && Date.now() - (st.speakerSetAt || 0) > 90000) hint = "";
        return hint ? { hint: hint } : null;
      } catch (e) { return null; }
    }
  }
};

window.CONFIG = {
  // LLM for smart matching + On-deck ordering. provider = "groq" | "openai" | "ollama".
  // Default is a cloud model (fast, offloads the Mac). Ollama is the local fallback that
  // launch.command also starts on a unique port. Falls back to keyword matching if unreachable.
  llm: {
    enabled: true,
    provider: "ollama",
    // Providers are tried in this order; the first that answers (non-empty) wins. The local "ollama"
    // server (localhost:11500) is the CORS-friendly bridge that PROXIES the cloud model to the browser,
    // and it verifiably reaches Ollama Cloud (a 480B model answering in ~1.5s cannot be local). Then
    // OpenAI, then Groq. The app now logs which provider/model actually answered each generation.
    // NOTE: "ollamacloud" (direct https://ollama.com) is intentionally NOT in this chain: a browser cannot
    // call ollama.com directly (it returns no CORS headers -> "Failed to fetch"). To drop the local Ollama
    // server entirely, a tiny server-side proxy is needed (see README / ask to have it added).
    fallback: ["ollama", "openai", "groq"],
    timeoutMs: 20000,   // cloud models answer in ~2-9s; give headroom
    // Cloud (OpenAI-compatible). Put your key here; it stays on your machine (served from localhost).
    // ollamacloud kept for reference only; unreachable from the browser (CORS). Requires a server-side proxy.
    ollamacloud: { baseUrl: "https://ollama.com/v1", model: "qwen3-coder:480b", apiKey: "%OLLAMA_API_KEY%" },
    groq:   { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-20b", apiKey: "%GROQ_API_KEY%" },
    openai: { baseUrl: "https://api.openai.com/v1",       model: "gpt-4o-mini",        apiKey: "%OPENAI_API_KEY%" },
    // Ollama server (localhost). Model set to a CLOUD model (:cloud suffix) via your Ollama subscription.
    ollama: { url: "http://localhost:11500", model: "qwen3-coder:480b-cloud"  }
  },

  // Speech-to-text. "whisper" posts 16 kHz audio to a local whisper.cpp server (launch.command starts it).
  // "webspeech" uses the browser's built-in recognition on the default input device.
  asr: {
    engine: "whisper",
    lang: "en-US",
    whisperUrl: "http://localhost:8089/inference",  // local whisper.cpp server (see README) — used as FALLBACK
    // Hosted transcription (Together AI, whisper-large-v3). Paste your key below and it activates
    // automatically, using the local /asr proxy (log-server) so the browser never calls Together directly
    // (CORS) and the key stays on your machine. If Together errors, the app falls back to local whisper.
    // Set transcriber:"whisper" to force local even with a key present.
    transcriber: "auto",
    together: { url: "http://localhost:8790/asr", model: "nvidia/parakeet-tdt-0.6b-v3", apiKey: "%TOGETHER_API_KEY%" },
    inputDeviceLabel: "BlackHole",   // the OTHER side's audio (meeting audio via a loopback device)
    inputLabelName: "Meeting input",
    selfLabelName: "Your mic",
    captureSelf: true,               // also transcribe your own mic as "Me"
    selfDeviceLabel: "",              // your microphone (substring match against the device list)
    // Domain priming for whisper (sent as the decoder's initial prompt). Dramatically cuts proper-noun
    // and legal-term errors. Keep it short (whisper only uses ~224 tokens of context).
    // Per-hearing override: the active profile (data.js) sets window.CASE.hearingConfig.asrPrompt with
    // the real party names, case numbers, and statutes for THAT hearing. The fallback below is
    // deliberately generic -- it never names a real party, case, or court.
    prompt: (window.CASE && window.CASE.hearingConfig && window.CASE.hearingConfig.asrPrompt) ||
      "objection; sustained; overruled; Your Honor; summary judgment; motion to compel; discovery; " +
      "deposition; exhibit; the record; counsel; guaranty; guarantor; deficiency; commercially reasonable.",
    // Voice-activity chunking: cut on pauses, not on a clock, so sentences aren't split.
    vad: { threshold: 0.015, silenceMs: 650, minMs: 1200, maxMs: 9000, minVoicedMs: 450, minRms: 0.006 },
    chunkMs: 5000                    // fallback only if VAD produces nothing
  },

  // Matching behavior. Roll several recent lines together so a phrase split across chunks still matches.
  match: {
    autoMatchMinChars: 16,   // ignore very short fragments
    windowMs: 15000,         // match against the last N ms of a speaker's speech, not just one chunk
    cooldownMs: 15000,       // don't re-fire the same rebuttal within this window (stops overlap spam)
    mergeGapMs: 8000,        // merge consecutive same-speaker lines closer together than this
    // Keyword match strength required before an item is queued. A hearing profile can override it
    // with window.CASE.hearingConfig.minMatchScore.
    minMatchScore: 2,
    // Optional LLM second pass: re-check each line's speaker from its wording. Needs the LLM online.
    llmSpeakerCheck: true,
    llmSpeakerMinChars: 24,
    llmSpeakerMinConf: 0.6
  },

  // Whole-transcript reconciliation pass. Per-line keyword matching is myopic; this pass hands the LLM
  // the ENTIRE opposing-side transcript plus the current On-deck list and the full catalog, and it
  // corrects the list with full context. Runs every everyMs, but ONLY when something changed.
  reconcile: {
    enabled: true,
    everyMs: 12000,
    maxPoints: 5,
    maxObjections: 3,
    redropCooldownMs: 90000,
    protectScore: 4,
    providers: ["ollama", "openai"],
    ollama: { model: "gpt-oss:120b-cloud", num_ctx: 16384 },
    openai: { model: "gpt-4o" }
  },

  ui: {
    autoMatchMinChars: 16,
    autoSortOnDeck: true,
    notifierMax: 12
  },

  // Hearing clock (editable on the Timing tab). Per-hearing override from the active profile
  // (window.CASE.hearingConfig.clock); generic fallback below.
  hearing: (window.CASE && window.CASE.hearingConfig && window.CASE.hearingConfig.clock) ||
    { totalMinutes: 30, sides: 2, motions: 2, wpm: 140, perPointMin: 0.9, responseMaxMin: 6, reserveMin: 2 },

  debug: true,

  // Durable on-disk transcript log. launch.command starts a tiny writer; the app fire-and-forget
  // POSTs each segment. Append-only file at hearing-copilot/logs/transcript-<date>.jsonl.
  logServer: { enabled: true, url: "http://localhost:8790/log" },

  // Speaker auto-detection (voice profiles). launch.command starts app/speaker-server.py on 8791;
  // each finalized utterance WAV is fingerprinted there in parallel with transcription.
  //   mode "shadow" = suggestions only. mode "assist" = a tagged voice auto-applies at accept
  //   confidence. mode "auto" = assist plus text fusion (see llm.js classifySpeaker).
  //   caseId namespaces stored voice profiles; a per-hearing override lets the same interviewer/
  //   judge be recognized across multiple hearings in the same case.
  speakerId: {
    enabled: true,
    url: "http://localhost:8791",
    mode: "shadow",
    mapConf: 0.7,
    timeoutMs: 1500,
    caseId: (window.CASE && window.CASE.hearingConfig && window.CASE.hearingConfig.caseId) || "default"
  },

  // Speakers used for logging + matching. "me" segments (your mic) are not auto-matched. A hearing
  // profile may override this list via window.CASE.hearingConfig.speakers for a different party
  // structure (e.g. multiple defendants).
  speakers: (window.CASE && window.CASE.hearingConfig && window.CASE.hearingConfig.speakers) || [
    { id: "plaintiff", label: "Plaintiff" },
    { id: "court", label: "The Court" },
    { id: "other", label: "Other" },
    { id: "defendant", label: "Defendant" },
    { id: "me", label: "Me (my mic)" }
  ]
};
