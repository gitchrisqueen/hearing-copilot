// Case data for the Hearing Copilot. Paths are relative to the web-server root (normally this
// repo's own directory; see index.html and web-server.py's COPILOT_SERVE_ROOT knob).
//
// This is a FICTIONAL demo case ("Meridian Capital v. Placeholder Logistics") so the app is
// useful and testable out of the box. It exercises every field a real hearings/<id>/data.js
// profile can set. Copy this file as the starting point for a real one -- and keep the real one
// out of this repo; see hearings/README.md.

window.CASE = {
  title: "Meridian Capital v. Placeholder Logistics — Motion Hearing (demo)",

  // hearingConfig carries every per-hearing override the app and its LLM prompts read. All of
  // these are OPTIONAL; the app and llm.js fall back to generic defaults when unset. Only
  // classifySpeaker/reconcile/composeRebuttal's *Phrase / *Description fields are genuinely
  // "case content" (real party names, the specific legal theory) -- the rest is app behavior.
  hearingConfig: {
    caseId: "meridian-v-placeholder",              // namespaces stored voice profiles
    minMatchScore: 2,
    pageTitle: "Hearing Copilot — Meridian v. Placeholder (demo)",
    disclaimer: "Meridian v. Placeholder (demo case) · assist only, not legal advice",
    openingsBanner: "Demo hearing. Argue the motion to compel first if time is short.",
    // Read by llm.js's classifySpeaker/reconcile/composeRebuttal. Generic wording works fine;
    // these are here mainly so you can see where a real profile would put its own exact wording.
    hearingTypePhrase: "a civil motion hearing",
    reconcileHearingPhrase: "a civil motion hearing",
    plaintiffRoleDescription: "counsel for the moving party seeking to compel discovery. Cues: " +
      "'we respectfully request', 'plaintiff moves', 'we ask the Court to compel'",
    defendantRoleDescription: "the pro se defendant, OPPOSING the motion to compel. Cues: " +
      "'the motion should be denied', 'we object', 'the request is overbroad'",
    asrPrompt: "objection; sustained; overruled; Your Honor; motion to compel; discovery; " +
      "interrogatory; request for production; the record; counsel; proportionality; privilege log.",
    clock: { totalMinutes: 20, sides: 2, motions: 1, wpm: 140, perPointMin: 0.8, responseMaxMin: 5, reserveMin: 2 }
  },

  // Who the parties are. The rebuttal LLM is told which side it represents (from "Who Am I")
  // and which side is the opponent, so it argues biased for the user and never for the other side.
  parties: {
    plaintiff: {
      label: "Plaintiff",
      name: "Meridian Capital LLC",
      counsel: "Fictional Law Group (opposing counsel)",
      role: "the moving party seeking to compel discovery"
    },
    defendant: {
      label: "Defendant",
      name: "Placeholder Logistics, appearing pro se",
      counsel: "self-represented (pro se)",
      role: "opposing the motion to compel"
    }
  },

  // Defense strength per item. Drives On-deck ordering.
  priority: {
    "R-1": "high", "R-2": "med", "R-3": "high", "R-4": "low",
    "O-1": "high", "O-2": "med"
  },

  // Linchpins the rebuttal must anchor on (verified authorities/facts, fictional here).
  linchpins: [
    "Discovery Rule 26(b)(1) (fictional citation): requests must be proportional to the needs of the case.",
    "The moving party's own prior filing already produced the category of documents it now claims are missing."
  ],

  // Traps to avoid — fed to the rebuttal LLM as hard guardrails.
  traps: [
    "Do not concede that any withheld document is responsive; the dispute is about scope, not privilege.",
    "Cite nothing outside the linchpins/power phrases provided; never invent or paraphrase a citation."
  ],

  // Power phrases. Verbatim anchors to weave in and repeat aloud.
  powerPhrases: [
    "The request is not proportional to the needs of this case.",
    "Plaintiff already has what it says it is missing."
  ],

  docPaths: {
    finalScript: "hearings/example/SCRIPT.md"
  },

  // Binder PDFs would normally live under a folder like this; the demo profile has none, so the
  // binder panes show a "document not available" chip instead of a broken viewer -- see
  // app.js's resolvePdf().
  defendantsBinderBase: "hearings/example/binder/",
  defendantsTabs: [
    { tab: 1, title: "Defendant's Response to Motion to Compel (demo)", use: "Your opposition", pdf: "tab-01-response.pdf" }
  ],
  plaintiffBinderBase: "hearings/example/binder/",
  plaintiffTabs: [
    { tab: "P-1", title: "Plaintiff's Motion to Compel (demo)", pdf: "PB/motion-to-compel.pdf" }
  ],

  // Interactive rebuttal tracker. keywords drive the offline matcher.
  rebuttals: [
    { id: "R-1", heard: "Defendant has withheld responsive documents without justification.",
      keywords: ["withheld", "withholding", "no justification", "refused to produce"],
      tabs: ["Tab 1"],
      script: "Every document within the agreed scope has been produced. What Plaintiff is now asking for falls outside the categories either party proposed during the meet-and-confer, and Plaintiff never moved to expand that scope before filing this motion." },
    { id: "R-2", heard: "The requests are proportional to the needs of the case.",
      keywords: ["proportional", "proportionality", "needs of the case"],
      tabs: [],
      script: "Proportionality looks at the amount in controversy, the parties' relative resources, and the importance of the discovery. This request sweeps in years of unrelated records to chase a single disputed invoice; that is disproportionate on its face." },
    { id: "R-3", heard: "Plaintiff does not already have these records.",
      keywords: ["do not have", "never received", "not in our possession"],
      tabs: ["P-1"],
      script: "Plaintiff's own motion, at its Exhibit 1, attaches the very category of record it now says is missing. If there is a gap, it is a gap in Plaintiff's own filing, not in what was produced." },
    { id: "R-4", heard: "Sanctions are warranted for the delay in producing documents.",
      keywords: ["sanctions", "delay", "bad faith"],
      tabs: [],
      script: "There has been no bad-faith delay. Every deadline the parties agreed to has been met, and the current dispute is over scope, raised in good faith and briefed promptly." }
  ],

  // Interactive objection tracker.
  objections: [
    { id: "O-1", trigger: "Court signals it will grant the motion to compel as written.",
      keywords: ["inclined to grant", "granting the motion", "compel as written"], tabs: ["Tab 1"],
      script: "Defendant objects to compelling production beyond the agreed scope. We ask that any order be limited to the categories the parties actually discussed, and that the Court state its reasons for anything broader." },
    { id: "O-2", trigger: "Plaintiff asks the Court to award fees for bringing the motion.",
      keywords: ["award fees", "fee shifting", "cost of this motion"], tabs: [],
      script: "Defendant objects to fee-shifting. The dispute was raised and briefed in good faith over a genuine scope disagreement, not an unjustified refusal to participate in discovery." }
  ],

  preservationTail: "Understood, Your Honor. Defendant respectfully notes the objection for the record."
};
