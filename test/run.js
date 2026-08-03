#!/usr/bin/env node
// Zero-dependency test runner: loads classic scripts onto a fake self, runs assertions.
// Usage: node test/run.js

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error("  FAIL:", msg);
}

function loadScript(rel) {
  const code = fs.readFileSync(path.join(root, rel), "utf8");
  const sandbox = {
    self: {},
    console,
    // minimal globals used by scripts
    CSS: { escape: (s) => String(s).replace(/"/g, '\\"') },
  };
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: rel });
  return sandbox;
}

function loadScripts(rels) {
  const sandbox = {
    console,
    CSS: { escape: (s) => String(s).replace(/"/g, '\\"') },
  };
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of rels) {
    const code = fs.readFileSync(path.join(root, rel), "utf8");
    vm.runInContext(code, sandbox, { filename: rel });
  }
  return sandbox;
}

// --- conceptVocabulary ---
console.log("conceptVocabulary");
{
  const s = loadScript("lib/conceptVocabulary.js");
  const { afGuessConcept, afKeywordMatches, afFieldHaystackRaw, afFieldHaystackCompact } = s;

  const email = afGuessConcept({
    name: "email",
    id: "user_email",
    label: "Email",
    placeholder: "",
    ariaLabel: "",
    autocomplete: "email",
    type: "email",
  });
  assert(email && email.key === "email", "guess email");

  const linkedin = afGuessConcept({
    name: "",
    id: "",
    label: "LinkedIn Profile URL",
    placeholder: "",
    ariaLabel: "",
    autocomplete: "",
    type: "text",
  });
  assert(linkedin && linkedin.key === "linkedin", "guess linkedin");

  const raw = "by checking this box you consent … stated preferences …";
  const compact = afFieldHaystackCompact(raw);
  assert(!afKeywordMatches(raw, compact, "state"), "state must not match stated");

  const nameRaw = "first name";
  assert(afKeywordMatches(nameRaw, afFieldHaystackCompact(nameRaw), "first name"), "first name phrase");
}

// --- matcher ---
console.log("matcher");
{
  const s = loadScripts(["lib/conceptVocabulary.js", "lib/matcher.js"]);
  const { afMatchFieldsToLibrary, afLibraryKeyCompatibleWithField, afFieldPlatformSignals } = s;

  const library = {
    entries: {
      linkedin: { label: "LinkedIn", value: "https://linkedin.com/in/x" },
      github: { label: "GitHub", value: "https://github.com/x" },
      email: { label: "Email", value: "a@b.com" },
    },
  };

  const fields = [
    {
      afId: "1",
      name: "",
      id: "",
      label: "LinkedIn",
      placeholder: "",
      ariaLabel: "",
      guessedConcept: "linkedin",
      guessedConfidence: 0.9,
      isEssay: false,
      type: "text",
      tag: "input",
    },
    {
      afId: "2",
      name: "",
      id: "",
      label: "GitHub",
      placeholder: "",
      ariaLabel: "",
      guessedConcept: "github",
      guessedConfidence: 0.9,
      isEssay: false,
      type: "text",
      tag: "input",
    },
  ];

  const result = afMatchFieldsToLibrary(fields, library);
  assert(result.mapping["1"] === "https://linkedin.com/in/x", "linkedin maps to linkedin value");
  assert(result.mapping["2"] === "https://github.com/x", "github maps to github value");

  const signalsLi = afFieldPlatformSignals(fields[0]);
  assert(
    !afLibraryKeyCompatibleWithField("github", library.entries.github, signalsLi),
    "github key rejected for linkedin field"
  );
}

// --- essay heuristic (from fieldDetection — needs minimal DOM stubs for collect, test pure helpers) ---
console.log("fieldDetection pure helpers");
{
  // Load only pure functions by evaluating selected logic via concept + a thin test of essay keywords
  // We load fieldDetection with a fake document so parse succeeds.
  const sandbox = {
    console,
    CSS: { escape: (s) => String(s) },
    document: {
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getElementById() {
        return null;
      },
    },
    window: {},
  };
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // conceptVocabulary first for afGuessConcept
  vm.runInContext(fs.readFileSync(path.join(root, "lib/conceptVocabulary.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "lib/fieldDetection.js"), "utf8"), sandbox);

  assert(sandbox.afIsEssayQuestion({ tag: "textarea", label: "Why do you want to work here?", placeholder: "", ariaLabel: "" }), "essay why");
  assert(
    !sandbox.afIsEssayQuestion({ tag: "textarea", label: "LinkedIn Profile URL", placeholder: "", ariaLabel: "" }),
    "linkedin textarea not essay"
  );
  assert(sandbox.afNormalizeLabelText("  a   b  ") === "a b", "normalize label");
  assert(sandbox.afHaystackMentionsResume("Upload CV required"), "resume phrase");
  assert(sandbox.afHaystackMentionsNonResumeFile("Additional files"), "non-resume additional");
}

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
