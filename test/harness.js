// Shared test harness: loads real shipped modules with `vm` against a faked `window`, so tests
// exercise the actual code path instead of a re-implementation of it.
//
// IMPORTANT: `load()` passes an ABSOLUTE path as vm's `filename` option. c8 (V8 coverage)
// attributes executed lines to whatever filename vm reports; a relative path makes every line
// in the loaded module attribute to nothing, silently reporting 0% coverage for it.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

function sameJSON(actual, expected, message) {
  const assert = require("node:assert/strict");
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) assert.fail((message ? message + "\n" : "") + "expected " + e + "\nactual   " + a);
}

function load(win, relFile) {
  const abs = path.join(ROOT, relFile);
  const code = fs.readFileSync(abs, "utf8");
  const ctx = vm.createContext(win);
  win.window = win;
  vm.runInContext(code, ctx, { filename: abs });
}

module.exports = { ROOT, load, sameJSON };
