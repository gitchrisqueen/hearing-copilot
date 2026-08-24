// Hearing-copilot LLM tasks. The provider-failover transport (chatJSON/providerList/sequence/
// withTimeout/available) lives in copilot-core's llm-transport.js, loaded before this file, which
// already sets window.LLM. This file ADDS this app's domain prompts onto that same object -- it
// never replaces it, since replacing window.LLM here would silently delete the transport core
// just installed.
(function (global) {
  var LLM = global.LLM = global.LLM || {};
  function cfg() { return (global.CONFIG && global.CONFIG.llm) || {}; }
  function chatJSON(sys, usr, opts) { return LLM.chatJSON(sys, usr, opts); }
  function providerList() { return LLM.providerList(); }
  function sequence(list, attempt) { return LLM.sequence(list, attempt); }
  function withTimeout(ms) { return LLM.withTimeout(ms); }
  function isCloudName(name) { return name === "groq" || name === "openai" || name === "ollamacloud"; }
  function confOf(name) { var c = cfg(); return c[name] || {}; }
  var lastUsed = null;
  function markUsed(name, model) { try { lastUsed = { provider: name, model: model || confOf(name).model, at: Date.now() }; } catch (e) {} }
  // The active hearing profile's overrides (window.CASE.hearingConfig), read fresh on every call
  // so switching hearings mid-session (a relaunch) always uses the current profile.
  function HC() { return (global.CASE && global.CASE.hearingConfig) || {}; }

  // Bare party labels / single words carry no argument. Guard so trivial input never reaches the model
  // (which is instructed to match aggressively and would otherwise return several ids for one word).
  var LOW_SIGNAL_MATCH = { plaintiff: 1, plaintiffs: 1, defendant: 1, defendants: 1, court: 1, judge: 1,
    objection: 1, objections: 1, counsel: 1, counselor: 1, honor: 1, motion: 1, hearing: 1, argument: 1 };
  function lowSignal(text) {
    var t = (text || "").trim();
    if (t.length < 12) return true;                                   // too short to hold an argument
    var words = t.split(/\s+/).filter(Boolean);
    if (words.length < 3) return true;                                // a token or two, not an assertion
    var bare = t.toLowerCase().replace(/[^a-z]/g, "");
    if (LOW_SIGNAL_MATCH[bare]) return true;                          // e.g. just "plaintiff" / "objection"
    return false;
  }

  // Normalized text compare used to verify the model's evidence quotes against what was actually said.
  function normQuote(s) { return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
  // A match is GROUNDED only if the model can point at words the speaker actually used - the guard against
  // topic-drift matches. Models paraphrase at the edges of a quote, so requiring the WHOLE quote verbatim
  // threw away good matches in testing; instead any 3 consecutive words of the quote must appear verbatim
  // in the text. A wholly invented quote has no such run.
  function quoteSupported(quote, text) {
    var q = normQuote(quote).split(" ").filter(Boolean);
    if (q.length < 3) return false;
    var hay = normQuote(text);
    for (var i = 0; i + 3 <= q.length; i++) {
      if (hay.indexOf(q.slice(i, i + 3).join(" ")) !== -1) return true;
    }
    return false;
  }

  function match(text, speaker, items) {
    if (lowSignal(text)) return Promise.resolve(null);   // no argument in the input -> no matches
    var sys = "You are a courtroom copilot for a pro se litigant at a civil motion hearing. " +
      "Given what the named speaker said, choose the prepared rebuttals/objections that answer arguments the " +
      "speaker ACTUALLY MADE (a full argument can hit several distinct ones). " +
      "PRECISION MATTERS MORE THAN RECALL: every match you return will be queued for the litigant to read " +
      "aloud at the podium, so a wrong one costs him credibility and time. " +
      "- Match an item ONLY if the speaker advanced the argument in that item's trigger. Sharing a topic, a " +
      "word, or a legal area is NOT enough. If the speaker never invoked a doctrine or framework, do not queue " +
      "the item about it.\n" +
      "- For EACH match you MUST return \"quote\": a short span (3-15 words) copied EXACTLY, word for word, from " +
      "SAID, showing the speaker making that argument. If you cannot copy such a span, DO NOT return the match.\n" +
      "- If two items answer the same assertion, return only the more specific one.\n" +
      "- If the input contains no actual legal argument, assertion, or factual claim (a name, a party label like " +
      "'plaintiff', a greeting, a stray word), return {\"matches\":[]}.\n" +
      "- The speaker's AFFIRMATIVE assertions are triggers too: when they claim a fact is 'undisputed', 'not " +
      "contested', 'established', 'conclusive', or 'sufficient', match the prepared item that CONTESTS or shifts " +
      "the burden on that point - do not skip it just because the speaker framed it as settled.\n" +
      "Respond ONLY as JSON: {\"matches\":[{\"id\":\"R-3\",\"quote\":\"exact words from SAID\"}]} — at most 5, " +
      "most important first. Fewer, correct matches beat more.";
    var list = items.map(function (i) { return i.id + " [" + i.kind + "] trigger: " + i.heard; }).join("\n");
    var usr = "SPEAKER: " + speaker + "\nSAID: " + text + "\n\nPREPARED ITEMS:\n" + list;
    return chatJSON(sys, usr).then(function (o) {
      if (!o || !o.matches || !o.matches.length) return null;
      var byId = {}; items.forEach(function (i) { byId[i.id] = i.kind; });
      var valid = o.matches.filter(function (m) { return m && byId[m.id]; });
      var quoted = valid.filter(function (m) { return m.quote && String(m.quote).trim(); });
      if (quoted.length) {
        var grounded = quoted.filter(function (m) { return quoteSupported(m.quote, text); });
        try {
          var dropped = valid.filter(function (m) { return grounded.indexOf(m) === -1; }).map(function (m) { return m.id; });
          if (dropped.length && global.console) console.log("[copilot] match: dropped ungrounded", dropped.join(","));
        } catch (e) {}
        valid = grounded;
      }
      return valid.slice(0, 5).map(function (m) { return { id: m.id, kind: byId[m.id] }; });
    });
  }

  function sortOnDeck(items) {
    if (items.length < 2) return Promise.resolve(items.map(function (i) { return i.id; }));
    var sys = "You order a pro se defendant's on-deck oral-argument points for a summary-judgment hearing. " +
      "Rank by DEFENSE STRENGTH first: dispositive, case-winning points (the burden of proof, standing, " +
      "correcting a mis-cited authority, a key affidavit that is contradicted) go at the top; minor or purely " +
      "procedural points go last. Each item has a strength tag [high/med/low] and a detect count (xN = how many " +
      "times it came up). Weight STRENGTH heavily; do NOT promote a weak/low point just because its count is high " +
      "(that is bait). After strength, arrange for coherence so the points read as one flowing argument. Keep " +
      "EVERY id exactly once. Respond ONLY as JSON: {\"order\":[\"id\",...]}.";
    var list = items.map(function (i) {
      return i.id + " [" + (i.priority || "med") + ", x" + (i.count || 1) + "]: " + (i.heard || "") + " || " + (i.script || "").slice(0, 120);
    }).join("\n");
    return chatJSON(sys, "POINTS:\n" + list).then(function (o) {
      if (!o || !Array.isArray(o.order)) return null;
      var valid = {}; items.forEach(function (i) { valid[i.id] = true; });
      var ordered = o.order.filter(function (id) { return valid[id]; });
      items.forEach(function (i) { if (ordered.indexOf(i.id) === -1) ordered.push(i.id); });
      return ordered;
    });
  }

  // Whole-transcript reconciliation: the QA pass on the on-deck list. See the reconcile config block
  // in config.js for the tuning knobs. The contract stays a REMOVE/ADD delta, not a rewritten list:
  // anything the model doesn't name is KEPT, so an under-answering model can never silently wipe the deck.
  function reconcile(transcript, onDeck, catalog, opts) {
    var t = (transcript || "").trim();
    if (t.length < 40) return Promise.resolve(null);   // not enough context to judge
    var have = (onDeck && onDeck.length) ? onDeck : [];
    var maxPts = (opts && opts.maxPoints != null) ? opts.maxPoints : 5;
    var maxObj = (opts && opts.maxObjections != null) ? opts.maxObjections : 3;
    // Generic by default ("a civil motion hearing"); a real profile can set
    // hearingConfig.reconcileHearingPhrase to the exact original wording (e.g. "a Florida civil
    // motion hearing") to reproduce prior behavior byte-for-byte.
    var hearingPhrase = HC().reconcileHearingPhrase || "a civil motion hearing";
    var sys = "You are the QA check on a courtroom copilot for a pro se litigant at " + hearingPhrase + ". " +
      "You are given (a) the FULL running TRANSCRIPT of what the OPPOSING side (opposing counsel and " +
      "the judge) has actually said, (b) the CURRENT ON-DECK list of prepared rebuttals/objections the app " +
      "queued, and (c) the full CATALOG of available items. The on-deck list was built by fast per-line " +
      "keyword and semantic matching, which fires items off garbled speech, a stray keyword, or a shared topic.\n" +
      "Your job is to make the on-deck list match the transcript: PRUNE what the other side did not actually " +
      "argue, and ADD what it clearly did. Both directions matter — a list that is too long or contains points " +
      "nobody made is as harmful as a list that misses one, because the litigant reads this at the podium.\n" +
      "REMOVE an on-deck item when any of these is true:\n" +
      "  (a) NOTHING in the whole transcript is a real argument, assertion, or factual claim that it answers — " +
      "it was triggered by a coincidental keyword, a shared topic, or mis-transcription. A doctrine the speaker " +
      "never invoked is not 'in the transcript' merely because a related word appears;\n" +
      "  (b) another on-deck item answers the SAME assertion more directly (keep the more specific one);\n" +
      "  (c) it is a weak or low-priority extra beyond the ceiling below.\n" +
      "KEEP an item that the transcript squarely supports even if the transcription is rough — real argument " +
      "counts through imperfect transcription. When genuinely unsure whether the point was argued, keep it.\n" +
      "ADD a catalog item ONLY when the transcript contains a specific assertion its trigger squarely answers, " +
      "it is not already on deck, and you can QUOTE the words: every entry in \"add\" must carry a \"quote\" of " +
      "3-15 words copied EXACTLY from the transcript. Never add an item just because it is generally relevant " +
      "to this motion, and never add one you cannot quote for.\n" +
      "Each on-deck item may be shown EVIDENCE: phrases from the transcript that triggered it. Evidence is the " +
      "other side's actual words - if an item has evidence, it was argued; do not call it 'never argued'.\n" +
      "CEILING: one spoken response can carry about " + maxPts + " developed rebuttal points and " + maxObj +
      " objections. If more than that survive, REMOVE the least-supported and lowest-priority ones (each item " +
      "is tagged high/med/low) until you are at the ceiling. Judge support by how squarely and how often the " +
      "transcript makes the argument. NEVER drop an item the transcript clearly and directly supports just to " +
      "hit the ceiling — if every survivor is squarely supported, stay slightly over rather than cut a real one.\n" +
      "ONLY-IF the ENTIRE transcript is small talk, greetings, or gibberish with NO legal argument at all, put " +
      "EVERY current on-deck id in \"remove\".\n" +
      "Every entry needs a reason of <=10 words (for a removal, say why the transcript does not support it). " +
      "Respond ONLY as JSON: " +
      "{\"remove\":[{\"id\":\"O-1\",\"reason\":\"never argued; only shares the word 'holder'\"}],\"add\":[{\"id\":\"R-3\",\"reason\":\"counsel called the requests overbroad\",\"quote\":\"exact words from the transcript\"}]}. " +
      "Leave an array empty when you have no confident change of that kind.";
    function line(i) {
      return i.id + " [" + i.kind + (i.priority ? ", " + i.priority : "") + "] " + i.heard +
        (i.evidence && i.evidence.length ? "\n    EVIDENCE in transcript: \"" + i.evidence.join("\", \"") + "\"" : "");
    }
    var cat = catalog.map(function (i) { return i.id + " [" + i.kind + (i.priority ? ", " + i.priority : "") + "] " + i.heard; }).join("\n");
    var od = have.length ? have.map(line).join("\n") : "(empty)";
    var usr = "TRANSCRIPT (opposing side so far):\n" + transcript + "\n\nCURRENT ON-DECK (prune what the " +
      "transcript does not support; ceiling " + maxPts + " rebuttals + " + maxObj + " objections):\n" + od +
      "\n\nCATALOG (all available items):\n" + cat;
    return chatJSON(sys, usr, opts).then(function (o) {
      if (!o || (typeof o !== "object")) return null;
      var inCat = {}; catalog.forEach(function (i) { inCat[i.id] = 1; });
      var onIds = {}; have.forEach(function (i) { onIds[i.id] = 1; });
      function clean(arr, membership) {
        if (!Array.isArray(arr)) return [];
        var seen = {}, out = [];
        arr.forEach(function (m) {
          var id = m && (m.id || m);
          if (!id || seen[id] || !membership[id]) return;
          seen[id] = 1; out.push({ id: id, reason: (m && m.reason) || "", quote: (m && m.quote) || "" });
        });
        return out;
      }
      var add = clean(o.add, inCat).filter(function (m) { return !onIds[m.id]; });
      var quotedAdds = add.filter(function (m) { return m.quote && String(m.quote).trim(); });
      if (quotedAdds.length) {
        var grounded = quotedAdds.filter(function (m) { return quoteSupported(m.quote, transcript); });
        try {
          var dropped = add.filter(function (m) { return grounded.indexOf(m) === -1; }).map(function (m) { return m.id; });
          if (dropped.length && global.console) console.log("[copilot] reconcile: dropped ungrounded add", dropped.join(","));
        } catch (e) {}
        add = grounded;
      }
      return { remove: clean(o.remove, onIds), add: add };
    });
  }

  // Second-pass speaker classifier: given a transcript snippet, guess who said it. Returns
  // {speaker, confidence} or null. Uses courtroom cues so it can tell the judge from counsel.
  //
  // The plaintiff/defendant descriptions below are the ONLY genuinely case-specific text among the
  // five LLM tasks in this file (real party names, the specific legal theory in play). They come
  // from the active hearing profile via window.CASE.hearingConfig, with a fully generic fallback
  // that never names a real party -- see hearings/example/data.js for the shape, and
  // hearings/README.md for how a private hearing profile overrides them.
  function classifySpeaker(text) {
    var hc = HC();
    var hearingPhrase = hc.hearingTypePhrase || "a civil motion hearing";
    var plaintiffDesc = hc.plaintiffRoleDescription ||
      "counsel for the moving party seeking summary judgment. Cues: 'we respectfully request', " +
      "'plaintiff moves', 'we ask the Court to', 'summary judgment should be granted'";
    var defendantDesc = hc.defendantRoleDescription ||
      "the pro se defendant(s), OPPOSING summary judgment. Cues: 'the motion should be denied', " +
      "'we object', standing or real-party-in-interest arguments";
    var sys = "You identify who is speaking in " + hearingPhrase + " (no jury) from a short " +
      "transcript snippet. Choose exactly one role:\n" +
      "- \"court\" = the JUDGE. Neutral; rules and runs the hearing. Cues: 'overruled', 'sustained', 'the Court " +
      "finds', 'the motion is granted/denied', 'I'll allow it', 'so ordered', 'counsel', 'counselor', 'you may " +
      "proceed', 'go ahead', 'approach the bench', 'be seated', 'for the record', 'the record will reflect', " +
      "'I've reviewed', directing the parties, or asking a procedural question ('did you say...?').\n" +
      "- \"plaintiff\" = " + plaintiffDesc + ".\n" +
      "- \"defendant\" = " + defendantDesc + ".\n" +
      "- \"other\" = a witness or anyone else.\n" +
      "Many lines start 'Your Honor' - use the substance, not that phrase. Respond ONLY as JSON: " +
      "{\"speaker\":\"court|plaintiff|defendant|other\",\"confidence\":0.0-1.0}.";
    return chatJSON(sys, "SNIPPET: " + text).then(function (o) {
      if (!o || !o.speaker) return null;
      var ok = { court: 1, plaintiff: 1, defendant: 1, other: 1 };
      if (!ok[o.speaker]) return null;
      var c = typeof o.confidence === "number" ? o.confidence : 0.5;
      return { speaker: o.speaker, confidence: c };
    });
  }

  // Compose a spoken rebuttal from the on-deck points (verbatim scripts), the transcript context,
  // the linchpins to anchor, and the traps to avoid. Returns plain text with **emphasis** markers,
  // or null on failure (the app then falls back to concatenating the verbatim scripts).
  function composeOne(name, sys, usr) {
    var c = cfg(), p = confOf(name), to = withTimeout((c.timeoutMs || 12000) * 2), cloud = isCloudName(name);
    var url, headers = { "Content-Type": "application/json" }, body;
    if (cloud) {
      url = p.baseUrl.replace(/\/$/, "") + "/chat/completions";
      headers["Authorization"] = "Bearer " + (p.apiKey || "");
      body = { model: p.model, temperature: 0.3, stream: false, max_completion_tokens: 4000, messages: [{ role: "system", content: sys }, { role: "user", content: usr }] };
      if (name === "groq") body.reasoning_effort = "low";  // avoid empty content from hidden reasoning
    } else {
      url = p.url.replace(/\/$/, "") + "/api/chat";
      body = { model: p.model, stream: false, options: { temperature: 0.3 }, messages: [{ role: "system", content: sys }, { role: "user", content: usr }] };
      if (/gpt-oss|deepseek/i.test(p.model)) body.think = false;  // reasoning models: emit content, not hidden thinking
    }
    return fetch(url, { method: "POST", headers: headers, signal: to.signal, body: JSON.stringify(body) })
      .then(function (r) { to.done(); return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return null;
        var content = cloud ? (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content)
          : (j.message && j.message.content);
        if (content) { markUsed(name); return content; }
        return null;   // empty content -> fall through to the next provider
      })
      .catch(function () { to.done(); return null; });
  }

  // ---- compose QA: an on-deck objection must never silently vanish from the woven response ----
  var COMPOSE_STOP = { plaintiff: 1, defendant: 1, defendants: 1, plaintiffs: 1, honor: 1, courts: 1,
    should: 1, because: 1, cannot: 1, before: 1, without: 1, whether: 1, itself: 1, therefore: 1, simply: 1 };
  function bigWords(s) {
    var out = {};
    String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).forEach(function (w) {
      if (w.length >= 6 && !COMPOSE_STOP[w]) out[w] = 1;
    });
    return out;
  }
  function objectionCovered(draft, objScript, otherScripts) {
    var mine = bigWords(objScript), other = bigWords(otherScripts), want = [];
    Object.keys(mine).forEach(function (w) { if (!other[w]) want.push(w); });
    if (want.length < 3) return true;      // nothing distinctive left -> an on-deck point already carries it
    var have = bigWords(draft), hit = 0;
    want.forEach(function (w) { if (have[w]) hit++; });
    return (hit / want.length) >= 0.35;
  }
  // ---- compose QA 2: emphasis must actually land on the load-bearing text ----
  function boldSpans(text) {
    var out = [], rx = /\*\*[\s\S]*?\*\*/g, m;
    while ((m = rx.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
    return out;
  }
  function overlapsBold(spans, a, b) {
    return spans.some(function (s) { return a < s[1] && b > s[0]; });
  }
  function insideAnyBold(text, spans, needle) {
    return spans.some(function (s) { return text.slice(s[0], s[1]).indexOf(needle) !== -1; });
  }
  function boundaryOk(text, a, b) {
    var before = a > 0 ? text.charAt(a - 1) : " ";
    var after = b < text.length ? text.charAt(b) : " ";
    return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
  }
  function applyEmphasis(text, phrases) {
    if (!text || !phrases || !phrases.length) return text;
    var added = [];
    phrases.map(function (p) { return String(p || "").trim(); })
      .filter(function (p) { return p.length >= 3; })
      .sort(function (a, b) { return b.length - a.length; })
      .forEach(function (phrase) {
        var spans = boldSpans(text), low = text.toLowerCase(), needle = phrase.toLowerCase();
        if (insideAnyBold(low, spans, needle)) return;   // already emphasized once; don't add a second
        var at = low.indexOf(needle), end;
        while (at !== -1) {
          end = at + needle.length;
          if (!overlapsBold(spans, at, end) && boundaryOk(text, at, end)) {
            text = text.slice(0, at) + "**" + text.slice(at, end) + "**" + text.slice(end);
            added.push(phrase);
            return;
          }
          at = low.indexOf(needle, at + 1);
        }
      });
    try {
      if (added.length && global.console) console.log("[copilot] compose: emphasis added ->", added.join(" | "));
    } catch (e) {}
    lastCompose.emphasized = added;
    return text;
  }
  function capEmphasisRepeats(text, maxPer) {
    if (!text) return text;
    var seen = {}, out = "", rx = /\*\*([\s\S]*?)\*\*/g, m, last = 0, dropped = [];
    while ((m = rx.exec(text)) !== null) {
      var key = m[1].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      out += text.slice(last, m.index);
      seen[key] = (seen[key] || 0) + 1;
      if (key && seen[key] > maxPer) { out += m[1]; dropped.push(m[1]); }
      else { out += m[0]; }
      last = m.index + m[0].length;
    }
    out += text.slice(last);
    try {
      if (dropped.length && global.console) console.log("[copilot] compose: emphasis capped ->", dropped.join(" | "));
    } catch (e) {}
    lastCompose.emphasisCapped = dropped;
    return out;
  }

  var lastCompose = { repaired: false, appended: [], emphasized: [], emphasisCapped: [] };
  function missingObjections(draft, objs, pointText) {
    return objs.filter(function (o) {
      var others = pointText + " " + objs.map(function (x) { return x === o ? "" : (x.script || ""); }).join(" ");
      return !objectionCovered(draft, o.script || "", others);
    });
  }
  function spliceBeforeClose(text, add) {
    var paras = String(text).split(/\n\s*\n/);
    if (paras.length >= 3) { paras.splice(paras.length - 1, 0, add); return paras.join("\n\n"); }
    return String(text).replace(/\s*$/, "") + "\n\n" + add;
  }
  function ensureObjections(text, payload, sys, usr) {
    lastCompose = { repaired: false, appended: [], emphasized: [], emphasisCapped: [] };
    var objs = (payload.objections || []).filter(function (o) { return o && o.script; });
    if (!text || !objs.length) return Promise.resolve(text);
    var pointText = (payload.points || []).map(function (p) { return p.script || ""; }).join(" ");
    var miss = missingObjections(text, objs, pointText);
    if (!miss.length) return Promise.resolve(text);
    try { if (global.console) console.log("[copilot] compose: objections missing from draft ->", miss.map(function (o) { return o.id; }).join(",")); } catch (e) {}
    var fixUsr = usr + "\n\n=== REVISION REQUIRED ===\nBelow is your draft. It OMITTED the substance of the " +
      "required point(s) that follow. Rewrite the draft so each one is stated in full - the concession, the " +
      "relief, and the specific items or dates it names - woven into the argument as ordinary prose (never " +
      "labeled 'objection'). Keep everything else that is already good, obey every rule in the contract, and " +
      "print ONLY the complete revised speech.\n\nMISSING:\n" +
      miss.map(function (o) { return "- " + (o.script || ""); }).join("\n") +
      "\n\nYOUR DRAFT:\n" + text;
    return sequence(providerList(), function (name) { return composeOne(name, sys, fixUsr); })
      .then(function (fixed) {
        var best = text, bestMiss = miss;
        if (fixed && fixed.trim()) {
          var fm = missingObjections(fixed, objs, pointText);
          if (fm.length <= miss.length) { best = fixed; bestMiss = fm; lastCompose.repaired = true; }
        }
        if (!bestMiss.length) return best;
        // Last resort: the prepared wording goes in verbatim, so nothing is ever lost at the podium.
        bestMiss.forEach(function (o) { best = spliceBeforeClose(best, o.script); lastCompose.appended.push(o.id); });
        try { if (global.console) console.log("[copilot] compose: spliced verbatim ->", lastCompose.appended.join(",")); } catch (e) {}
        return best;
      })
      .catch(function () {
        var out = text;
        miss.forEach(function (o) { out = spliceBeforeClose(out, o.script); lastCompose.appended.push(o.id); });
        return out;
      });
  }

  function composeRebuttal(payload) {
    // Party context from "Who Am I": who we speak for, and who the opponent is.
    var me = payload.me || { label: "Defendant", name: "the defendant", role: "opposing summary judgment" };
    var opp = payload.opponent || { label: "Plaintiff", name: "the opposing party", role: "" };
    var meRole = me.label || "Defendant";      // "Defendant" | "Plaintiff"
    var oppRole = opp.label || "Plaintiff";
    // Generic by default; a real profile can set hearingConfig.hearingTypePhrase to the exact
    // original wording (e.g. "a Florida civil summary-judgment hearing").
    var hearingPhrase = HC().hearingTypePhrase || "a civil summary-judgment hearing";
    var sys =
      "ROLE: You ghost-write the exact words that " + me.name + " will SPEAK aloud, in the first person, right now " +
      "at " + hearingPhrase + ". You are the " + meRole + "'s advocate and you write ONLY the " +
      meRole + "'s side.\n\n" +
      "=== WHO IS WHO (be biased for your side) ===\n" +
      "- YOU SPEAK FOR: the " + meRole + " — " + me.name + (me.role ? ", " + me.role : "") + ". Use 'I' / 'we'.\n" +
      "- THE OPPONENT IS: the " + oppRole + " — " + opp.name + (opp.role ? ", " + opp.role : "") + ". Refer to them " +
      "as 'the " + oppRole + "' or 'opposing counsel'. NEVER argue the " + oppRole + "'s side except to rebut it; " +
      "never concede a point you were not told to concede.\n" +
      "- DOCUMENTS: each Tab below is marked whose binder it is in. Tabs marked [MY binder] are the " + meRole +
      "'s own exhibits — use them as your proof. Tabs marked [" + oppRole + "'s binder] are the opponent's — use " +
      "them to turn the opponent's own record against them. Name the tab when you rely on it, but the bracket " +
      "markings are CONTEXT ONLY: never say '[MY binder]' or '[" + oppRole + "'s binder]' aloud. If ownership " +
      "matters, phrase it naturally, e.g. 'our own Tab 9' or 'the " + oppRole + "'s own Exhibit 5'.\n\n" +
      "=== OUTPUT CONTRACT (this governs what you print) ===\n" +
      "1. Print ONLY the spoken rebuttal - the literal words the " + meRole + " will say, starting with 'Your Honor,'.\n" +
      "2. NEVER restate, quote, paraphrase, or refer to any instruction in this prompt. Do not describe what you " +
      "are emphasizing or why. Phrases like 'phrases that must be slowed', 'exact citations', 'the following are " +
      "linchpins', 'here is', headings, labels, stage directions, or any note about your own formatting are " +
      "FORBIDDEN in the output. If such text would appear, delete it.\n" +
      "3. The ONLY non-spoken marks allowed are **double asterisks** used to wrap words to slow down (see below). " +
      "Nothing else.\n" +
      "4. Output is plain spoken prose in short paragraphs, one argument each.\n" +
      "5. NO DUPLICATION: never repeat a sentence, phrase, or point. Each argument appears exactly once. The ONLY " +
      "permitted repetition is the single burden-of-proof anchor, said at the opening, once in the middle, and at " +
      "the close - and nowhere else. If you catch yourself restating something, cut it.\n" +
      "6. ATTRIBUTION (critical): each point is given as 'OPPONENT SAID:' (the " + oppRole + "'s assertion, context " +
      "ONLY) followed by 'YOUR SCRIPT:' (your side's answer). NEVER speak the OPPONENT SAID text as your own words, " +
      "and NEVER phrase the opponent's assertion with 'I', 'we', or 'our'. If you restate their position at all, " +
      "attribute it expressly - 'The " + oppRole + " argues that...', 'Counsel says...' - and immediately answer it. " +
      "Speaking their assertion in the first person would make the speaker argue against himself at the podium.\n" +
      "7. OBJECTIONS ARE MANDATORY CONTENT: every entry under 'OBJECTIONS ON DECK' must have its SUBSTANCE " +
      "stated in the speech - the concession offered, the relief requested, the specific dates, items, or " +
      "conditions it names. This is not optional and not conditional on space: if the word budget is tight, " +
      "compress a rebuttal point instead. Do not announce it as an 'objection'; state it as part of the " +
      "argument, in your own flowing prose, where it fits best. The ONLY exception is an on-deck point that " +
      "already says the same thing in the same detail - a point on the same topic is NOT the same thing. " +
      "Before you finish, re-read your draft against the objections list and confirm each one is in there.\n\n" +
      "=== HOW TO WRITE (guidance - follow it, never print it) ===\n" +
      "- The ON-DECK POINTS are the SPINE of the speech: write ONE DEVELOPED paragraph per on-deck point, in the " +
      "given order (strongest first), plain courtroom English. Do NOT invent extra numbered points from the power " +
      "phrases or linchpins - those are woven IN as support for the on-deck points, never listed as their own items.\n" +
      "- DEVELOP each point with real substance (typically 3-5 sentences): (1) state the governing rule, burden, or " +
      "standard; (2) APPLY it to THIS record - name the specific Tab/exhibit and the concrete fact or gap that wins " +
      "the point; (3) state what the Court should therefore do. Give each point enough to actually land - this is " +
      "the 'meat'. Never pad, never repeat, and do not simply restate what opposing counsel already said or reread " +
      "the briefs; add the analysis that DEFEATS their point.\n" +
      "- This is a live " + hearingPhrase + " (no jury). Argue like an advocate at the " +
      "podium: lead with the dispositive burden/standing points, tie every assertion to the record, keep it " +
      "focused and professional, and never concede an element you were not told to concede.\n" +
      "- You may open each paragraph with a plain connector ('First,' 'Next,' 'Finally,') or none; do not manufacture " +
      "a long numbered list longer than the on-deck points.\n" +
      "- Carry the substance of every OBJECTION ON DECK into the response (there is no separate 'object now' " +
      "moment in a woven response) - see contract rule 7. A scope concession or an alternative-relief request " +
      "is often the point that actually wins the motion, so give it a real sentence or two, not a clause.\n" +
      "- EMPHASIS (**double asterisks**) marks the words the speaker slows down and the judge is meant to " +
      "remember. It is the most valuable formatting you control, so spend it only on load-bearing text.\n" +
      "  ALWAYS wrap in **double asterisks**: (a) every rule or statute cite exactly as written, INCLUDING its " +
      "subsection; (b) every case name; (c) every Tab or exhibit reference; " +
      "(d) every dollar figure; (e) every operative DATE and deadline (the date of an order, a response deadline, " +
      "a cure deadline, the number of days you ask for); (f) every specific record item you name - a numbered " +
      "request for admission, interrogatory, or request for production, a named form or filing, a named entity; " +
      "(g) every entry in the ALWAYS EMPHASIZE list, the first time it appears in a paragraph; and (h) each " +
      "ANCHOR PHRASE you use - wrap the phrase itself, not the sentence around it.\n" +
      "  NEVER bold: connectives, filler, courtesy ('Your Honor'), your own narration, ordinary argument, or the " +
      "opponent's assertion. Never bold a whole sentence or paragraph, and never bold a LINCHPIN paragraph - " +
      "linchpins are guidance about what to argue, not text to quote or emphasize.\n" +
      "  DENSITY: aim for one emphasis roughly every 2 to 4 sentences, and keep spans short (a few words; an " +
      "anchor phrase may be longer). Bolding almost nothing and bolding almost everything are equally useless. " +
      "Do not emphasize the same item more than TWICE in the whole speech, and never twice in a row - after the " +
      "first time, the reader already knows to slow down for it.\n" +
      "- ANCHOR (Parker's rule of three): choose ONE anchor - the FIRST anchor phrase if any are given, otherwise " +
      "the first power phrase - and land it three times: in the opening, once in the middle, and at the close, " +
      "bolded every time. A short anchor phrase may sit inside a different carrier sentence each time, but the " +
      "anchor phrase itself must be word-for-word identical on all three uses. Do not repeat any OTHER line.\n" +
      "- Use ANCHOR PHRASES as the memorable landing line of the point they belong to: make the argument, then " +
      "land it on the phrase, word for word as given and wrapped in **double asterisks**. These are the lines the " +
      "judge is meant to remember, so they are the single most important thing to emphasize - more important than " +
      "any citation. Use only the ones that fit points actually on deck, at most once each (the rule-of-three " +
      "anchor is the one exception), and never stack two back-to-back or recite them as a list.\n" +
      "- FINAL CHECK before you print: re-read your own draft and confirm that every anchor phrase you used is " +
      "wrapped in **double asterisks**, and that no paragraph runs more than about four sentences with no " +
      "emphasis at all. Fix any you missed. Print only the corrected speech.\n" +
      "- If the opponent asserted that something is 'undisputed', 'not contested', 'established', or 'sufficient' " +
      "and an on-deck point contradicts it, CORRECT that characterization head-on in plain words ('We do contest " +
      "that, and here is why...') rather than letting it stand.\n" +
      "- Lead with the most DISPOSITIVE winners before secondary or procedural points.\n" +
      "- Where it fits, close a major point with the conclusion that a **genuine dispute of material fact** exists " +
      "and the case must go to trial - but say this at most twice total, not after every paragraph.\n" +
      "- Work in the provided POWER PHRASES verbatim where they fit naturally; do not stack them back-to-back.\n" +
      "- Be substantive, not terse: fully develop each point, but land it and move on - no belaboring, no filler.\n" +
      "- Use ONLY the citations provided; never invent one. Obey every TRAP.\n" +
      "- WORD BUDGET: treat it as a TARGET, not just a ceiling. Aim to use roughly 85-100% of it so every point " +
      "gets developed; stay at or under the cap. If the points cannot all fit, cover the strongest fully and " +
      "compress or drop the weakest rather than thinning every point to a single sentence.\n" +
      "Remember: the reader sees only the words you print. Print the speech, nothing about the speech.";
    function block(title, arr) { return title + ":\n" + (arr && arr.length ? arr.join("\n") : "(none)") + "\n\n"; }
    function tabStr(tabs) {
      return (tabs || []).map(function (tb) {
        var name = tb && tb.tab != null ? tb.tab : tb;
        var own = tb && tb.owner ? (tb.mine || tb.owner === me.party ? "MY binder" : ((tb.ownerLabel || tb.owner) + "'s binder")) : "";
        return name + (own ? " [" + own + "]" : "");
      }).join(", ");
    }
    var pts = (payload.points || []).map(function (i, n) {
      return (n + 1) + ". [" + (i.priority || "med") + "] OPPONENT SAID (context only - NEVER speak this in first person): " +
        (i.heard || i.trigger || "") +
        "\n   YOUR SCRIPT (your side's answer - this is what you say): " + (i.script || "") +
        (i.tabs && i.tabs.length ? "\n   TABS: " + tabStr(i.tabs) : "");
    }).join("\n");
    var objs = (payload.objections || []).map(function (i) {
      return "- OPPONENT SAID (context only): " + (i.heard || i.trigger || "") +
        " :: YOUR SCRIPT (what you say): " + (i.script || "") +
        (i.tabs && i.tabs.length ? " [" + tabStr(i.tabs) + "]" : "");
    }).join("\n");
    var docsBlock = (payload.docs && payload.docs.length)
      ? payload.docs.map(function (d) {
          var who = (d.mine || d.owner === me.party) ? "MY binder" : ((d.ownerLabel || d.owner) + "'s binder");
          return d.tab + " [" + who + "]" + (d.title ? " - " + d.title : "");
        }).join("\n")
      : "(none)";
    var budgetLine = (payload.budget && payload.budget.words)
      ? ("WORD BUDGET: about " + payload.budget.words + " words (~" + (payload.budget.minutes || 0).toFixed(1) + " min at " + (payload.budget.wpm || 140) + " wpm). Stay at or under it.\n\n")
      : "";
    var usr = "You are writing for: the " + meRole + " (" + me.name + "). The opponent is the " + oppRole + " (" +
      opp.name + ").\nThe blocks below are INPUT DATA to draft from. Do not echo their labels.\n\n" + budgetLine +
      "ON-DECK POINTS (priority order, cover each once):\n" + pts + "\n\n" +
      "OBJECTIONS ON DECK (REQUIRED - contract rule 7: the substance of EVERY one of these must appear in the " +
      "speech, stated as part of your argument and never labeled 'objection'):\n" + (objs || "(none)") + "\n\n" +
      "DOCUMENTS IN PLAY (whose binder holds each tab):\n" + docsBlock + "\n\n" +
      block("WHAT THE OTHER SIDE SAID (transcript)", payload.transcript) +
      block("ANCHOR PHRASES - short sayable lines the judge should remember. Use the ones that fit, VERBATIM, " +
            "and wrap EVERY use in **double asterisks**. The first one is your rule-of-three anchor", payload.anchorPhrases) +
      block("ALWAYS EMPHASIZE - wrap each of these in **double asterisks** every time it appears in the speech",
            payload.emphasize) +
      block("POWER PHRASES to weave in verbatim (do not stack them)", payload.powerPhrases) +
      block("LINCHPINS - SUBSTANTIVE GUIDANCE ONLY: the facts, cites, and fallbacks each point must land. " +
            "Argue what they say; do NOT quote, recite, or bold them", payload.linchpins) +
      block("TRAPS to avoid", payload.traps);
    var emphasisList = (payload.anchorPhrases || []).concat(payload.emphasize || []);
    return sequence(providerList(), function (name) { return composeOne(name, sys, usr); })
      .then(function (text) { return ensureObjections(text, payload, sys, usr); })
      .then(function (text) { return applyEmphasis(text, emphasisList); })
      .then(function (text) { return capEmphasisRepeats(text, 2); });
  }

  LLM.match = match;
  LLM.sortOnDeck = sortOnDeck;
  LLM.reconcile = reconcile;
  LLM.classifySpeaker = classifySpeaker;
  LLM.composeRebuttal = composeRebuttal;
  LLM.lastCompose = function () { return lastCompose; };
  // Exposed for tests: the pure helpers behind match()/reconcile()/composeRebuttal()'s QA passes.
  LLM._internal = {
    lowSignal: lowSignal, quoteSupported: quoteSupported, objectionCovered: objectionCovered,
    applyEmphasis: applyEmphasis, capEmphasisRepeats: capEmphasisRepeats, boldSpans: boldSpans
  };
  // composeRebuttal calls composeOne() directly (free-text, not core's JSON-mode chatJSON), so it
  // tracks its own lastUsed separately from core's transport. Override LLM.last() to report
  // whichever of the two actually ran most recently, so the status UI reflects compose calls too.
  var coreLast = LLM.last;
  LLM.last = function () {
    var fromCore = coreLast ? coreLast() : null;
    if (!fromCore) return lastUsed;
    if (!lastUsed) return fromCore;
    return lastUsed.at > fromCore.at ? lastUsed : fromCore;
  };
})(typeof window !== "undefined" ? window : globalThis);
