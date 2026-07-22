# AGENTS.md

This document captures architecture decisions, conventions, and guidelines for AI agents working on this repo. Update it after each commit to keep future agents aligned.

## Architecture

**Manifest V3 Chrome extension** · vanilla JS · no build step · no npm

```
filler/
├── manifest.json              # MV3 manifest (permissions, content scripts, background, commands)
├── background/
│   └── service-worker.js      # Keyboard shortcuts + fill requests from hint
├── content/
│   └── content-script.js      # DOM IO, auto-search, hint/toast UI
├── lib/
│   ├── fieldDetector.js       # Field scanning, concept guessing, apply (only DOM-touching code)
│   ├── matcher.js             # Rule-based matching (offline, fast)
│   ├── conceptVocabulary.js   # Vocabulary for concept guessing
│   ├── geminiClient.js        # Gemini API calls (matching, classification, essay generation)
│   ├── autofillEngine.js      # Shared fill pipeline (popup + background)
│   ├── storage.js             # chrome.storage.local wrapper
│   └── resumeParser.js        # PDF/DOCX text extraction
├── popup/                     # Orchestrator UI
├── options/                   # Settings, resumes, context, library
└── icons/
```

### Key principle

**Content script is the only code that touches the page DOM.** It doesn't store state, call Gemini, or read the library directly. All orchestration happens in popup or background, which communicate with the content script via messages.

## Decisions

### Auto-search mode (v1.2.0)

- **MutationObserver** on `childList + subtree` (not attributes, to reduce noise on SPAs)
- **600ms debounce** on scan to avoid thrashing
- **Shadow DOM** for hint and toast to avoid breaking page styles
- **Hint dismissed per URL** — reset on SPA navigation or setting change
- **SPA navigation** detected via `setInterval` polling `location.href` (gated on `autoSearchMode`, not always running)
- **Count only empty fields** — pre-filled fields don't inflate the hint count or keep it visible after filling

### Keyboard shortcuts (v1.2.0)

- `Alt+Shift+A` — autofill from library
- `Alt+Shift+S` — save filled fields to library (no preview)
- Handled by background service worker via `chrome.commands.onCommand`
- Service worker uses `importScripts` to load shared libs (MV3 classic scripts, no ES modules)

### Shared autofill engine (v1.2.0)

- `lib/autofillEngine.js` — single pipeline: scan → rules → Gemini → apply → resume
- Used by both popup and background (no code duplication)
- **Fill status denominator uses only empty fields** — honest "Заполнено X из Y" message
- Exports functions to `self.*` for service worker scope

### Content script isolation

- **Only code that touches DOM** — field scanning, value application, hint/toast rendering
- Uses `textContent` (never innerHTML) for dynamic content — XSS prevention
- All UI (hint, toast) in **Shadow DOM** — avoids style conflicts
- Tracks fields via `data-af-id` attribute
- Exports functions to `self.*` for content script scope

### Field detection rules

**Excludes:**
- `password`, `hidden`, `disabled`, `readonly`, `submit`, `button`, `reset` inputs
- `display:none` or `visibility:hidden` (via `getClientRects().length === 0`)

**Includes:**
- Regular inputs, textareas, selects (if visible and enabled)
- File inputs only for resume upload detection (PDF/DOCX accept + resume keywords)

**Essay detection** (heuristic):
- `textarea` + (question mark OR essay keywords OR long prompt)

### Matching strategy

1. **Rules first** (`matcher.js` + `conceptVocabulary.js`) — free, offline, fast
2. **Gemini fallback** for unmatched fields — only metadata sent (name/id/label/placeholder/type + library keys)
3. **Library values never leave the device** — privacy by design

### Storage

- `chrome.storage.local` — library, settings, resumes
- Resumes stored as **base64** (no external upload)
- Storage keys: `af_*` (e.g., `af_settings`, `af_library`)

### Service worker

- Uses `importScripts` to load shared libs (not ES modules)
- Paths relative to `background/service-worker.js` (e.g., `../lib/storage.js`)
- Handles `chrome.commands.onCommand` for shortcuts
- Handles messages: `AF_RUN_AUTOFILL`, `AF_RUN_SAVE_LIBRARY`, `AF_GET_COMMAND_SHORTCUT`

## Conventions

- **Comments:** Russian
- **Identifiers:** English (camelCase for functions, kebab-case for files)
- **Function prefix:** `af` for all extension functions (global scope in service worker/content script)
- **Message types:** `AF_*` (e.g., `AF_SCAN_FIELDS`, `AF_APPLY_VALUES`, `AF_TOAST`)
- **No TypeScript, no build tools, no npm**
- **No external dependencies** (except pdf.js and mammoth.js in `vendor/`)

## Current state

- **Version:** 1.2.0
- **Last commit:** Add auto-search hint, keyboard shortcuts, and background service worker
- **Tree:** clean

## Recommendations for future agents

1. **Keep content-script as the only DOM-touching code** — don't add DOM logic to popup/background/libs
2. **Use Shadow DOM for any page-injected UI** — avoids style conflicts
3. **Use `textContent` for dynamic content** (never innerHTML) — XSS prevention
4. **Keep autofillEngine as the single fill pipeline** — don't duplicate fill logic in popup/background
5. **Library values must never leave the device** — only send metadata to Gemini
6. **Rules first, Gemini fallback** — keep matching fast and offline-first
7. **Update this file after each commit** — keep decisions and state current
8. **Test in browser** — no automated tests, so manually verify in Chrome DevTools
9. **Check syntax with `node --check <file>`** — catches typos before commit
10. **Use Russian comments, English identifiers** — match existing style

## Known limitations

- No automated tests — manual testing only
- No build step — can't use modern JS features (ES modules, etc.) without a bundler
- Service worker uses `importScripts` (classic scripts) — can't use top-level await or dynamic imports
- Content script can't access `chrome.storage` directly in some contexts — use message passing or `chrome.storage.local.get` in content script
- `Date.now()` works in content script but not in service worker (restricted APIs)

## How to update this file

After each commit:
1. Add new decisions under "Decisions" with the version tag
2. Update "Current state" with the new version and last commit
3. Add any new conventions or recommendations
4. Remove outdated information
