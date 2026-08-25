"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, sameJSON } = require("./harness");

function boot(opts) {
  opts = opts || {};
  const chatCalls = [];
  const fetchCalls = [];
  const win = {
    console: console,
    CONFIG: opts.CONFIG || { llm: {} },
    CASE: opts.CASE || { hearingConfig: {} },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    fetch: function (url, init) {
      fetchCalls.push({ url: url, init: init });
      return opts.fetchImpl ? opts.fetchImpl(url, init) : Promise.resolve({ ok: false });
    },
    LLM: {
      chatJSON: function (sys, usr, o) {
        chatCalls.push({ sys: sys, usr: usr, opts: o });
        return opts.chatJSONImpl ? opts.chatJSONImpl(sys, usr, o) : Promise.resolve(null);
      },
      providerList: function () { return opts.providerList || []; },
      sequence: function (list, attempt) {
        return list.length ? Promise.resolve(attempt(list[0])) : Promise.resolve(null);
      },
      withTimeout: function () { return { signal: {}, done: function () {} }; },
      last: function () { return opts.coreLast || null; }
    }
  };
  load(win, "app/llm.js");
  return { win, chatCalls, fetchCalls };
}

test("llm: extends window.LLM rather than replacing it (core's transport survives)", () => {
  const { win } = boot();
  assert.equal(typeof win.LLM.chatJSON, "function", "core's chatJSON must still be present");
  assert.equal(typeof win.LLM.match, "function");
  assert.equal(typeof win.LLM.classifySpeaker, "function");
});

test("llm: classifySpeaker uses generic party descriptions when no hearing profile override is set", async () => {
  const { win, chatCalls } = boot({ chatJSONImpl: () => Promise.resolve({ speaker: "court", confidence: 0.9 }) });
  await win.LLM.classifySpeaker("Objection, Your Honor.");
  const sys = chatCalls[0].sys;
  assert.match(sys, /a civil motion hearing/);
  assert.match(sys, /counsel for the moving party seeking summary judgment/);
  assert.match(sys, /the pro se defendant\(s\), OPPOSING summary judgment/);
  // The whole point of parameterizing this: no real party/case names in the default prompt.
  assert.doesNotMatch(sys, /amur|old gold|christopher queen|michael williams/i);
});

test("llm: classifySpeaker uses the active hearing profile's overrides when set", async () => {
  const CASE = { hearingConfig: {
    hearingTypePhrase: "a fictional civil summary-judgment hearing",
    plaintiffRoleDescription: "counsel for Fictional Plaintiff Co, the moving party",
    defendantRoleDescription: "Fictional Defendant, PRO SE, opposing summary judgment"
  } };
  const { win, chatCalls } = boot({ CASE: CASE, chatJSONImpl: () => Promise.resolve({ speaker: "plaintiff", confidence: 0.8 }) });
  await win.LLM.classifySpeaker("We respectfully request summary judgment.");
  const sys = chatCalls[0].sys;
  assert.match(sys, /a fictional civil summary-judgment hearing/);
  assert.match(sys, /Fictional Plaintiff Co/);
  assert.match(sys, /Fictional Defendant, PRO SE/);
});

test("llm: classifySpeaker rejects an unrecognized role and defaults confidence", async () => {
  const { win } = boot({ chatJSONImpl: () => Promise.resolve({ speaker: "bailiff" }) });
  const result = await win.LLM.classifySpeaker("...");
  assert.equal(result, null, "an out-of-enum speaker value must not pass through");
});

test("llm: reconcile uses a generic hearing-phrase default and the configured ceilings", async () => {
  const { win, chatCalls } = boot({ chatJSONImpl: () => Promise.resolve(null) });
  await win.LLM.reconcile("a".repeat(50), [], [{ id: "R-1", kind: "Rebuttal", heard: "x" }], { maxPoints: 3, maxObjections: 1 });
  assert.match(chatCalls[0].sys, /a civil motion hearing/);
  assert.match(chatCalls[0].sys, /about 3 developed rebuttal points and 1/);
});

test("llm: reconcile short-circuits on a too-short transcript without calling the model", async () => {
  const { win, chatCalls } = boot();
  const result = await win.LLM.reconcile("too short", [], []);
  assert.equal(result, null);
  assert.equal(chatCalls.length, 0);
});

test("llm._internal.lowSignal: guards trivial input from reaching the model", () => {
  const { win } = boot();
  const lowSignal = win.LLM._internal.lowSignal;
  assert.equal(lowSignal("plaintiff"), true, "a bare party label carries no argument");
  assert.equal(lowSignal("objection"), true);
  assert.equal(lowSignal("a b"), true, "too few words");
  assert.equal(lowSignal("The affidavit fails to establish standing under the statute."), false);
});

test("llm.match: low-signal text resolves null without ever calling the model", async () => {
  const { win, chatCalls } = boot();
  const result = await win.LLM.match("plaintiff", "plaintiff", [{ id: "R-1", kind: "Rebuttal", heard: "x" }]);
  assert.equal(result, null);
  assert.equal(chatCalls.length, 0);
});

test("llm.match: drops matches whose quote is not actually grounded in what was said", async () => {
  const items = [{ id: "R-1", kind: "Rebuttal", heard: "trigger" }];
  const { win } = boot({
    chatJSONImpl: () => Promise.resolve({ matches: [{ id: "R-1", quote: "words never actually spoken here" }] })
  });
  const result = await win.LLM.match(
    "The affidavit does not establish commercial reasonableness at all.", "plaintiff", items
  );
  // match() always returns an array once past the initial "no matches at all" null guard; an
  // ungrounded quote is filtered OUT of that array, leaving it empty, not null.
  sameJSON(result, [], "an ungrounded quote must not survive the grounding filter");
});

