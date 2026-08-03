#!/usr/bin/env node
// Regenerates the "Generated metadata" section in AGENTS.md (message types + line counts).
// No dependencies. Usage: node scripts/update-agents-meta.js

"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const agentsPath = path.join(root, "AGENTS.md");

const MARK_START = "<!-- BEGIN GENERATED META -->";
const MARK_END = "<!-- END GENERATED META -->";

function walkJs(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "vendor") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkJs(p, out);
    else if (name.endsWith(".js") && !p.includes(`${path.sep}vendor${path.sep}`)) out.push(p);
  }
  return out;
}

function countLines(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text) return 0;
  return text.split(/\n/).length;
}

function collectMessageTypes(files) {
  const set = new Set();
  const re = /\bAF_[A-Z][A-Z0-9_]+\b/g;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    let m;
    while ((m = re.exec(text))) {
      const t = m[0];
      // skip non-message constants that are still AF_*
      if (
        t === "AF_DEFAULT_SETTINGS" ||
        t === "AF_LIBRARY_KEY" ||
        t === "AF_SETTINGS_KEY" ||
        t === "AF_SCHEMA_VERSION" ||
        t === "AF_SCHEMA_VERSION_KEY" ||
        t === "AF_FIELD_ATTR" ||
        t === "AF_GEMINI_ENDPOINT" ||
        t === "AF_CONCEPTS" ||
        t === "AF_PROFILE_LINK_CONCEPTS" ||
        t === "AF_ESSAY_KEYWORDS" ||
        t === "AF_RESUME_PHRASES" ||
        t === "AF_NON_RESUME_FILE_PHRASES" ||
        t === "AF_CONTENT_SCRIPT_FILES" ||
        t === "AF_GEMINI_MATCH_CACHE" ||
        t === "AF_GEMINI_MATCH_CACHE_MAX" ||
        t === "AF_POPUP_SESSION_TTL_MS" ||
        t === "AF_COMMAND_AUTOFILL" ||
        t === "AF_COMMAND_SAVE" ||
        t === "AF_COMMAND_AUTO_SEARCH" ||
        t === "AF_HINT_HOST_ID" ||
        t === "AF_TOAST_HOST_ID" ||
        t === "AF_SCAN_DEBOUNCE_MS" ||
        t === "AF_IS_TOP_FRAME"
      ) {
        continue;
      }
      if (t.startsWith("AF_") && t === t.toUpperCase()) set.add(t);
    }
  }
  return [...set].sort();
}

function buildSection(files, messages) {
  const rel = (f) => path.relative(root, f).split(path.sep).join("/");
  const rows = files
    .map((f) => ({ f: rel(f), n: countLines(f) }))
    .sort((a, b) => b.n - a.n || a.f.localeCompare(b.f));

  const total = rows.reduce((s, r) => s + r.n, 0);
  const lines = [];
  lines.push(MARK_START);
  lines.push("");
  lines.push("### Generated metadata (do not edit by hand)");
  lines.push("");
  lines.push(`_Updated by \`node scripts/update-agents-meta.js\` · ${new Date().toISOString().slice(0, 10)}_`);
  lines.push("");
  lines.push("#### Line counts (non-vendor JS)");
  lines.push("");
  lines.push("| File | Lines |");
  lines.push("|------|------:|");
  for (const r of rows) {
    lines.push(`| \`${r.f}\` | ${r.n} |`);
  }
  lines.push(`| **Total** | **${total}** |`);
  lines.push("");
  lines.push("#### Message-like `AF_*` identifiers");
  lines.push("");
  lines.push(messages.map((m) => `\`${m}\``).join(", "));
  lines.push("");
  lines.push(MARK_END);
  return lines.join("\n");
}

function main() {
  const files = walkJs(root);
  const messages = collectMessageTypes(files);
  const section = buildSection(files, messages);

  let agents = fs.readFileSync(agentsPath, "utf8");
  if (agents.includes(MARK_START) && agents.includes(MARK_END)) {
    agents = agents.replace(
      new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`),
      section
    );
  } else {
    agents = agents.trimEnd() + "\n\n" + section + "\n";
  }
  fs.writeFileSync(agentsPath, agents);
  console.log(`Updated AGENTS.md (${files.length} files, ${messages.length} AF_* ids)`);
}

main();
