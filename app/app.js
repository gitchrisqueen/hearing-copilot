// Hearing Copilot wiring. Vanilla JS, no build step.
(function () {
  var C = window.CASE;
  var CONFIG = window.CONFIG || { ui: {}, speakers: [{ id: "plaintiff", label: "Plaintiff" }, { id: "court", label: "The Court" }, { id: "me", label: "Me (defense)" }], asr: {}, llm: {} };
  var state = {
    speaker: "plaintiff",
    docCache: {},
    binderSide: "def",
    currentLeft: "openings",
    triggered: [],   // ids queued to read, in order (rebuttal/objection ids)
    handled: {},     // id -> true once read/handled
    live: false,     // live listening/recording on
    llmOnline: false,// LLM reachable
    voiceOnline: null, // speaker-ID sidecar reachable (null = not probed yet)
    voices: {},      // voice cluster id -> {n, mapped, name, speaker, persistent, ts}
    taggingVoice: null,   // cluster id with the tag-once form open
    armedExpected: null,  // index into expectedSpeakers armed for the roll call, or null
    armedAt: 0,           // when it was armed (auto-expires)
    transcriptDate: null,
    leftScroll: {},  // remembered scroll position per left tab
    recordMe: (window.CONFIG && window.CONFIG.asr && window.CONFIG.asr.captureSelf) || false,
    matchWindow: {}, // speaker -> [{text, ts}] rolling buffer for cross-line matching
    lastFired: {},   // matched id -> timestamp (cooldown)
    matchCount: {},  // matched id -> how many times it has been detected
    recentRemote: [],// recent remote-side lines, to drop self-mic echo (acoustic bleed)
    copilotView: "live",   // "live" | "whoami"
    myParty: "defendant",  // which party YOU are (labels your own mic lines)
    myName: "",            // optional display name for your lines
    speakerTimeline: [{ speaker: "plaintiff", ts: 0 }],  // when each "who's speaking" toggle happened
    rebuttalScript: null,  // last generated rebuttal text
    rebuttalBusy: false,
    hearing: { startTs: 0 },  // dynamic clock start (resets on reload); length comes from CONFIG.hearing
    deckReason: {},        // id -> short reason from the whole-transcript reconciliation pass
    suppressed: {},        // id -> true when the user manually removed it (reconcile won't re-add it)
    deckDropped: {},       // id -> ts the reconciliation pass pruned it (short re-trigger cooldown)
    reconcileBusy: false,  // a reconciliation pass is in flight
    lastReconcileSig: "",  // signature of the transcript+match count last reconciled (skip if unchanged)
    lastReconcileAt: 0,    // when the last reconciliation applied a change (for the "auto-tuned Ns ago" note)
    matchEpoch: 0          // bumped each time live matching queues something (drives the reconcile trigger)
  };
  // el/esc/dbg/notify come from copilot-core's shell.js (loaded before this file) rather than
  // being redefined here -- they were byte-identical to tech-interview-copilot's copies, which is
  // exactly the duplication copilot-core exists to remove.
  var Shell = window.CopilotShell || {};
  var el = Shell.el || function (id) { return document.getElementById(id); };
  var esc = Shell.esc || function (s) { return String(s || ""); };
  var escapeHtml = esc;   // this file's original name for the same function
  var dbg = Shell.makeLogger ? Shell.makeLogger("copilot", function () { return !!CONFIG.debug; })
                              : function () {};
  var notifier = Shell.makeNotifier ? Shell.makeNotifier({
    max: (CONFIG.ui && CONFIG.ui.notifierMax) || 10,
    onChange: renderNotifier
  }) : null;
  function notify(msg) { if (notifier) notifier.notify(msg); }

  function HRC() { return CONFIG.hearing || { totalMinutes: 30, sides: 2, motions: 2, wpm: 140 }; }
  function fmtMin(m) { m = Math.max(0, m); var mm = Math.floor(m), ss = Math.round((m - mm) * 60); if (ss === 60) { mm++; ss = 0; } return mm + ":" + (ss < 10 ? "0" : "") + ss; }
  function agoText(ts) { var s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? (s + "s ago") : (Math.round(s / 60) + "m ago"); }
  function myWordsUsed() {
    return TLOG.byDate(TLOG.today()).filter(function (s) { return s.speaker === state.myParty || s.speaker === "me"; })
      .reduce(function (n, s) { return n + (s.text || "").split(/\s+/).filter(Boolean).length; }, 0);
  }
  function hearingStats() {
    var h = HRC(), now = Date.now();
    var shareMin = h.totalMinutes / (h.sides || 2);
    var usedMin = myWordsUsed() / (h.wpm || 140);
    return {
      shareMin: shareMin, perMotionMin: shareMin / (h.motions || 1), wpm: h.wpm || 140,
      started: state.hearing.startTs > 0,
      elapsedMin: state.hearing.startTs > 0 ? (now - state.hearing.startTs) / 60000 : 0,
      hearingRemainingMin: Math.max(0, h.totalMinutes - (state.hearing.startTs > 0 ? (now - state.hearing.startTs) / 60000 : 0)),
      usedMin: usedMin, yourRemainingMin: Math.max(0, shareMin - usedMin)
    };
  }
  // Who was selected as the incoming speaker at time ts (so a chunk is tagged by when it was SPOKEN,
  // not when whisper happened to finish it — fixes lag when you toggle mid-testimony).
  function speakerAt(ts) {
    var tl = state.speakerTimeline, pick = tl[0].speaker;
    for (var i = 0; i < tl.length; i++) { if (tl[i].ts <= ts) pick = tl[i].speaker; else break; }
    return pick;
  }
  function findItem(id) { return C.rebuttals.concat(C.objections).filter(function (x) { return x.id === id; })[0]; }
  function heardText(item) { return item.heard || item.trigger; }

  function fetchDoc(path) {
    return fetch(encodeURI(path)).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    });
  }

  // ---------- state transitions (also the plugin API surface) ----------
  function triggerItem(id) {
    if (!findItem(id) || state.handled[id]) return;
    if (state.triggered.indexOf(id) === -1) state.triggered.push(id);
    refreshTrackers();
    scheduleSort();
  }
  function untriggerItem(id) {
    var i = state.triggered.indexOf(id);
    if (i >= 0) state.triggered.splice(i, 1);
    state.suppressed[id] = true;    // user pulled it -> the reconciliation pass won't silently re-add it
    delete state.deckReason[id];
    refreshTrackers();
  }
  function toggleTrigger(id) {
    if (state.triggered.indexOf(id) >= 0) untriggerItem(id); else triggerItem(id);
  }
  function setHandled(id, val) {
    if (val) {
      state.handled[id] = true;
      var i = state.triggered.indexOf(id);
      if (i >= 0) state.triggered.splice(i, 1); // reading it clears it from on-deck
    } else {
      delete state.handled[id];
    }
    refreshTrackers();
  }
  function resetTracking() {
    state.triggered = []; state.handled = {}; state.deckReason = {}; state.suppressed = {};
    state.deckDropped = {};
    state.lastReconcileSig = ""; state.lastReconcileAt = 0;
    refreshTrackers();
  }

  function onDeckIds() {
    return state.triggered.filter(function (id) { return !state.handled[id]; });
  }
  function refreshTrackers() {
    var lb = el("left-body"); var sc = lb ? lb.scrollTop : 0;   // keep the reader's place on re-render
    if (state.currentLeft === "rebuttals") renderRebuttals();
    else if (state.currentLeft === "objections") renderObjections();
    else if (state.currentLeft === "ondeck") renderOnDeck();
    var lb2 = el("left-body"); if (lb2) lb2.scrollTop = sc;
    updateOnDeckBadge();
  }
  function updateOnDeckBadge() {
    var btn = document.querySelector('#left-tabs button[data-view="ondeck"]');
    if (!btn) return;
    var n = onDeckIds().length;
    btn.textContent = n ? "On deck (" + n + ")" : "On deck";
  }

  // ---------- LEFT pane: script views ----------
  function extractSection(md, headingText) {
    var lines = md.split("\n"), start = -1, out = [];
    for (var i = 0; i < lines.length; i++) {
      if (start === -1) {
        if (/^##\s/.test(lines[i]) && lines[i].toLowerCase().indexOf(headingText.toLowerCase()) !== -1) { start = i; out.push(lines[i]); }
      } else {
        if (/^##\s/.test(lines[i])) break;
        out.push(lines[i]);
      }
    }
    return out.join("\n");
  }
  function renderOpenings() {
    var md = state.docCache.finalScript || "", body = el("left-body");
    if (!md) { body.className = "body"; body.innerHTML = loadingOrError(); return; }
    // Openings shows only the two opening statements. A later-filing analysis section is
    // background reading, not something to read aloud, so it is excluded here (still in Full script).
    var o1 = extractSection(md, "OPENING 1"), o2 = extractSection(md, "OPENING 2");
    body.className = "body md";
    // Banner text comes from the active hearing profile; falls back to the July-14 MSJ wording.
    var banner = (C && C.hearingConfig && C.hearingConfig.openingsBanner) ||
      "Path B openings. Argue Plaintiff's motion first if time is short. Tabs refer to the 22-tab binder on the right.";
    body.innerHTML = "<div class='banner'>" + banner + "</div>" + MD.render([o1, o2].filter(Boolean).join("\n\n"));
  }
  function renderFullScript() {
    var md = state.docCache.finalScript || "", body = el("left-body");
    body.className = "body md";
    body.innerHTML = md ? MD.render(md) : loadingOrError();
  }

  // ---------- LEFT pane: Rebuttal Script (compiled from On deck by the LLM) ----------
  function renderRebuttalScript() {
    var body = el("left-body"); body.className = "body";
    var ids = onDeckIds();
    var objIds = ids.filter(function (id) { return id.charAt(0) === "O"; });   // objections = raise NOW
    var rebIds = ids.filter(function (id) { return id.charAt(0) !== "O"; });   // rebuttals = woven response
    var st = hearingStats();
    var budgetTxt = st.yourRemainingMin > 0 && st.started ? (fmtMin(st.yourRemainingMin) + " of your time left") : (fmtMin(st.perMotionMin) + " per motion");
    var objBlock = "";
    if (objIds.length) {
      objBlock = "<div class='obj-now'><div class='obj-now-h'>&#9888; Objections to raise NOW (" + objIds.length + ") — make these the moment the trigger occurs, before you argue</div>" +
        objIds.map(function (id) {
          var it = findItem(id) || {};
          return "<div class='obj-item'><span class='id'>" + id + "</span> " + escapeHtml(it.script || "") +
            (it.tabs && it.tabs.length ? " <span class='note'>(" + it.tabs.join(", ") + ")</span>" : "") + "</div>";
        }).join("") + "</div>";
    }
    var head = "<div class='row' style='margin-bottom:8px'>" +
      "<span class='note' style='flex:1'>Rebuttal woven from " + rebIds.length + " point" + (rebIds.length === 1 ? "" : "s") +
        ", strongest first &middot; " + budgetTxt + ". <b>Highlighted</b> = slow down and say aloud.</span>" +
      "<button class='btn-mini' id='rebuild'" + (state.rebuttalBusy ? " disabled" : "") + ">" +
        (state.rebuttalBusy ? "Working…" : (state.rebuttalScript ? "Regenerate" : "Generate")) + "</button></div>";
    var content;
    if (state.rebuttalBusy) content = "<div class='note'>Composing your rebuttal to fit your remaining time…</div>";
    else if (state.rebuttalScript) content = "<div class='md rebuttal'>" + MD.render(state.rebuttalScript) + "</div>";
    else if (!rebIds.length && !objIds.length) content = "<div class='note'>Nothing on deck yet. Trigger some rebuttals or objections, then Generate.</div>";
    else if (!rebIds.length) content = "<div class='note'>No rebuttal points on deck (objections are listed above). Trigger some rebuttals, then Generate.</div>";
    else content = "<div class='note'>Click <b>Generate</b> to weave these " + rebIds.length + " points into a spoken rebuttal that fits your remaining time, strongest first, with citations and Tab references highlighted.</div>";
    body.innerHTML = objBlock + head + content;
    var b = el("rebuild"); if (b) b.onclick = generateRebuttal;
  }
  // Map a binder tab id -> which party's binder it belongs to (for doc-ownership context).
  function tabOwner(tab) {
    var t = String(tab);
    if ((C.plaintiffTabs || []).some(function (x) { return String(x.tab) === t; })) return "plaintiff";
    if ((C.defendantsTabs || []).some(function (x) { return String(x.tab) === t; })) return "defendant";
    // bare "Tab N" numbers in scripts refer to the defendant's 22-tab binder
    return "defendant";
  }
  function tabTitle(tab) {
    var t = String(tab), hit = null;
    (C.plaintiffTabs || []).concat(C.defendantsTabs || []).forEach(function (x) {
      if (String(x.tab) === t) hit = x.title;
    });
    return hit;
  }
  function generateRebuttal() {
    var seen = {};
    var ids = onDeckIds().filter(function (id) {
      if (id.charAt(0) === "O") return false;          // objections are made live, not woven
      if (seen[id]) return false; seen[id] = 1; return true;   // de-dupe ids so no point is written twice
    });
    if (!ids.length) { notify("No rebuttal points on deck to compile"); return; }
    state.rebuttalBusy = true; if (state.currentLeft === "rebuttalscript") renderRebuttalScript();

    // Who am I / who is the opponent, from the "Who Am I" tab.
    var meParty = state.myParty === "plaintiff" ? "plaintiff" : "defendant";
    var oppParty = meParty === "plaintiff" ? "defendant" : "plaintiff";
    var P = C.parties || {};
    var meInfo = P[meParty] || { label: meParty, name: meParty, role: "" };
    var oppInfo = P[oppParty] || { label: oppParty, name: oppParty, role: "" };
    var myName = (state.myName || "").trim();
    var me = { party: meParty, label: meInfo.label, name: myName ? (myName + " (" + meInfo.label + ")") : meInfo.name, role: meInfo.role };
    var opponent = { party: oppParty, label: oppInfo.label, name: oppInfo.name, role: oppInfo.role, counsel: oppInfo.counsel };

    var points = ids.map(function (id) {
      var it = findItem(id) || {};
      var tabs = (it.tabs || []).map(function (tb) { return { tab: tb, owner: tabOwner(tb), title: tabTitle(tb) }; });
      return { id: id, priority: itemPriority(id), heard: heardText(it), script: it.script, tabs: tabs };
    });
    // On-deck OBJECTIONS: their substance must also be carried in the response, otherwise a dispositive
    // point that happened to match only as an objection gets dropped from the woven rebuttal.
    // Pass them so the model folds them in (deduped).
    var objSeen = {};
    var objections = onDeckIds().filter(function (id) {
      if (id.charAt(0) !== "O") return false;
      if (objSeen[id]) return false; objSeen[id] = 1; return true;
    }).map(function (id) {
      var it = findItem(id) || {};
      var tabs = (it.tabs || []).map(function (tb) { return { tab: tb, owner: tabOwner(tb), title: tabTitle(tb) }; });
      return { id: id, priority: itemPriority(id), heard: heardText(it), script: it.script, tabs: tabs };
    });
    // Documents in play, annotated with which party's binder holds them.
    var docSeen = {}, docs = [];
    points.concat(objections).forEach(function (pt) {
      pt.tabs.forEach(function (tb) {
        if (docSeen[tb.tab]) return; docSeen[tb.tab] = 1;
        docs.push({ tab: tb.tab, owner: tb.owner, ownerLabel: (P[tb.owner] && P[tb.owner].label) || tb.owner, mine: tb.owner === meParty, title: tb.title });
      });
    });

    var transcript = TLOG.byDate(TLOG.today())
      .filter(function (s) { return s.speaker === oppParty || s.speaker === "court"; })
      .slice(-14).map(function (s) { return s.speaker + ": " + s.text; });
    var st = hearingStats();
    var H = CONFIG.hearing || {};
    // Response length is driven by (a) how many points you're actually weaving and (b) your remaining
    // speaking share — NOT by any fixed paste-in cap (the old 2.2-min limit was for the mock tester, which
    // had a character cap; a live FL hearing doesn't). Three knobs, all overridable in CONFIG.hearing:
    //   perPointMin   ~ minutes of speaking each woven point deserves (develops the argument, not padding)
    //   responseMaxMin  a sane ceiling so one response never becomes a filibuster
    //   reserveMin      keep this much of your share in reserve for the rest of the hearing
    var perPointMin = H.perPointMin || 0.9;
    var responseMaxMin = H.responseMaxMin || 6;
    var reserveMin = (H.reserveMin != null) ? H.reserveMin : 2;
    var avail = (st.started && st.yourRemainingMin > 0.5) ? Math.max(0.75, st.yourRemainingMin - reserveMin) : st.perMotionMin;
    var byPoints = Math.max(1.5, perPointMin * Math.max(1, points.length));   // scale with # points; floor 1.5 min
    var budgetMin = Math.min(avail, byPoints, responseMaxMin);                // smallest of: time left, point-scaled, ceiling
    var budget = { minutes: budgetMin, words: Math.round(budgetMin * st.wpm), wpm: st.wpm };
    var wantedLlm = state.llmOnline && window.LLM && LLM.composeRebuttal;
    function done(text) {
      state.rebuttalBusy = false;
      var usedOffline = !text;
      state.rebuttalScript = text || offlineRebuttal(points);
      if (state.currentLeft === "rebuttalscript") renderRebuttalScript();
      var used = (window.LLM && LLM.last && LLM.last()) || null;
      var via = used ? (used.provider + " / " + used.model) : "offline keyword compile";
      try { console.log("[Hearing Copilot] rebuttal generated via " + via); } catch (e) {}
      if (usedOffline && wantedLlm) notify("Offline compile (all LLMs unavailable) — verbatim scripts in priority order");
      else notify("Rebuttal ready via " + via + " (~" + budget.words + " words / " + fmtMin(budget.minutes) + ")");
      // Objection-carry QA (llm.js): say so when the draft had to be revised or the prepared wording spliced in.
      var ci = (window.LLM && LLM.lastCompose && LLM.lastCompose()) || null;
      if (ci && !usedOffline) {
        if (ci.appended && ci.appended.length) notify("Objection " + ci.appended.join(", ") + " was missing — prepared wording inserted verbatim");
        else if (ci.repaired) notify("Draft regenerated to include every on-deck objection");
      }
    }
    if (wantedLlm) {
      LLM.composeRebuttal({
        me: me, opponent: opponent, docs: docs,
        points: points, objections: objections, transcript: transcript,
        powerPhrases: C.powerPhrases || [], linchpins: C.linchpins || [], traps: C.traps || [],
        // Emphasis layer (see the hearing profile): anchorPhrases are short sayable lines the composer bolds
        // and repeats; emphasize is the always-bold list of rule cites and record identifiers. Both optional —
        // a profile without them falls back to bolding by category and anchoring on powerPhrases[0].
        anchorPhrases: C.anchorPhrases || [], emphasize: C.emphasize || [], budget: budget
      }).then(done).catch(function () { done(null); });
    } else { done(null); }
  }
  function offlineRebuttal(points) {
    var out = "Your Honor, in response:\n\n";
    points.forEach(function (p, i) { out += "**" + (i + 1) + ". " + p.heard + "**\n\n" + (p.script || "") + "\n\n"; });
    out += "*(Offline compile: your verbatim scripts in priority order. Turn on the LLM for a woven version.)*";
    return out;
  }

  // ---------- LEFT pane: trackers ----------
  function tabChips(item) {
    return (item.tabs || []).map(function (t) { return "<span class='chip tab' data-tab='" + t + "'>" + t + "</span>"; }).join(" ");
  }
  function trackerCard(item, kind) {
    var triggered = state.triggered.indexOf(item.id) >= 0;
    var done = !!state.handled[item.id];
    var cls = "card" + (done ? " done" : "") + (triggered ? " hit" : "");
    var trigLabel = triggered ? "On deck ✓" : "Trigger";
    return "" +
      "<div class='card " + (done ? "done" : "") + (triggered ? " hit" : "") + "' id='card-" + item.id + "'>" +
        "<div class='head'>" +
          "<span class='id'>" + item.id + "</span>" +
          "<span class='heard'>" + escapeHtml(heardText(item)) + "</span>" +
        "</div>" +
        "<div class='script'>" + escapeHtml(item.script) + "</div>" +
        "<div class='row'>" +
          tabChips(item) +
          "<span style='flex:1'></span>" +
          "<button class='btn-mini' data-copy='" + item.id + "'>Copy</button>" +
          "<button class='btn-mini' data-trig='" + item.id + "'>" + trigLabel + "</button>" +
          "<label class='check'><input type='checkbox' data-done='" + item.id + "'" + (done ? " checked" : "") + "> handled</label>" +
        "</div>" +
      "</div>";
  }
  function renderRebuttals() {
    var body = el("left-body"); body.className = "body";
    body.innerHTML = "<div class='note'>What you may hear. <b>Trigger</b> queues it to On deck to read; " +
      "<b>handled</b> checks it off. The live plugin drives both automatically.</div>" +
      C.rebuttals.map(function (r) { return trackerCard(r, "reb"); }).join("");
    wireCards();
  }
  function renderObjections() {
    var body = el("left-body"); body.className = "body";
    body.innerHTML = "<div class='note'>Objections you raise. Trigger to queue for reading; handled to check off. " +
      "After any adverse ruling, read the preservation tail.</div>" +
      C.objections.map(function (o) { return trackerCard(o, "obj"); }).join("") +
      "<div class='banner'><b>Preservation tail:</b> " + escapeHtml(C.preservationTail) + "</div>";
    wireCards();
  }
  function renderOnDeck() {
    var body = el("left-body"); body.className = "body";
    var ids = onDeckIds();
    if (!ids.length) {
      body.innerHTML = "<div class='note'>Nothing on deck. Trigger a rebuttal or objection (or let the live " +
        "plugin do it) and it will load here, big and ready to read. Marking it <b>handled</b> clears it.</div>";
      return;
    }
    var tuned = state.lastReconcileAt ? (" &middot; <span class='note'>auto-tuned " + agoText(state.lastReconcileAt) + "</span>") : "";
    body.innerHTML = "<div class='row' style='margin-bottom:6px'><span class='note' style='flex:1'>Read these in order. Tap <b>Mark read</b> when done and it clears." + tuned + "</span>" +
      "<button class='btn-mini' id='ondeck-sort'>Auto-order (LLM)</button></div>" +
      ids.map(function (id) {
        var item = findItem(id);
        var pri = itemPriority(id), cnt = state.matchCount[id] || 0;
        var reason = state.deckReason[id];
        return "<div class='card hit' id='deck-" + id + "'>" +
          "<div class='head'><span class='id'>" + id + "</span>" +
            "<span class='pri pri-" + pri + "'>" + pri.toUpperCase() + "</span>" +
            (cnt > 1 ? "<span class='cnt' title='detected " + cnt + " times'>&times;" + cnt + "</span>" : "") +
            "<span class='heard'>" + escapeHtml(heardText(item)) + "</span></div>" +
          (reason ? "<div class='deck-reason' title='why the full-transcript review kept this'>&#9998; " + escapeHtml(reason) + "</div>" : "") +
          "<div class='script' style='font-size:1.05rem; line-height:1.6'>" + escapeHtml(item.script) + "</div>" +
          "<div class='row'>" + tabChips(item) + "<span style='flex:1'></span>" +
          "<button class='btn-mini' data-copy='" + id + "'>Copy</button>" +
          "<button class='btn-mini' data-read='" + id + "'>Mark read</button>" +
          "<button class='btn-mini' data-untrig='" + id + "'>Remove</button>" +
          "</div></div>";
      }).join("");
    wireCards();
  }

  function wireCards() {
    document.querySelectorAll("[data-copy]").forEach(function (b) {
      b.onclick = function () { var it = findItem(b.getAttribute("data-copy")); if (it) copyText(it.script, b); };
    });
    document.querySelectorAll("[data-trig]").forEach(function (b) {
      b.onclick = function () { toggleTrigger(b.getAttribute("data-trig")); };
    });
    document.querySelectorAll("[data-done]").forEach(function (c) {
      c.onchange = function () { setHandled(c.getAttribute("data-done"), c.checked); };
    });
    document.querySelectorAll("[data-read]").forEach(function (b) {
      b.onclick = function () { setHandled(b.getAttribute("data-read"), true); };
    });
    document.querySelectorAll("[data-untrig]").forEach(function (b) {
      b.onclick = function () { untriggerItem(b.getAttribute("data-untrig")); };
    });
    document.querySelectorAll(".chip.tab").forEach(function (ch) {
      ch.onclick = function () { openTabByRef(ch.getAttribute("data-tab")); };
    });
    var sb = el("ondeck-sort"); if (sb) sb.onclick = function () {
      if (!state.llmOnline) { notify("LLM offline; cannot auto-order"); return; } runSort();
    };
  }

  // ---------- RIGHT: binder ----------
  state.binderScroll = { def: 0, pl: 0 };  // remembered list scroll per side
  state.lastTab = { def: null, pl: null };  // last opened tab per side (for highlight)

  function resolvePdf(t, side) {
    if (!t.pdf) return null;
    if (t.pdf.indexOf("PB/") === 0) return C.plaintiffBinderBase + t.pdf.slice(3); // plaintiff court-filed
    if (t.pdf.charAt(0) === "/") return t.pdf;                                      // full path
    return (side === "def" ? C.defendantsBinderBase : "") + t.pdf;                  // defendants folder
  }
  function tabLabel(side, t) { return side === "def" ? ("Tab " + t.tab) : t.tab; }

  function renderBinderList(restoreScroll) {
    var body = el("binder-body");
    body.classList.remove("flush");   // list view uses normal padding/scroll
    var side = state.binderSide;
    var list = side === "def" ? C.defendantsTabs : C.plaintiffTabs;
    var html = "<ul class='binder-list'>";
    list.forEach(function (t) {
      var sel = String(state.lastTab[side]) === String(t.tab) ? " sel" : "";
      html += "<li class='" + sel + "' data-tab='" + escapeHtml(String(t.tab)) + "'>" +
        "<span class='tabno'>" + tabLabel(side, t) + "</span>" +
        "<span class='tt'>" + escapeHtml(t.title) +
          (t.use ? "<div class='use'>" + escapeHtml(t.use) + "</div>" : "") + "</span></li>";
    });
    html += "</ul>";
    body.innerHTML = html;
    body.querySelectorAll("li").forEach(function (li) {
      li.onclick = function () {
        state.binderScroll[side] = body.scrollTop;         // remember where we were
        showTab(side, li.getAttribute("data-tab"));
      };
    });
    // restore scroll when coming back via "all tabs"; reset to top otherwise
    body.scrollTop = restoreScroll ? (state.binderScroll[side] || 0) : 0;
  }

  function showTab(side, tab) {
    var list = side === "def" ? C.defendantsTabs : C.plaintiffTabs;
    var t = list.filter(function (x) { return String(x.tab) === String(tab); })[0];
    if (!t) return;
    state.lastTab[side] = t.tab;
    var body = el("binder-body");
    var head = "<div class='meta'><button class='btn-mini' id='binder-back'>&larr; all tabs</button> &nbsp; " +
      "<b>" + tabLabel(side, t) + "</b> — " + escapeHtml(t.title) +
      (t.pdfNote ? "<div class='use'>" + escapeHtml(t.pdfNote) + "</div>" : "") + "</div>";
    var pdf = resolvePdf(t, side);
    body.classList.add("flush");   // let the viewer fill the whole card edge-to-edge
    if (!pdf) {
      body.innerHTML = "<div class='pdf-wrap'>" + head +
        "<div class='pdf-none'>No PDF wired for this tab yet. Add a path to this entry in <code>app/data.js</code>.</div></div>";
      return;
    }
    // encodeURI leaves apostrophes intact; since the src is wrapped in single quotes, a
    // filename apostrophe would close the attribute early and truncate the URL (404). Encode it.
    var src = encodeURI(pdf).replace(/'/g, "%27");
    body.innerHTML = "<div class='pdf-wrap'>" + head + "<div class='pdf-none'>Checking document&hellip;</div></div>";
    // A wired path is not a guarantee the file exists (a public demo profile intentionally points
    // at placeholder paths). Check before embedding it, so a missing document shows a plain
    // in-app message instead of the browser's raw 404 page rendered inside the iframe.
    fetch(pdf, { method: "HEAD" }).then(function (r) {
      if (state.binderSide !== side || String((C[side === "def" ? "defendantsTabs" : "plaintiffTabs"].filter(function (x) { return x.tab === t.tab; })[0] || {}).tab) !== String(tab)) return; // user navigated away
      var wrap = el("binder-body").querySelector(".pdf-wrap");
      if (!wrap) return;
      if (r.ok) {
        wrap.innerHTML = head + "<iframe src='" + src + "'></iframe>";
      } else {
        wrap.innerHTML = head + "<div class='pdf-none'>Document not available (" + escapeHtml(pdf) +
          "). This tab's PDF has not been added to this checkout.</div>";
      }
    }).catch(function () {
      var wrap = el("binder-body").querySelector(".pdf-wrap");
      if (wrap) wrap.innerHTML = head + "<div class='pdf-none'>Document not available (" + escapeHtml(pdf) + ").</div>";
    });
    // "all tabs" returns to the list at the remembered scroll position
    var b = el("binder-back"); if (b) b.onclick = function () { renderBinderList(true); };
  }

  function openTabByRef(ref) {
    // exact plaintiff id first (handles "P-2 Ex.2", "P-2 Ex.5", "NEW")
    if (C.plaintiffTabs.some(function (t) { return String(t.tab) === ref; })) {
      setBinderSide("pl"); showTab("pl", ref); flashBinder(); return;
    }
    var m = ref.match(/Tab\s*(\d+[A-Z]?)/i);
    if (m) { setBinderSide("def"); showTab("def", m[1]); flashBinder(); return; }
    if (/NEW/i.test(ref)) { setBinderSide("pl"); showTab("pl", "NEW"); flashBinder(); return; }
    var p = ref.match(/P-?(\d+)/i);
    if (p) { setBinderSide("pl"); showTab("pl", "P-" + p[1]); flashBinder(); return; }
  }
  function flashBinder() {
    var p = el("binder-body").closest(".panel");
    p.style.boxShadow = "0 0 0 3px var(--accent-soft)";
    setTimeout(function () { p.style.boxShadow = ""; }, 700);
  }
  function setBinderSide(side) {
    state.binderSide = side;
    document.querySelectorAll("#binder-tabs button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-side") === side);
    });
    if (side === "live") renderTranscripts();
    else renderBinderList(false);
  }

  // ---------- RIGHT: live transcripts (dated, editable) ----------
  function speakerOptions(sel) {
    return CONFIG.speakers.map(function (s) {
      return "<option value='" + s.id + "'" + (s.id === sel ? " selected" : "") + ">" + s.label + "</option>";
    }).join("");
  }
  function renderTranscripts() {
    var body = el("binder-body");
    var dates = TLOG.dates();
    if (dates.length === 0) dates = [TLOG.today()];
    if (dates.indexOf(state.transcriptDate) === -1) state.transcriptDate = dates[0];
    var date = state.transcriptDate;
    var segs = TLOG.byDate(date);
    var head = "<div class='meta'>" +
      "<b>Live transcripts</b> &nbsp; <select id='tl-date'>" +
        dates.map(function (d) { return "<option" + (d === date ? " selected" : "") + ">" + d + "</option>"; }).join("") +
      "</select> " +
      "<button class='btn-mini' id='tl-download'>Download</button> " +
      "<button class='btn-mini' id='tl-clear'>Clear day</button>" +
      "<div class='use'>Reassign a speaker or fix text inline. Recording is controlled by the Live Copilot toggle below.</div>" +
      "</div>";
    var rows;
    if (!segs.length) {
      rows = "<div class='pdf-none'>No segments logged for " + date + " yet. Enable the Live Copilot to start recording.</div>";
    } else {
      rows = "<div class='tl-list'>" + segs.map(function (s) {
        var t = new Date(s.ts).toLocaleTimeString();
        var matched = s.matchedId ? "<span class='chip'>" + s.matchedId + "</span>" : "";
        return "<div class='tl-row' data-id='" + s.id + "'>" +
          "<span class='tl-time'>" + t + "</span>" +
          (s.name ? "<span class='tl-name'>" + escapeHtml(s.name) + "</span>" : "") +
          "<select class='tl-speaker' data-id='" + s.id + "'>" + speakerOptions(s.speaker) + "</select>" +
          "<span class='tl-text' contenteditable='true' data-id='" + s.id + "'>" + escapeHtml(s.text) + "</span>" +
          "<span class='tl-actions'>" +
            (s.llmSpeaker && s.llmSpeaker !== s.speaker ?
              "<button class='llm-flag' data-accept='" + s.id + "' data-to='" + s.llmSpeaker + "' title='The AI thinks this is " + escapeHtml(speakerLabel(s.llmSpeaker)) + ". Click to accept, or ignore.'>LLM: " + escapeHtml(speakerLabel(s.llmSpeaker)) + "?</button>" : "") +
            (s.voiceSpeaker && s.voiceSpeaker !== s.speaker ?
              "<button class='voice-flag" + (s.voiceLlmAgree ? " strong" : "") + "' data-vaccept='" + s.id + "' data-to='" + s.voiceSpeaker + "' title='This VOICE matches " + escapeHtml(s.voiceName || speakerLabel(s.voiceSpeaker)) + " (" + Math.round((s.voiceConf || 0) * 100) + "%)." + (s.voiceLlmAgree ? " The wording agrees." : "") + " Click to accept, or ignore.'>Voice" + (s.voiceLlmAgree ? "+LLM" : "") + ": " + escapeHtml(s.voiceName || speakerLabel(s.voiceSpeaker)) + "?</button>" : "") +
            matched +
            "<button class='btn-mini' data-tmatch='" + s.id + "'>&rarr; match</button>" +
            "<button class='btn-mini' data-tdel='" + s.id + "'>&times;</button>" +
          "</span></div>";
      }).join("") + "</div>";
    }
    // Follow new entries to the BOTTOM (newest), but only if the reader is already at/near the bottom.
    // If they've scrolled up to review an earlier line, keep their exact place instead of yanking them.
    var prev = body.querySelector(".tl-scroll");
    var stick = true, keepTop = 0;
    if (prev) {
      keepTop = prev.scrollTop;
      stick = (prev.scrollTop + prev.clientHeight >= prev.scrollHeight - 48);  // 48px slack = "at bottom"
    }
    body.innerHTML = "<div class='pdf-wrap'>" + head + "<div class='tl-scroll'>" + rows + "</div></div>";
    var sc = body.querySelector(".tl-scroll");
    if (sc) sc.scrollTop = stick ? sc.scrollHeight : keepTop;
    wireTranscripts();
  }
  function wireTranscripts() {
    var d = el("tl-date"); if (d) d.onchange = function () { state.transcriptDate = d.value; renderTranscripts(); };
    var dl = el("tl-download"); if (dl) dl.onclick = function () { downloadTranscript(state.transcriptDate); };
    var cl = el("tl-clear"); if (cl) cl.onclick = function () {
      var d = state.transcriptDate;
      if (!window.confirm("Clear ALL transcripts for " + d + "?\n\nThis permanently deletes them from the browser AND the disk log (logs/transcript-" + d + ".jsonl). This cannot be undone.")) return;
      TLOG.clearDate(d);                                   // browser copy
      var c = (CONFIG.logServer) || {};                    // disk copy
      if (c.enabled && c.url) {
        var base = c.url.replace(/\/log$/, "");
        fetch(base + "/log?date=" + encodeURIComponent(d), { method: "DELETE" })
          .then(function () { notify("Cleared transcripts for " + d); })
          .catch(function () { notify("Cleared browser copy; disk log writer not reachable"); });
      }
      renderTranscripts();
    };
    document.querySelectorAll(".tl-speaker").forEach(function (s) {
      s.onchange = function () {
        var id = s.getAttribute("data-id"), val = s.value, patch = { speaker: val };
        // Reassigning a line to YOUR side ("me" or your own party) means it is no longer opposing speech and
        // can't be the source of a rebuttal/objection. Clear THIS line's match chip -- but do NOT pull the
        // On-deck items: the same item may be supported by other lines. The reconciliation pass, which re-reads
        // the now-changed opposing transcript on its next interval, decides whether any should be removed.
        if (val === "me" || val === state.myParty) patch.matchedId = "";
        var seg = TLOG.all().filter(function (x) { return x.id === id; })[0];
        TLOG.update(id, patch);
        if (seg) confirmVoice(seg, val);   // a manual reassignment teaches the voice profile
        if (state.binderSide === "live") renderTranscripts();
      };
    });
    document.querySelectorAll(".tl-text").forEach(function (t) {
      t.onblur = function () { TLOG.update(t.getAttribute("data-id"), { text: t.innerText.trim() }); };
    });
    document.querySelectorAll("[data-tmatch]").forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-tmatch");
        var seg = TLOG.all().filter(function (x) { return x.id === id; })[0];
        if (seg) autoMatch(seg.text, seg.speaker, seg);   // explicit user override: match this line regardless of side
      };
    });
    document.querySelectorAll("[data-tdel]").forEach(function (b) {
      b.onclick = function () { TLOG.remove(b.getAttribute("data-tdel")); renderTranscripts(); };
    });
    document.querySelectorAll("[data-accept]").forEach(function (b) {
      b.onclick = function () { TLOG.update(b.getAttribute("data-accept"), { speaker: b.getAttribute("data-to"), llmSpeaker: null }); renderTranscripts(); };
    });
    document.querySelectorAll("[data-vaccept]").forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-vaccept"), to = b.getAttribute("data-to");
        var seg = TLOG.all().filter(function (x) { return x.id === id; })[0];
        TLOG.update(id, { speaker: to, voiceSpeaker: null });
        if (seg) confirmVoice(seg, to);   // accepting the chip teaches the profile too
        renderTranscripts();
      };
    });
  }
  function downloadTranscript(date) {
    var txt = "Hearing transcript " + date + "\n\n" + TLOG.exportText(date);
    var blob = new Blob([txt], { type: "text/plain" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "hearing-transcript-" + date + ".txt";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // ---------- RIGHT: live copilot ----------
  // The "who is speaking now" toggle (tags incoming/remote audio). Order = keyboard shortcuts 1..4.
  var REMOTE_ORDER = ["plaintiff", "court", "other", "defendant"];
  function setSpeakerUI(id) {
    if (REMOTE_ORDER.indexOf(id) === -1) return;
    if (window.ASR && ASR.flushRole) ASR.flushRole("remote");      // close out the previous speaker's utterance first
    state.speaker = id;
    state.speakerTimeline.push({ speaker: id, ts: Date.now() });   // record the toggle for time-based tagging
    document.querySelectorAll("#speakers button").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-s") === id); });
  }
  function onSpeakerHotkey(e) {
    var t = e.target || {}, tag = t.tagName || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;   // don't hijack typing
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var idx = { "1": 0, "2": 1, "3": 2, "4": 3 }[e.key];
    if (idx === undefined || !REMOTE_ORDER[idx]) return;
    e.preventDefault();
    setSpeakerUI(REMOTE_ORDER[idx]);
  }
  function renderCopilot() {
    document.querySelectorAll("#copilot-tabbar button[data-cop]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-cop") === state.copilotView);
    });
    if (state.copilotView === "whoami") renderWhoAmI();
    else if (state.copilotView === "timing") renderTiming();
    else renderLiveCopilotBody();
  }
  function timingLiveHtml(st) {
    return "<div class='tm-grid'>" +
      "<div>Elapsed</div><div><b>" + (st.started ? fmtMin(st.elapsedMin) : "—") + "</b></div>" +
      "<div>Hearing remaining</div><div><b>" + (st.started ? fmtMin(st.hearingRemainingMin) : "—") + "</b></div>" +
      "<div>Your time used (est.)</div><div><b>" + fmtMin(st.usedMin) + "</b></div>" +
      "<div>Your time remaining</div><div class='" + (st.yourRemainingMin < 2 ? "tm-warn" : "") + "'><b>" + fmtMin(st.yourRemainingMin) + "</b></div>" +
      "</div>";
  }
  function setHearingCfg() {
    var h = CONFIG.hearing;
    h.totalMinutes = Math.max(1, parseFloat(el("tm-total").value) || 30);
    h.sides = Math.max(1, parseInt(el("tm-sides").value, 10) || 2);
    h.motions = Math.max(1, parseInt(el("tm-motions").value, 10) || 2);
    try { localStorage.setItem("hc_hearing", JSON.stringify(h)); } catch (e) {}
  }
  function renderTiming() {
    var body = el("copilot"); body.className = "body";
    var h = HRC(), st = hearingStats();
    body.innerHTML =
      "<div class='timing'>" +
        "<div class='note'>Set the hearing length. Your speaking share = total ÷ sides, split across motions. " +
          "The clock starts on the first captured line (or press Start). Resets on reload.</div>" +
        "<div class='wa-label'>Hearing length</div>" +
        "<div class='tm-inputs'>" +
          "<label>Total min<input type='number' id='tm-total' min='1' step='1' value='" + h.totalMinutes + "'></label>" +
          "<label>Sides<input type='number' id='tm-sides' min='1' step='1' value='" + h.sides + "'></label>" +
          "<label>Motions<input type='number' id='tm-motions' min='1' step='1' value='" + h.motions + "'></label>" +
        "</div>" +
        "<div class='tm-budget'>Your share: <b>" + fmtMin(st.shareMin) + "</b> total &middot; <b>" + fmtMin(st.perMotionMin) + "</b> per motion (opening + response)</div>" +
        "<div class='tm-controls'>" + (st.started ?
          "<button class='btn-mini' id='tm-reset'>Reset clock</button>" :
          "<button class='live-toggle small' id='tm-start'>Start clock</button>") + "</div>" +
        "<div id='timing-live'>" + timingLiveHtml(st) + "</div>" +
      "</div>";
    ["tm-total", "tm-sides", "tm-motions"].forEach(function (id) { var e = el(id); if (e) e.onchange = function () { setHearingCfg(); renderTiming(); }; });
    var s = el("tm-start"); if (s) s.onclick = function () { state.hearing.startTs = Date.now(); renderTiming(); };
    var r = el("tm-reset"); if (r) r.onclick = function () { state.hearing.startTs = 0; renderTiming(); };
  }
  function setMyParty(p) { state.myParty = p; try { localStorage.setItem("hc_myparty", p); } catch (e) {} }
  function setMyName(n) { state.myName = n; try { localStorage.setItem("hc_myname", n); } catch (e) {} }
  function myLabelPreview() {
    var p = state.myParty === "plaintiff" ? "Plaintiff" : "Defendant";
    var n = (state.myName || "").trim();
    return n ? (n + " (" + p + ")") : p;
  }
  function renderWhoAmI() {
    var body = el("copilot"); body.className = "body copilot";
    var party = state.myParty || "defendant", name = state.myName || "";
    body.innerHTML =
      "<div class='whoami'>" +
        "<div class='note'>This is about <b>you</b> — the person on this microphone. It sets how your own spoken " +
          "lines are labeled in the transcript. It does <b>not</b> change the \"Who is speaking\" toggle (that " +
          "tags the other side, which may have several people).</div>" +
        "<div class='wa-label'>I am the:</div>" +
        "<div class='wa-party'>" +
          "<label><input type='radio' name='wa-party' value='defendant'" + (party === "defendant" ? " checked" : "") + "> Defendant</label>" +
          "<label><input type='radio' name='wa-party' value='plaintiff'" + (party === "plaintiff" ? " checked" : "") + "> Plaintiff</label>" +
        "</div>" +
        "<div class='wa-label'>My name (optional):</div>" +
        "<input type='text' id='wa-name' class='wa-name' placeholder='e.g. Chris' value='" + escapeHtml(name) + "'>" +
        "<div class='wa-preview'>Your lines will be labeled: <b id='wa-prev'>" + escapeHtml(myLabelPreview()) + "</b></div>" +
      "</div>";
    document.querySelectorAll("input[name='wa-party']").forEach(function (r) {
      r.onchange = function () { if (r.checked) { setMyParty(r.value); el("wa-prev").textContent = myLabelPreview(); } };
    });
    var ni = el("wa-name"); ni.oninput = function () { setMyName(ni.value); el("wa-prev").textContent = myLabelPreview(); };
  }
  function renderLiveCopilotBody() {
    var body = el("copilot");
    body.className = "body copilot";   // restore (Timing/Who Am I views change this class)
    body.innerHTML =
      "<div class='live-top'>" +
        "<button id='liveToggle' class='live-toggle' title='Start or stop listening and recording'>Enable live</button>" +
        "<button id='meToggle' class='live-toggle small' title='Whether to transcribe your OWN microphone (your side). Off = do not record you.'>My mic: " + (state.recordMe ? "on" : "off") + "</button>" +
        ((CONFIG.speakerId || {}).enabled ?
          "<span class='vmode' title='Voice auto-ID mode. shadow = suggest only. assist = tagged voices auto-apply. auto = voices + wording tag everything; the toggle is just an override.'>" +
            ["shadow", "assist", "auto"].map(function (m) {
              return "<button class='vmode-b" + (((CONFIG.speakerId || {}).mode === m) ? " on" : "") + "' data-vmode='" + m + "'>" + m + "</button>";
            }).join("") + "</span>" : "") +
        "<span class='status' id='costatus'></span>" +
      "</div>" +
      "<div class='speaker-label'>Who is speaking now? " +
        ((CONFIG.speakerId || {}).mode === "auto" ?
          "<span class='hint'>auto mode: voices and wording tag lines themselves. Click only to override.</span>" :
          "<span class='hint'>tags the audio you HEAR (the other side). Click or press 1-4 when the speaker changes.</span>") +
      "</div>" +
      "<div class='speakers" + (((CONFIG.speakerId || {}).mode === "auto") ? " demoted" : "") + "' id='speakers'>" +
        REMOTE_ORDER.map(function (id, i) {
          return "<button data-s='" + id + "'" + (id === state.speaker ? " class='on'" : "") +
            " title='Tag incoming speech as " + speakerLabel(id) + " (shortcut " + (i + 1) + ")'>" +
            "<span class='kbd'>" + (i + 1) + "</span> " + speakerLabel(id) + "</button>";
        }).join("") +
      "</div>" +
      "<div class='voices-strip' id='voicesStrip'></div>" +
      "<div class='interim' id='liveInterim'>&nbsp;</div>" +
      "<div class='note' style='margin:2px 0'>Auto-sync: detected points post below and go to On deck.</div>" +
      "<div class='notifier' id='notifier'></div>" +
      "<details class='manual'><summary>Manual entry (no mic)</summary>" +
        "<textarea id='heardbox' placeholder='Type what you heard, then Match.'></textarea>" +
        "<div class='actions'><button class='ghost' id='matchbtn'>Match</button></div>" +
      "</details>";
    document.querySelectorAll("#speakers button").forEach(function (b) {
      b.onclick = function () { setSpeakerUI(b.getAttribute("data-s")); };
    });
    document.querySelectorAll("[data-vmode]").forEach(function (b) {
      b.onclick = function () { setVoiceMode(b.getAttribute("data-vmode")); };
    });
    el("liveToggle").onclick = function () { setLive(!state.live); };
    el("meToggle").onclick = function () { setRecordMe(!state.recordMe); };
    el("matchbtn").onclick = function () {
      var t = (el("heardbox").value || "").trim(); if (!t) return;
      onFinalSegment(t, "remote", Date.now(), true);   // full-text match (find ALL rebuttals, not the last 600 chars)
      el("heardbox").value = "";
    };
    renderNotifier(); renderVoicesStrip(); updateCoStatus();
  }
  function setRecordMe(on) {
    state.recordMe = on;
    var b = el("meToggle"); if (b) { b.textContent = "My mic: " + (on ? "on" : "off"); b.classList.toggle("on", on); }
    if (window.ASR && ASR.enableSelf) ASR.enableSelf(on);   // start/stop the self capture live
    notify("Recording me: " + (on ? "on" : "off"));
  }
  function updateCoStatus() {
    var s = el("costatus"); if (!s) return;
    var mic;
    if (state.live) {
      var ti = (ASR.transcriber ? ASR.transcriber() : { label: (ASR.engine ? ASR.engine() : "asr"), degraded: false });
      var lbl = "Recording (" + ti.label + ")";
      // Degraded = configured for Together but currently served by the local whisper fallback -> warn in yellow.
      mic = ti.degraded ? "<span style='color:#d48806;font-weight:600' title='Together unavailable — using local whisper'>" + lbl + "</span>" : lbl;
    } else { mic = "Mic off"; }
    var used = (window.LLM && LLM.last && LLM.last());
    var prov = used ? (used.provider + "/" + used.model) : ((CONFIG.llm && CONFIG.llm.provider) || "llm");
    var sc = CONFIG.speakerId || {};
    var voice = !sc.enabled ? "" :
      " &middot; voice " + (state.voiceOnline ? (sc.mode || "shadow") :
        (state.voiceOnline === false ? "<span style='color:#d48806' title='speaker sidecar unreachable; toggle-only tagging'>off</span>" : "&hellip;"));
    s.innerHTML = mic + " &middot; " + prov + " " + (state.llmOnline ? "online" : "offline (keyword fallback)") + voice;
  }
  // One reachability probe for the speaker sidecar per live-enable; also seeds the Voices strip
  // with this case's stored profiles, so a previously-tagged voice shows as "(saved)" before
  // they even speak.
  function probeVoice() {
    var sc = CONFIG.speakerId || {};
    if (!sc.enabled || !sc.url) { state.voiceOnline = false; return; }
    fetch(sc.url + "/health?case=" + encodeURIComponent(sc.caseId || "default"))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.voiceOnline = !!(j && j.ok);
        updateCoStatus();
        return fetch(sc.url + "/voices?case=" + encodeURIComponent(sc.caseId || "default"));
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        ((j && j.clusters) || []).forEach(function (c) {
          if (!c.persistent && !state.voices[c.cluster]) return;
          var prev = state.voices[c.cluster] || {};
          state.voices[c.cluster] = { n: c.n || prev.n || 0, mapped: c.mapped || prev.mapped || null,
            name: c.name || prev.name || null, speaker: c.speaker || prev.speaker || null,
            persistent: !!c.persistent, ts: prev.ts || 0 };
        });
        renderVoicesStrip();
      })
      .catch(function () { state.voiceOnline = false; updateCoStatus(); });
  }
  function setLive(on) {
    state.live = on;
    var btn = el("liveToggle");
    if (on) {
      if (!ASR.supported()) { notify("No speech engine in this browser. Use Chrome, or whisper mode."); state.live = false; }
      else {
        ASR.start({
          onInterim: function (t) { var i = el("liveInterim"); if (i) i.textContent = t; },
          onFinal: function (t, role, startTs, voice) { var i = el("liveInterim"); if (i) i.textContent = ""; onFinalSegment(t, role || "remote", startTs, false, voice); },
          onStatus: function (msg) { updateCoStatus(); },
          onError: function (msg) { notify(msg); updateCoStatus(); }
        });
        if (window.ASR && ASR.enableSelf) ASR.enableSelf(state.recordMe);   // honor the Me toggle
        probeVoice();
      }
    } else {
      ASR.stop();
    }
    if (btn) { btn.textContent = state.live ? "Disable live" : "Enable live"; btn.classList.toggle("on", state.live); }
    updateCoStatus();
  }
  var MATCH = function () { return CONFIG.match || {}; };
  // The voice mode chosen in the UI survives reloads (localStorage beats the config default).
  try {
    var vmSaved = localStorage.getItem("hc_voicemode");
    if (vmSaved && CONFIG.speakerId && ["shadow", "assist", "auto"].indexOf(vmSaved) !== -1) CONFIG.speakerId.mode = vmSaved;
  } catch (e) {}
  function setVoiceMode(mode) {
    if (!CONFIG.speakerId) return;
    CONFIG.speakerId.mode = mode;
    try { localStorage.setItem("hc_voicemode", mode); } catch (e) {}
    notify("Voice mode: " + mode);
    renderLiveCopilotBody();
    probeVoice();
  }
  function minChars() { return (MATCH().autoMatchMinChars) || (CONFIG.ui && CONFIG.ui.autoMatchMinChars) || 16; }

  // A finished utterance. role is "remote" (the other side) or "self" (me).
  function normText(t) { return (t || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim(); }
  // Party labels and ultra-common words that carry no argument by themselves. Input made up of only these
  // (or a single bare token) must never fire a rebuttal/objection.
  var LOW_SIGNAL_WORDS = {
    plaintiff: 1, plaintiffs: 1, defendant: 1, defendants: 1, court: 1, judge: 1, objection: 1, objections: 1,
    counsel: 1, counselor: 1, honor: 1, your: 1, the: 1, a: 1, an: 1, and: 1, or: 1, of: 1, to: 1, is: 1,
    it: 1, that: 1, this: 1, argument: 1, argues: 1, said: 1, says: 1, motion: 1, hearing: 1
  };
  // A line must clear a minimum length AND contain at least two distinct meaningful words before it can
  // match. This is the same guard the rolling live-transcript path already applies (minChars), now shared by
  // the manual-entry and keyword paths so a bare word like "plaintiff" cannot surface anything on its own.
  function hasMatchableSubstance(text) {
    var norm = normText(text);
    if (norm.length < minChars()) return false;
    var words = norm.split(" ").filter(Boolean);
    if (words.length < 3) return false;
    var meaningful = {};
    words.forEach(function (w) { if (w.length > 2 && !LOW_SIGNAL_WORDS[w]) meaningful[w] = 1; });
    return Object.keys(meaningful).length >= 2;
  }
  // Your own side ("me" mic, or your Who-Am-I party) is never the source of a rebuttal/objection. This is
  // the single gate every match path checks. Matches the exclusion the reconciler uses for opposingTranscript.
  function isOpposingSpeaker(sp) { return sp && sp !== "me" && sp !== state.myParty; }
  function onFinalSegment(text, role, startTs, fullMatch, voice) {
    if (!text) return;
    if (!state.hearing.startTs) state.hearing.startTs = Date.now();   // clock starts on the first line
    var speaker, name = "";
    if (role === "self") { speaker = state.myParty || "defendant"; name = (state.myName || "").trim(); }
    else { speaker = speakerAt(startTs || Date.now()); }   // tag by when it was spoken, not finished
    var norm = normText(text), now = Date.now();
    state.recentRemote = state.recentRemote.filter(function (x) { return now - x.ts < 8000; });
    if (role === "self") {
      // Drop it if the self mic just echoed what the other side said (speaker bleed into the BRIO).
      var bleed = state.recentRemote.some(function (x) {
        return norm && (x.norm === norm || (norm.length > 8 && (x.norm.indexOf(norm) >= 0 || norm.indexOf(x.norm) >= 0)));
      });
      if (bleed) { dbg("drop self bleed (echo of remote):", text); return; }
    } else {
      state.recentRemote.push({ norm: norm, ts: now });
    }
    // Assist mode: a TAGGED voice auto-applies BEFORE the merge, so the line lands under the
    // right speaker (and merges with the right neighbors). Shadow mode and untagged voices never
    // reach here; they only chip below. The toggle/dropdown still overrides after the fact.
    var applied = assistSpeaker(role, voice);
    if (applied) {
      if (applied.speaker !== speaker) dbg("voice auto-apply:", speaker, "->", applied.speaker);
      speaker = applied.speaker;
      if (applied.name) name = applied.name;
    }
    dbg("heard", role, speaker, name, JSON.stringify(text));
    var seg = mergeOrAdd(speaker, name, text);     // clean up choppy lines
    attachVoice(seg, role, voice, !!applied);      // voice verdict: strip + chips (+ applied flag)
    if (state.binderSide === "live") renderTranscripts();
    // Only OPPOSING speech triggers rebuttals/objections. A line on YOUR side never matches — whether it's
    // your mic (role "self"), or a MANUAL entry typed while the "who is speaking" toggle is on your own
    // party. Gate on the resolved speaker, not just role, so manual entries as your party don't self-match.
    if (isOpposingSpeaker(speaker)) {
      if (fullMatch) autoMatch(text, speaker, seg); else matchRolling(speaker, seg);
    }
    maybeLlmSpeaker(seg);                              // optional LLM second-pass speaker check
  }
  // Assist decision: only a TAGGED voice (named or party-assigned) at accept confidence may
  // auto-apply, and only in assist mode. Everything else is a suggestion at most.
  function assistSpeaker(role, voice) {
    var sc = CONFIG.speakerId || {};
    if ((sc.mode !== "assist" && sc.mode !== "auto") || role === "self" || !voice || voice.ok === false) return null;
    if (voice.decision !== "accept" || !voice.speaker) return null;
    return { speaker: voice.speaker, name: voice.name || "" };
  }
  // Attach the speaker sidecar's voice verdict to the segment. The verdict arrives WITH the text
  // (asr.js joins the two promises), so chips are already on the line when it first renders.
  // Chip sources, in priority order: a tagged voice's party (accept or gray zone), then the
  // toggle-history mapping (accept only). Auto-applied lines never chip.
  function attachVoice(seg, role, voice, applied) {
    if (!voice || voice.ok === false || !voice.cluster || !seg) return;
    var sc = CONFIG.speakerId || {};
    var prev = state.voices[voice.cluster] || {};
    state.voices[voice.cluster] = {
      n: voice.clusterN || (prev.n || 0) + 1, mapped: voice.mapped || null,
      name: voice.name || prev.name || null, speaker: voice.speaker || prev.speaker || null,
      persistent: !!(voice.name || voice.speaker) || !!prev.persistent, ts: Date.now()
    };
    // Armed roll-call tag: this NEW voice is the expected speaker Chris just clicked.
    if (voice.decision === "new" && state.armedExpected !== null &&
        Date.now() - state.armedAt <= 45000) {
      var exp = ((window.CASE && window.CASE.hearingConfig && window.CASE.hearingConfig.expectedSpeakers) || [])[state.armedExpected];
      state.armedExpected = null;
      if (exp) labelVoice(voice.cluster, exp.speaker, exp.name || "");
    }
    renderVoicesStrip();
    var patch = { voice: { cluster: voice.cluster, decision: voice.decision, sim: voice.sim,
                           ts: voice.ts, applied: !!applied } };
    if (!applied && role !== "self") {
      if (voice.speaker && voice.speaker !== seg.speaker &&
          (voice.decision === "accept" || voice.decision === "suggest")) {
        patch.voiceSpeaker = voice.speaker;
        patch.voiceConf = voice.sim;
        patch.voiceName = voice.name || "";
      } else if (voice.mapped && voice.mapped.speaker && voice.mapped.speaker !== seg.speaker &&
                 (voice.mapped.conf || 0) >= (sc.mapConf || 0.7) && voice.decision === "accept") {
        patch.voiceSpeaker = voice.mapped.speaker;
        patch.voiceConf = voice.mapped.conf;
        patch.voiceName = "";
      }
      if (patch.voiceSpeaker) dbg("voice disagrees with toggle:", seg.speaker, "->", patch.voiceSpeaker);
    }
    TLOG.update(seg.id, patch);
  }
  // Tell the sidecar a human settled who a chunk belongs to (chip click, dropdown change, or a
  // tag on the Voices strip). This is what lets profiles learn from corrections.
  function confirmVoice(seg, speakerId) {
    var sc = CONFIG.speakerId || {};
    if (!sc.enabled || !sc.url || !seg || !seg.voice || !seg.voice.ts) return;
    if (speakerId === "me") speakerId = state.myParty || "defendant";
    fetch(sc.url + "/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ case: sc.caseId || "default", ts: seg.voice.ts, speaker: speakerId })
    }).catch(function () {});
  }
  // Tag a voice once: POST /label, then retroactively relabel every line of that cluster today.
  function labelVoice(cluster, speakerId, nm) {
    var sc = CONFIG.speakerId || {};
    if (!sc.url) return;
    fetch(sc.url + "/label", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ case: sc.caseId || "default", cluster: cluster,
                             speaker: speakerId || null, name: nm || null })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) { notify("Could not tag voice " + cluster); return; }
      var v = state.voices[cluster] || {};
      v.speaker = speakerId || v.speaker; v.name = nm || v.name; v.persistent = true;
      state.voices[cluster] = v;
      state.taggingVoice = null;
      var n = 0;
      TLOG.byDate(TLOG.today()).forEach(function (s) {
        if (s.voice && s.voice.cluster === cluster) {
          var patch = { voiceSpeaker: null };
          if (speakerId && s.speaker !== speakerId) patch.speaker = speakerId;
          if (nm && !s.name) patch.name = nm;
          if (patch.speaker || patch.name) n++;
          TLOG.update(s.id, patch);
        }
      });
      notify("Voice " + cluster + " tagged as " + (nm || speakerLabel(speakerId)) +
             (n ? " (" + n + " earlier lines relabeled)" : ""));
      renderVoicesStrip();
      if (state.binderSide === "live") renderTranscripts();
    }).catch(function () { notify("Voice tagging failed (sidecar unreachable)"); });
  }
  // The Voices strip under the toggle: every distinct voice heard (plus stored profiles), one
  // pill each. CLICK a pill to tag that voice once: pick an expected speaker, a party, or type a
  // name. Tagged voices persist per case and, in assist mode, auto-apply from then on.
  function renderVoicesStrip() {
    var v = el("voicesStrip"); if (!v) return;
    var sc = CONFIG.speakerId || {};
    var ids = Object.keys(state.voices);
    // Roll-call ghosts: expected speakers not yet attached to any voice. Click one as that
    // person starts talking (appearances) and the NEXT new voice is tagged as them, hands-free.
    var expected = (window.CASE && window.CASE.hearingConfig && window.CASE.hearingConfig.expectedSpeakers) || [];
    if (state.armedExpected !== null && Date.now() - state.armedAt > 45000) state.armedExpected = null;
    var ghosts = expected.map(function (e, i) { return { e: e, i: i }; }).filter(function (x) {
      return !ids.some(function (k) {
        var vx = state.voices[k];
        return (x.e.name && vx.name === x.e.name) || (!x.e.name && vx.speaker === x.e.speaker && vx.persistent);
      });
    });
    if (!sc.enabled || (!ids.length && !ghosts.length)) { v.innerHTML = ""; return; }
    ids.sort(function (a, b) { return (state.voices[b].n || 0) - (state.voices[a].n || 0); });
    var html = "<span class='voices-cap'>Voices heard <span class='hint'>(click one to name it)</span>:</span>" +
      ghosts.map(function (x) {
        var armed = state.armedExpected === x.i;
        return "<button class='voice-ghost" + (armed ? " armed" : "") + "' data-vghost='" + x.i +
          "' title='" + (armed ? "Armed: the next NEW voice heard will be tagged as this person. Click again to disarm."
                               : "Not heard yet. Click as this person starts speaking (roll call) and the next new voice is tagged as them.") +
          "'>" + (armed ? "&#9679; " : "") + escapeHtml(x.e.name || speakerLabel(x.e.speaker)) + "</button>";
      }).join("") +
      ids.map(function (k) {
        var x = state.voices[k];
        var label;
        if (x.name) label = escapeHtml(x.name);
        else if (x.speaker) label = escapeHtml(speakerLabel(x.speaker));
        else if (x.mapped) label = escapeHtml(speakerLabel(x.mapped.speaker)) + " " + Math.round((x.mapped.conf || 0) * 100) + "%";
        else label = "unmatched";
        var saved = x.persistent ? " voice-pill-saved" : "";
        return "<button class='voice-pill" + saved + "' data-vpill='" + k + "' title='Voice " + k + ": " +
          (x.n || 0) + " chunks heard" + (x.persistent ? "; stored for this case" : "") +
          ". Click to tag this voice (name and party).'>" + k + " &middot; " + label + "</button>";
      }).join("");
    if (state.taggingVoice) html += voiceTaggerHtml(state.taggingVoice);
    v.innerHTML = html;
    document.querySelectorAll("[data-vpill]").forEach(function (b) {
      b.onclick = function () {
        state.taggingVoice = state.taggingVoice === b.getAttribute("data-vpill") ? null : b.getAttribute("data-vpill");
        renderVoicesStrip();
      };
    });
    document.querySelectorAll("[data-vghost]").forEach(function (b) {
      b.onclick = function () {
        var i = parseInt(b.getAttribute("data-vghost"), 10);
        state.armedExpected = state.armedExpected === i ? null : i;
        state.armedAt = Date.now();
        renderVoicesStrip();
      };
    });
    wireVoiceTagger();
  }
  // The inline tag-once form: expected speakers for this hearing first (one click during the
  // appearances roll call), then the four parties plus an optional free-name field.
  function voiceTaggerHtml(cluster) {
    var expected = (window.CASE && window.CASE.hearingConfig && window.CASE.hearingConfig.expectedSpeakers) || [];
    var x = state.voices[cluster] || {};
    return "<div class='voice-tagger' id='voiceTagger'>" +
      "<span class='vt-cap'>" + cluster + " is:</span>" +
      expected.map(function (e, i) {
        return "<button class='vt-expected' data-vtexp='" + i + "' title='" + escapeHtml(e.name || "") + " (" + escapeHtml(speakerLabel(e.speaker)) + ")'>" +
          escapeHtml(e.name || speakerLabel(e.speaker)) + "</button>";
      }).join("") +
      REMOTE_ORDER.map(function (id) {
        return "<button class='vt-party' data-vtparty='" + id + "'>" + escapeHtml(speakerLabel(id)) + "</button>";
      }).join("") +
      "<input type='text' id='vtName' class='vt-name' placeholder='name (optional)' value='" + escapeHtml(x.name || "") + "'>" +
      "<button class='btn-mini' id='vtCancel'>cancel</button>" +
      "</div>";
  }
  function wireVoiceTagger() {
    var cluster = state.taggingVoice; if (!cluster || !el("voiceTagger")) return;
    var expected = (window.CASE && window.CASE.hearingConfig && window.CASE.hearingConfig.expectedSpeakers) || [];
    document.querySelectorAll("[data-vtexp]").forEach(function (b) {
      b.onclick = function () {
        var e = expected[parseInt(b.getAttribute("data-vtexp"), 10)];
        if (e) labelVoice(cluster, e.speaker, e.name || (el("vtName") ? el("vtName").value.trim() : ""));
      };
    });
    document.querySelectorAll("[data-vtparty]").forEach(function (b) {
      b.onclick = function () {
        labelVoice(cluster, b.getAttribute("data-vtparty"), el("vtName") ? el("vtName").value.trim() : "");
      };
    });
    var c = el("vtCancel"); if (c) c.onclick = function () { state.taggingVoice = null; renderVoicesStrip(); };
  }
  // Ask the LLM who it thinks said this line. If it disagrees with your toggle, flag it "LLM?" (you decide),
  // and if it thinks the line is plaintiff/court, still search rebuttals so you don't miss one after a mistag.
  function maybeLlmSpeaker(seg) {
    var m = MATCH();
    if (!m.llmSpeakerCheck || !state.llmOnline || !window.LLM || !LLM.classifySpeaker) return;
    if (!seg || (seg.text || "").length < (m.llmSpeakerMinChars || 24)) return;
    var id = seg.id, text = seg.text;
    LLM.classifySpeaker(text).then(function (res) {
      if (!res || res.confidence < (m.llmSpeakerMinConf || 0.6)) return;
      var cur = TLOG.all().filter(function (x) { return x.id === id; })[0];
      if (!cur) return;
      fuseTextVerdict(cur, res);
      if ((res.speaker === "plaintiff" || res.speaker === "court") && isOpposingSpeaker(res.speaker)) autoMatch(cur.text, res.speaker, cur);
    }).catch(function () {});
  }
  // Acoustic + text fusion (plan section 7.3): the voice knows WHO is talking, the wording knows
  // the ROLE. Rules, in order:
  //   both signals agree against the current tag -> apply in assist/auto (and confirm-train),
  //     strengthen the violet chip in shadow;
  //   signals disagree with each other -> the voice chip wins for identity, no dueling amber chip;
  //   text alone -> auto mode applies it (that is what tags brand-new voices hands-free),
  //     other modes show the amber chip exactly as before.
  function fuseTextVerdict(cur, res) {
    var sc = CONFIG.speakerId || {};
    var id = cur.id;
    var applyModes = sc.mode === "assist" || sc.mode === "auto";
    var voiceSays = cur.voiceSpeaker || null;   // pending violet suggestion, if any
    if (res.speaker === cur.speaker) return;    // text agrees with the tag: nothing to do
    if (voiceSays && res.speaker === voiceSays) {
      if (applyModes) {
        TLOG.update(id, { speaker: voiceSays, name: cur.voiceName || cur.name || "",
                          voiceSpeaker: null, llmSpeaker: null });
        confirmVoice(cur, voiceSays);
        dbg("fusion: voice+text agree, applied", cur.speaker, "->", voiceSays);
        if (isOpposingSpeaker(voiceSays)) autoMatch(cur.text, voiceSays, cur);
      } else {
        TLOG.update(id, { voiceLlmAgree: true });   // shadow: the chip gets a second witness
        dbg("fusion: voice+text agree (shadow chip strengthened)");
      }
    } else if (voiceSays) {
      dbg("fusion: text says", res.speaker, "but voice says", voiceSays, "- voice chip wins");
    } else if (sc.mode === "auto" && !(cur.voice && cur.voice.applied)) {
      TLOG.update(id, { speaker: res.speaker, llmSpeaker: null });
      confirmVoice(cur, res.speaker);   // teach the voice profile from the text verdict too
      dbg("fusion: auto mode, text applied", cur.speaker, "->", res.speaker, res.confidence);
    } else {
      TLOG.update(id, { llmSpeaker: res.speaker, llmConf: res.confidence });
      dbg("llm speaker", cur.speaker, "->", res.speaker, res.confidence);
    }
    if (state.binderSide === "live") renderTranscripts();
  }

  // Merge into the previous same-speaker line if it was very recent; else start a new line.
  function mergeOrAdd(speaker, name, text) {
    var segs = TLOG.byDate(TLOG.today());
    var last = segs[segs.length - 1];
    if (last && last.speaker === speaker && (last.name || "") === (name || "") &&
        (Date.now() - Date.parse(last.ts)) < (MATCH().mergeGapMs || 8000)) {
      TLOG.update(last.id, { text: (last.text + " " + text).replace(/\s+/g, " ").trim() });
      return last;
    }
    // copilot-core's TLOG.add(role, text, extra) treats a truthy 3rd arg as an object to merge in
    // (Object.keys on a bare string would iterate its character indices and corrupt the segment),
    // so a plain name string must be wrapped -- this app's original transcript.js took name as a
    // plain 3rd argument directly.
    return TLOG.add(speaker, text, name ? { name: name } : undefined);
  }

  // Match against the last windowMs of this speaker's speech, so a phrase split across lines still hits.
  function matchRolling(speaker, seg) {
    var buf = state.matchWindow[speaker] || (state.matchWindow[speaker] = []);
    buf.push({ text: seg.text.slice(-400), ts: Date.now() });
    var cutoff = Date.now() - (MATCH().windowMs || 15000);
    state.matchWindow[speaker] = buf = buf.filter(function (x) { return x.ts >= cutoff; });
    var windowText = buf.map(function (x) { return x.text; }).join(" ").slice(-600);
    if (windowText.length < minChars()) return;
    autoMatch(windowText, speaker, seg);
  }

  function speakerLabel(id) {
    var s = CONFIG.speakers.filter(function (x) { return x.id === id; })[0];
    return s ? s.label : id;
  }
  // Fire EVERY relevant rebuttal/objection, not just the top one (a whole opening hits several).
  function autoMatch(text, speaker, seg) {
    // Central substance gate: manual entry, the "-> match" button, and the LLM speaker recheck all reach
    // matching through here. A bare token or party label (e.g. "plaintiff") carries no argument, so skip it.
    if (!hasMatchableSubstance(text)) { dbg("skip low-signal input, no match:", text); return; }
    matchWithLLM(text, speaker).then(function (matches) {
      dbg("match", speaker, "->", matches ? matches.map(function (m) { return m.id; }).join(",") : "none");
      if (!matches || !matches.length) return;
      var fired = [], now = Date.now(), cd = MATCH().cooldownMs || 15000;
      var reCd = (RCFG().redropCooldownMs != null) ? RCFG().redropCooldownMs : 90000;
      matches.forEach(function (m) {
        if (!m || !m.id || state.handled[m.id]) return;                 // handled = done, skip
        state.matchCount[m.id] = (state.matchCount[m.id] || 0) + 1;               // how often it comes up
        if (state.lastFired[m.id] && (now - state.lastFired[m.id]) < cd) return;  // cooldown per item
        // The full-transcript review just pruned this one as unsupported. Don't let the next 9s window
        // put it straight back (that is the "keeps coming back, trim it by hand" loop).
        if (state.deckDropped[m.id] && (now - state.deckDropped[m.id]) < reCd) { dbg("skip re-trigger (pruned)", m.id); return; }
        state.lastFired[m.id] = now;
        triggerItem(m.id);
        fired.push(m);
      });
      if (!fired.length) return;
      state.matchEpoch++;                  // new matches to QA -> the review pass may run again
      if (seg) {
        var prev = seg.matchedId ? String(seg.matchedId).split(",") : [];
        var ids = prev.concat(fired.map(function (m) { return m.id; }));
        TLOG.update(seg.id, { matchedId: ids.filter(function (v, i) { return ids.indexOf(v) === i; }).join(",") });
        if (state.binderSide === "live") renderTranscripts();
      }
      fired.forEach(function (m) {
        var tabs = m.item && m.item.tabs && m.item.tabs.length ? " (" + m.item.tabs.join(", ") + ")" : "";
        if (m.kind === "Objection") notify("⚠ OBJECT NOW: " + m.id + " → On deck" + tabs);   // raise contemporaneously
        else notify(m.kind + " " + m.id + " → On deck" + tabs);
      });
      flashDeckCard(fired[0].id);
      scheduleReconcile();   // QA the new deck against the WHOLE transcript right away, not 12s later
    });
  }
  function flashDeckCard(id) {
    if (state.currentLeft !== "ondeck") return;
    var card = el("deck-" + id);
    if (card) { card.style.boxShadow = "0 0 0 3px var(--accent-soft)"; setTimeout(function () { card.style.boxShadow = ""; }, 900); card.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  }
  // ---------- keyword matching ----------
  // Naive substring matching (indexOf) was over-broad and queued points nobody argued: "cured" matched
  // inside "secured", "holder" inside "stakeholder", "ucc" inside "succumb", and ONE generic word
  // ("overbroad", "disproportionate", "final judgment") was enough to fire a whole rebuttal. Two guards:
  //   1) WORD BOUNDARIES. A keyword must begin at a word boundary. Spaces and hyphens inside a phrase are
  //      interchangeable, so "one day" matches "one-day". A keyword whose last token is >= 4 letters may
  //      also match its inflections ("waive" -> "waived", "pool" -> "pooling", "preclu" -> "preclusive");
  //      shorter tokens must match a whole word, so "sec" never fires on "securitization".
  //   2) MATCH STRENGTH. Each hit is weighted - a multi-word phrase or a keyword containing a number
  //      (statute/dollar figure) = 2, a bare single word = 1 - and an item must reach minMatchScore
  //      (default 2): one distinctive phrase, or two independent single words. Overlapping hits count once,
  //      so listing "waive" and "waived" can no longer double-score the same word.
  // Profiles whose keyword lists are still mostly single words can opt out with
  // hearingConfig.minMatchScore = 1 (the July-14 MSJ profile does).
  var kwRxCache = {};
  function rxEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function keywordRx(k) {
    if (kwRxCache.hasOwnProperty(k)) return kwRxCache[k];
    var toks = String(k).toLowerCase().trim().split(/[\s\-_]+/).filter(Boolean);
    if (!toks.length) return (kwRxCache[k] = null);
    var last = toks[toks.length - 1];
    var openEnd = last.length >= 4 && /[a-z]$/.test(last);     // long enough to allow an inflected ending
    var body = toks.map(rxEsc).join("[\\s\\-_]*");
    return (kwRxCache[k] = new RegExp("(^|[^a-z0-9])(" + body + ")" + (openEnd ? "" : "(?![a-z0-9])"), "i"));
  }
  function keywordWeight(k) {
    var toks = String(k).trim().split(/[\s\-_]+/).filter(Boolean);
    if (toks.length > 1) return 2;    // distinctive phrase: strong enough to stand alone
    if (/[0-9]/.test(k)) return 2;    // statute number / dollar figure, e.g. "1.280", "89,668"
    return 1;                         // bare word: needs a second, independent hit
  }
  // Total weight of NON-OVERLAPPING keyword hits, strongest first.
  function keywordScore(hay, keywords) {
    var spans = [];
    (keywords || []).forEach(function (k) {
      var rx = keywordRx(k); if (!rx) return;
      var m = rx.exec(hay); if (!m) return;
      var start = m.index + (m[1] ? m[1].length : 0);
      spans.push({ s: start, e: start + m[2].length, w: keywordWeight(k), k: k });
    });
    spans.sort(function (a, b) { return (b.w - a.w) || (a.s - b.s); });
    var taken = [], score = 0, hits = [];
    spans.forEach(function (sp) {
      for (var i = 0; i < taken.length; i++) if (sp.s < taken[i].e && taken[i].s < sp.e) return;  // same words
      taken.push(sp); score += sp.w; hits.push(sp.k);
    });
    return { score: score, hits: hits };
  }
  function minMatchScore() {
    var hc = (C && C.hearingConfig) || {};
    if (hc.minMatchScore != null) return hc.minMatchScore;      // per-hearing override
    if (MATCH().minMatchScore != null) return MATCH().minMatchScore;
    return 2;
  }
  // Offline keyword matcher -> [{id, kind, item, score, hits}].
  function matchOfflineArr(text) {
    if (!hasMatchableSubstance(text)) return [];   // no real signal -> no keyword amplification
    var hay = String(text).toLowerCase(), min = minMatchScore();
    var pool = C.rebuttals.map(function (r) { return { item: r, kind: "Rebuttal" }; })
      .concat(C.objections.map(function (o) { return { item: o, kind: "Objection" }; }));
    var scored = pool.map(function (p) {
      var r = keywordScore(hay, p.item.keywords);
      return { id: p.item.id, kind: p.kind, item: p.item, score: r.score, hits: r.hits };
    }).filter(function (s) { return s.score >= min; });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 6);   // a full opening can hit several, but keep On-deck readable
  }
  // UNION the LLM's semantic matches with the keyword matches. The LLM can under-select on a long
  // multi-point argument (it once missed the dispositive standing and deficiency counters), so the
  // curated keywords act as a safety net rather than a mere fallback. LLM order first (semantic
  // priority), then keyword hits it didn't catch, capped so On-deck stays readable.
  function matchWithLLM(text, speaker) {
    var kw = matchOfflineArr(text);   // [{id,kind,item,score}], already sorted by score
    if (!state.llmOnline || !window.LLM) return Promise.resolve(kw);
    var items = C.rebuttals.map(function (r) { return { id: r.id, kind: "Rebuttal", heard: r.heard }; })
      .concat(C.objections.map(function (o) { return { id: o.id, kind: "Objection", heard: o.trigger }; }));
    return LLM.match(text, speaker, items).then(function (res) {
      var kwScore = {}; kw.forEach(function (m) { kwScore[m.id] = m.score; });
      var llm = (res && res.length) ? res.filter(function (m) { return m && m.id && findItem(m.id); }) : [];
      // Confidence order, so an uncorroborated LLM guess never pushes out hard keyword evidence:
      //   1 both agree  2 strong keyword phrase evidence  3 LLM only  4 remaining keyword hits.
      var tiers = [[], [], [], []], seen = {};
      llm.forEach(function (m) {
        if (seen[m.id]) return; seen[m.id] = 1;
        tiers[kwScore[m.id] ? 0 : 2].push({ id: m.id, kind: m.kind, item: findItem(m.id) });
      });
      kw.forEach(function (m) {
        if (seen[m.id]) return; seen[m.id] = 1;
        tiers[m.score >= 4 ? 1 : 3].push({ id: m.id, kind: m.kind, item: m.item });
      });
      return tiers[0].concat(tiers[1], tiers[2], tiers[3]).slice(0, 6);
    }).catch(function () { return kw; });
  }
  function renderNotifier() {
    var n = el("notifier"); if (!n) return;
    var list = notifier ? notifier.list() : [];
    if (!list.length) { n.innerHTML = "<div class='note'>No detections yet.</div>"; return; }
    n.innerHTML = list.map(function (x) {
      return "<div class='notif'><span class='nt'>" + x.t + "</span> " + escapeHtml(x.msg) + "</div>";
    }).join("");
  }

  function itemPriority(id) { return (C.priority && C.priority[id]) || "med"; }
  // Deterministic strength-first ordering (high -> med -> low), stable within a tier. Always applied so the
  // strongest defenses sit on top even with no LLM; the LLM sort then refines for coherence.
  function prioritySort() {
    var rank = { high: 0, med: 1, low: 2 };
    var arr = state.triggered.map(function (id, i) { return { id: id, i: i }; });
    arr.sort(function (a, b) { return (rank[itemPriority(a.id)] - rank[itemPriority(b.id)]) || (a.i - b.i); });
    state.triggered = arr.map(function (o) { return o.id; });
  }

  // On-deck LLM ordering (debounced), plus a manual trigger.
  var sortTimer = null;
  function scheduleSort() {
    prioritySort();                                        // strongest-first immediately (works offline too)
    refreshTrackers();
    if (!(CONFIG.ui.autoSortOnDeck && state.llmOnline)) return;
    clearTimeout(sortTimer);
    sortTimer = setTimeout(runSort, 1200);
  }
  function runSort() {
    var ids = onDeckIds(); if (ids.length < 2 || !window.LLM) return;
    var items = ids.map(function (id) {
      var it = findItem(id) || {};
      return { id: id, heard: it.heard || it.trigger, script: it.script, priority: itemPriority(id), count: state.matchCount[id] || 1 };
    });
    LLM.sortOnDeck(items).then(function (order) {
      if (!order) return;
      var next = order.filter(function (id) { return state.triggered.indexOf(id) >= 0 && !state.handled[id]; });
      state.triggered.forEach(function (id) { if (!state.handled[id] && next.indexOf(id) === -1) next.push(id); });
      state.triggered = next;
      refreshTrackers();
      notify("On deck reordered by priority");
    }).catch(function () {});
  }

  // ---------- whole-transcript reconciliation ----------
  // Per-line matching is myopic: it fires On-deck items off one 9s window, so garbled speech or a stray
  // keyword queues spurious rebuttals. This pass periodically hands the LLM the WHOLE opposing-side
  // transcript + the current On-deck list + the full catalog, and rebuilds On-deck with real context:
  // it drops noise-triggered items, adds clearly-warranted ones, reorders strongest-first, and tags each
  // with a short reason. Runs only when the transcript or On-deck actually changed (near-free otherwise).
  function RCFG() { return CONFIG.reconcile || { enabled: false, everyMs: 12000 }; }
  // What the OTHER side (plaintiff, court, other) has said today — the only speech that warrants a rebuttal.
  // Our own mic ("me"/our party) never triggers rebuttals, so it is excluded. Bounded to the last ~5000 chars.
  function opposingTranscript() {
    var mine = { me: 1 }; mine[state.myParty] = 1;
    var lines = TLOG.byDate(TLOG.today())
      .filter(function (s) { return !mine[s.speaker] && (s.text || "").trim(); })
      .map(function (s) { return speakerLabel(s.speaker) + ": " + s.text.trim(); });
    return lines.join("\n").slice(-5000);
  }
  // Signature that decides when a fresh pass is worth running. It is the transcript (exact content, so a
  // manual entry, an inline TEXT EDIT of the same length, or a speaker reassignment all count) plus a
  // counter of how many times live matching has fired.
  // It deliberately does NOT include the on-deck list. When it did, the pass re-ran on its own edits: each
  // run re-rolled the model's judgment on an unchanged transcript, and the deck oscillated (observed live:
  // R-2/R-3/R-4/O-3 flipping in and out, and O-7 - the scope concession that won the mock - eventually
  // dropped). Nothing new is learned by re-judging the same words, so a pass now runs only when there is
  // new speech or a new match to review, and the deck converges.
  function reconcileSig() { return "m" + state.matchEpoch + "||SIG||" + opposingTranscript(); }
  // Keyword evidence for an item against what the other side has ACTUALLY said so far.
  function transcriptEvidence(ids, hay) {
    hay = (hay != null) ? hay : opposingTranscript().toLowerCase();
    var out = {};
    ids.forEach(function (id) {
      var it = findItem(id);
      out[id] = it ? keywordScore(hay, it.keywords) : { score: 0, hits: [] };
    });
    return out;
  }
  // Per-task model override for the reconcile pass (stronger, larger-context model + provider order).
  function reconcileOpts() {
    var rc = RCFG();
    return {
      providers: rc.providers,
      models: { ollama: rc.ollama && rc.ollama.model, openai: rc.openai && rc.openai.model, groq: rc.groq && rc.groq.model },
      numCtx: (rc.ollama && rc.ollama.num_ctx) || rc.num_ctx
    };
  }
  function maybeReconcile() {
    var rc = RCFG();
    if (!rc.enabled || state.reconcileBusy) return;
    if (!state.llmOnline || !window.LLM || !LLM.reconcile) return;
    var txt = opposingTranscript();
    if (txt.length < 40) return;                         // need real context before second-guessing matches
    var sig = reconcileSig();
    if (sig === state.lastReconcileSig) return;          // nothing changed since the last pass
    state.lastReconcileSig = sig;                        // mark attempted (don't hammer on an unchanged view)
    runReconcile(txt);
  }
  // Run the QA pass as soon as a match lands (debounced), instead of waiting for the next interval tick.
  // Live, that means the false positives are pruned while counsel is still talking, not a beat later.
  var reconcileTimer = null;
  function scheduleReconcile(delay) {
    if (!RCFG().enabled) return;
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(maybeReconcile, delay || 1500);
  }
  function maxPoints() { var n = RCFG().maxPoints; return (n == null) ? 5 : n; }
  function maxObjections() { var n = RCFG().maxObjections; return (n == null) ? 3 : n; }
  function runReconcile(txt) {
    state.reconcileBusy = true;
    // Show the model the transcript phrases that actually triggered each on-deck item. Without them it
    // called squarely-argued points "never argued" and pulled them off the deck.
    var ev = transcriptEvidence(onDeckIds(), txt.toLowerCase());
    var onDeck = onDeckIds().map(function (id) {
      var it = findItem(id) || {};
      return { id: id, kind: id.charAt(0) === "O" ? "Objection" : "Rebuttal", heard: it.heard || it.trigger,
               priority: itemPriority(id), evidence: (ev[id] && ev[id].hits) || [] };
    });
    var catalog = C.rebuttals.map(function (r) { return { id: r.id, kind: "Rebuttal", heard: r.heard, priority: itemPriority(r.id) }; })
      .concat(C.objections.map(function (o) { return { id: o.id, kind: "Objection", heard: o.trigger, priority: itemPriority(o.id) }; }));
    var opts = reconcileOpts();
    opts.maxPoints = maxPoints(); opts.maxObjections = maxObjections();
    dbg("reconcile: transcript", txt.length, "chars; on-deck", onDeck.map(function (i) { return i.id; }).join(",") || "(none)",
        "; model", (opts.models && opts.models.ollama) || "(default)");
    LLM.reconcile(txt, onDeck, catalog, opts).then(function (res) {
      state.reconcileBusy = false;
      dbg("reconcile result:", res ? JSON.stringify(res) : "null (no change)", "| answered by", LLM.last && LLM.last() ? (LLM.last().provider + "/" + LLM.last().model) : "?");
      if (res) applyReconcile(res);
    }).catch(function () { state.reconcileBusy = false; });
  }
  // res = { remove:[{id,reason}], add:[{id,reason}] } — a DELTA. Anything not named is KEPT, so an
  // under-answering model can only ever leave the deck as-is; it can never wipe warranted items.
  // Removals are real: an item the transcript does not actually support is pulled off the deck and gets a
  // short re-trigger cooldown, so the reader never has to hand-trim the list at the podium.
  function applyReconcile(res) {
    if (!res) return;
    var before = onDeckIds();
    // Evidence floor. An item the other side's own words support this strongly is NOT dropped on a model's
    // say-so: in testing the pass tried to pull O-7 ("never argued") while the transcript literally said
    // "nationwide securitization ... SEC filings ... facially overbroad". Losing that at the podium is far
    // worse than carrying one extra point.
    var protect = (RCFG().protectScore == null) ? 4 : RCFG().protectScore;
    var ev = transcriptEvidence(before);
    var removeSet = {}, removeWhy = {}, held = [];
    (res.remove || []).forEach(function (r) {
      if (!r || !r.id) return;
      if (protect > 0 && ev[r.id] && ev[r.id].score >= protect) { held.push(r.id); return; }
      removeSet[r.id] = true; removeWhy[r.id] = r.reason ? String(r.reason).slice(0, 60) : "";
    });
    if (held.length) dbg("reconcile: held (strong transcript evidence)", held.join(","));
    var removed = before.filter(function (id) { return removeSet[id]; });
    var finalIds = before.filter(function (id) { return !removeSet[id]; });
    // carry forward reasons for items that survive; drop reasons for removed ones
    var reasons = {};
    finalIds.forEach(function (id) { if (state.deckReason[id]) reasons[id] = state.deckReason[id]; });
    var added = [], now = Date.now();
    var reCd = (RCFG().redropCooldownMs != null) ? RCFG().redropCooldownMs : 90000;
    (res.add || []).forEach(function (r) {
      if (!r || !r.id) return;
      if (state.handled[r.id] || state.suppressed[r.id]) return;   // don't resurrect read/pulled items
      // ...and don't resurrect what an earlier review just pruned. Re-adding it is how the deck used to
      // flip-flop between passes.
      if (state.deckDropped[r.id] && (now - state.deckDropped[r.id]) < reCd) return;
      if (finalIds.indexOf(r.id) !== -1) return;
      finalIds.push(r.id); added.push(r.id);
      delete state.deckDropped[r.id];        // the review itself put it back: clear the prune cooldown
      state.lastFired[r.id] = now; state.matchCount[r.id] = state.matchCount[r.id] || 1;
      if (r.reason) reasons[r.id] = String(r.reason).slice(0, 120);
    });
    // Ceiling backstop. One spoken response can carry ~4-5 developed points; past that the strongest get
    // diluted. If the model left more than the cap, trim the weakest tail (priority order, then arrival)
    // and say so. Items trimmed here are NOT suppressed: a later pass can bring one back if it earns it.
    var trimmed = [];
    finalIds = strengthOrder(finalIds);
    ["R", "O"].forEach(function (kindChar) {
      var cap = kindChar === "O" ? maxObjections() : maxPoints();
      if (cap <= 0) return;
      var ofKind = finalIds.filter(function (id) { return (id.charAt(0) === "O") === (kindChar === "O"); });
      ofKind.slice(cap).forEach(function (id) { trimmed.push(id); });
    });
    if (trimmed.length) finalIds = finalIds.filter(function (id) { return trimmed.indexOf(id) === -1; });
    removed.concat(trimmed).forEach(function (id) { state.deckDropped[id] = now; delete reasons[id]; });
    if (!added.length && !removed.length && !trimmed.length) { state.deckReason = reasons; return; }
    state.triggered = finalIds.slice();     // handled ids are already out of `triggered`
    state.deckReason = reasons;
    state.lastReconcileAt = now;
    prioritySort();                          // keep strongest-first after adds/removes
    refreshTrackers();
    var parts = [];
    if (removed.length) parts.push("removed " + removed.map(function (id) {
      return id + (removeWhy[id] ? " (" + removeWhy[id] + ")" : "");
    }).join(", "));
    if (trimmed.length) parts.push("trimmed to fit one response: " + trimmed.join(", "));
    if (added.length) parts.push("added " + added.join(", "));
    if (held.length) parts.push("kept " + held.join(", ") + " (their words are in the transcript)");
    notify("On deck auto-tuned (full-transcript review): " + parts.join("; "));
  }
  // Strongest-first order used by the ceiling backstop: priority tier, then how often it was detected,
  // then current on-deck position. Keeps the cap from cutting a high-priority point before a low one.
  function strengthOrder(ids) {
    var rank = { high: 0, med: 1, low: 2 };
    return ids.map(function (id, i) { return { id: id, i: i }; }).sort(function (a, b) {
      return (rank[itemPriority(a.id)] - rank[itemPriority(b.id)]) ||
             ((state.matchCount[b.id] || 0) - (state.matchCount[a.id] || 0)) || (a.i - b.i);
    }).map(function (o) { return o.id; });
  }

  // ---------- view switching ----------
  var LEFT_RENDERERS = { openings: renderOpenings, rebuttals: renderRebuttals, objections: renderObjections, ondeck: renderOnDeck, rebuttalscript: renderRebuttalScript, script: renderFullScript };
  function ensureLeftView(view) {
    var lb = el("left-body");
    if (lb) state.leftScroll[state.currentLeft] = lb.scrollTop;   // remember where we were
    state.currentLeft = view;
    document.querySelectorAll("#left-tabs button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === view);
    });
    LEFT_RENDERERS[view]();
    var lb2 = el("left-body"); if (lb2) lb2.scrollTop = state.leftScroll[view] || 0;   // restore
    updateOnDeckBadge();
  }

  // ---------- utilities ----------
  function copyText(t, btn) {
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () {
      var o = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = o; }, 1000);
    });
  }
  function loadingOrError() {
    return "<div class='banner'>Could not load the script markdown. Start the app with " +
      "<code>launch.command</code> (or a local server at the repo root) so it can read the case files. See the README.</div>";
  }

  // ---------- plugin API: the live audio+transcript module calls these ----------
  window.HearingCopilot = {
    trigger: triggerItem,                       // queue a rebuttal/objection to On deck
    untrigger: untriggerItem,
    markHandled: function (id) { setHandled(id, true); },  // detected it was read
    markRead: function (id) { setHandled(id, true); },
    unhandle: function (id) { setHandled(id, false); },
    reset: resetTracking,
    openTab: openTabByRef,
    setLive: function (on) { setLive(!!on); },
    setRecordMe: function (on) { setRecordMe(!!on); },
    setSpeaker: function (id) { state.speaker = id; renderCopilot(); },
    logSegment: function (speaker, text) { var sp = speaker || state.speaker; var seg = TLOG.add(sp, text); if (state.binderSide === "live") renderTranscripts(); if (isOpposingSpeaker(sp)) autoMatch(text, sp, seg); return seg; },
    ingest: onFinalSegment,                     // full ASR-path entry: (text, role, startTs, fullMatch, voiceVerdict)
    sortOnDeck: function () { runSort(); },
    getState: function () { var tl = state.speakerTimeline; return { triggered: state.triggered.slice(), handled: Object.keys(state.handled), speaker: state.speaker, speakerSetAt: tl.length ? tl[tl.length - 1].ts : 0, live: state.live, llmOnline: state.llmOnline }; },
    items: function () {
      return C.rebuttals.map(function (r) { return { id: r.id, kind: "Rebuttal", heard: r.heard, keywords: r.keywords }; })
        .concat(C.objections.map(function (o) { return { id: o.id, kind: "Objection", heard: o.trigger, keywords: o.keywords }; }));
    }
  };

  // ---------- boot ----------
  function loadDocs() {
    return fetchDoc(C.docPaths.finalScript)
      .then(function (t) { state.docCache.finalScript = t; })
      .catch(function () { state.docCache.finalScript = ""; });
  }
  function init() {
    document.querySelectorAll("#left-tabs button").forEach(function (b) {
      b.onclick = function () { ensureLeftView(b.getAttribute("data-view")); };
    });
    document.querySelectorAll("#binder-tabs button").forEach(function (b) {
      b.onclick = function () { setBinderSide(b.getAttribute("data-side")); };
    });
    el("reload").onclick = function () { loadDocs().then(function () { ensureLeftView("openings"); }); };
    document.addEventListener("keydown", onSpeakerHotkey);   // 1-4 select the incoming speaker
    try { state.myParty = localStorage.getItem("hc_myparty") || "defendant"; state.myName = localStorage.getItem("hc_myname") || ""; } catch (e) {}
    try { var hh = JSON.parse(localStorage.getItem("hc_hearing")); if (hh) { CONFIG.hearing = CONFIG.hearing || {}; ["totalMinutes", "sides", "motions", "wpm"].forEach(function (k) { if (hh[k]) CONFIG.hearing[k] = hh[k]; }); } } catch (e) {}
    setInterval(function () { if (state.copilotView === "timing" && el("timing-live")) el("timing-live").innerHTML = timingLiveHtml(hearingStats()); }, 1000);
    setInterval(maybeReconcile, Math.max(5000, (RCFG().everyMs) || 12000));   // whole-transcript On-deck correction
    document.querySelectorAll("#copilot-tabbar button[data-cop]").forEach(function (b) {
      b.onclick = function () {
        state.copilotView = b.getAttribute("data-cop");
        var p = document.getElementById("copilot-panel");
        if (p && p.classList.contains("collapsed")) { var cb = el("copilot-collapse"); if (cb) cb.click(); }  // expand when switching tabs
        renderCopilot();
      };
    });
    if (window.TLOG) { TLOG.load(); state.transcriptDate = TLOG.today(); loadTranscriptsFromDisk(); }
    renderBinderList();
    renderCopilot();
    updateOnDeckBadge();
    pingLLM();
    loadDocs().then(function () { ensureLeftView("openings"); });
  }
  // Load the day's durable transcript from the log writer so refreshes / new tabs show it
  // even after localStorage was cleared. Falls back silently to whatever localStorage had.
  function loadTranscriptsFromDisk() {
    var c = (CONFIG.logServer) || {};
    if (!c.enabled || !c.url || !window.TLOG || !TLOG.hydrate) return;
    var base = c.url.replace(/\/log$/, "");
    fetch(base + "/log?date=" + TLOG.today())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.segments && j.segments.length) {
          TLOG.hydrate(j.segments);
          if (state.binderSide === "live") renderTranscripts();
        }
      }).catch(function () {});
  }
  function pingLLM() {
    if (!window.LLM) { state.llmOnline = false; updateCoStatus(); return; }
    LLM.available().then(function (ok) { state.llmOnline = ok; updateCoStatus(); });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