test("llm.match: keeps a match whose quote is verifiably grounded in the heard text", async () => {
  const items = [{ id: "R-1", kind: "Rebuttal", heard: "trigger" }];
  const { win } = boot({
    // quoteSupported requires >= 3 words in the quote itself (a 1-2 word span is never trusted as
    // grounding evidence), so this must be at least a 3-word span that actually appears verbatim.
    chatJSONImpl: () => Promise.resolve({ matches: [{ id: "R-1", quote: "establish commercial reasonableness at" }] })
  });
  const result = await win.LLM.match(
    "The affidavit does not establish commercial reasonableness at all.", "plaintiff", items
  );
  sameJSON(result, [{ id: "R-1", kind: "Rebuttal" }]);
});

test("llm._internal.quoteSupported: requires 3 consecutive words to appear verbatim", () => {
  const { win } = boot();
  const qs = win.LLM._internal.quoteSupported;
  assert.equal(qs("burden of proof standard", "Plaintiff bears the burden of proof standard here."), true);
  assert.equal(qs("burden of proof standard", "Nothing about proof or burdens was said."), false);
  assert.equal(qs("two words", "two words only"), false, "fewer than 3 words never counts as grounded");
});

test("llm._internal.applyEmphasis: wraps the first whole-word occurrence, longest phrase first", () => {
  const { win } = boot();
  const out = win.LLM._internal.applyEmphasis("Rule 1.380 and Rule 1.380(a)(3) both apply.", ["Rule 1.380(a)(3)", "Rule 1.380"]);
  assert.match(out, /\*\*Rule 1\.380\(a\)\(3\)\*\*/, "the longer, more specific phrase gets wrapped");
});

test("llm._internal.applyEmphasis: never double-wraps a phrase already inside a bolded span", () => {
  const { win } = boot();
  const out = win.LLM._internal.applyEmphasis("**Tab 9** is the key exhibit, see Tab 9 again.", ["Tab 9"]);
  const matches = out.match(/\*\*Tab 9\*\*/g) || [];
  assert.equal(matches.length, 1, "only the pre-existing bold span should remain; no second wrap added");
});

test("llm._internal.capEmphasisRepeats: strips markers past the cap without removing the words", () => {
  const { win } = boot();
  const text = "**Agreed Order** first. **Agreed Order** second. **Agreed Order** third.";
  const out = win.LLM._internal.capEmphasisRepeats(text, 2);
  const bolded = (out.match(/\*\*Agreed Order\*\*/g) || []).length;
  assert.equal(bolded, 2, "only the first two emphases survive");
  assert.match(out, /Agreed Order third/, "the words themselves are never deleted, only the ** markers");
});

test("llm._internal.objectionCovered: true when nothing distinctive remains to check", () => {
  const { win } = boot();
  assert.equal(win.LLM._internal.objectionCovered("anything", "", ""), true);
});

test("llm.composeRebuttal: hearingTypePhrase and hearingTypePhraseReminder are two independent slots, not one shared variable", async () => {
  // Regression test for a real fidelity bug: composeRebuttal names the hearing type TWICE, in
  // different wording each time (once in the sentence-opener, once deep in the writing guidance).
  // Collapsing both into a single config field made it impossible for a real hearing profile to
  // reproduce the original app's two genuinely different literal phrases at once.
  const CASE = { hearingConfig: {
    hearingTypePhrase: "OPENER_PHRASE_UNIQUE",
    hearingTypePhraseReminder: "REMINDER_PHRASE_UNIQUE"
  } };
  const CONFIG = { llm: { ollama: { url: "http://fake-ollama.invalid", model: "test-model" } } };
  const { win, fetchCalls } = boot({
    CASE: CASE,
    CONFIG: CONFIG,
    providerList: ["ollama"],
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: { content: "Your Honor, ..." } }) })
  });
  await win.LLM.composeRebuttal({
    me: { label: "Defendant", name: "the defendant", role: "opposing summary judgment" },
    opponent: { label: "Plaintiff", name: "the opposing party", role: "" },
    points: [], objections: []
  });
  assert.equal(fetchCalls.length, 1, "composeOne should have made exactly one fetch call");
  const sys = JSON.parse(fetchCalls[0].init.body).messages[0].content;
  assert.match(sys, /at OPENER_PHRASE_UNIQUE\. You are the Defendant's advocate/, "the sentence-opener slot must use hearingTypePhrase");
  assert.match(sys, /This is a live REMINDER_PHRASE_UNIQUE\. Argue like an advocate/, "the writing-guidance reminder slot must use hearingTypePhraseReminder");
  assert.doesNotMatch(sys, /at REMINDER_PHRASE_UNIQUE\./, "the reminder phrase must never leak into the opener slot");
  assert.doesNotMatch(sys, /live OPENER_PHRASE_UNIQUE/, "the opener phrase must never leak into the reminder slot");
});

test("llm.composeRebuttal: falls back to the two distinct generic defaults when no hearing profile override is set", async () => {
  const CONFIG = { llm: { ollama: { url: "http://fake-ollama.invalid", model: "test-model" } } };
  const { win, fetchCalls } = boot({
    CONFIG: CONFIG,
    providerList: ["ollama"],
    fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ message: { content: "Your Honor, ..." } }) })
  });
  await win.LLM.composeRebuttal({ points: [], objections: [] });
  const sys = JSON.parse(fetchCalls[0].init.body).messages[0].content;
  assert.match(sys, /at a civil summary-judgment hearing\. You are the Defendant's advocate/);
  assert.match(sys, /This is a live a civil summary-judgment hearing \(no jury\)\. Argue like an advocate/);
  // The whole point of parameterizing this: no real party/case names in the default prompt.
  assert.doesNotMatch(sys, /amur|old gold|christopher queen|michael williams/i);
});
