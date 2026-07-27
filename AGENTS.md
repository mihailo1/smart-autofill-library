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

### Multi-frame forms (v1.3.0)

Many job applications embed the real form in a **cross-origin iframe** (e.g. Greenhouse on `job-boards.greenhouse.io` inside `fuga.com`). Top-document `querySelectorAll` cannot see those fields.

- **`all_frames: true`** on content scripts — inject into every frame matching `<all_urls>`
- **`webNavigation` permission** — `chrome.webNavigation.getAllFrames` lists frameIds
- **`afScanTab` / `afApplyValuesOnTab` / `afPlaceFileOnTab`** in `autofillEngine.js` — fan-out messages with `{ frameId }`, attach `frameId` to each field metadata
- **Top frame only** for hint/toast/auto-search UI (`window === window.top`); nested frames only answer scan/apply/place
- **Auto-search** top frame calls background `AF_SCAN_TAB` so iframe fields count toward the hint
- Nested frames (when auto-search on) notify `AF_FRAME_DOM_CHANGED` → top `AF_RESCAN_HINT`
- Apply/essay restore must preserve **`frameId`** with each `afId` so values land in the right document

### Auto-search mode (v1.2.0)

- **MutationObserver** on `childList + subtree` (not attributes, to reduce noise on SPAs)
- **600ms debounce** on scan to avoid thrashing
- **Shadow DOM** for hint and toast to avoid breaking page styles
- **Hint dismissed per URL** — reset on SPA navigation or setting change
- **SPA navigation** detected via `setInterval` polling `location.href` (gated on `autoSearchMode`, not always running)
- **Count only empty fields** — pre-filled fields don't inflate the hint count or keep it visible after filling

### Keyboard shortcuts (v1.2.0 / v1.4.0)

- `Alt+Shift+A` — autofill from library
- `Alt+Shift+S` — save filled fields to library (no preview)
- `Alt+Shift+F` — toggle auto-search mode (v1.4.0)
- Handled by background service worker via `chrome.commands.onCommand`
- Service worker uses `importScripts` to load shared libs (MV3 classic scripts, no ES modules)

### UI (v1.4.0)

- Dark, Linear/Raycast-inspired design system (CSS variables, no build tools)
- Popup + options share accent gradient (`#5b6cff` → `#9b6dff`)
- Floating page hint/toast restyled to match
- No npm UI kits (shadcn/DaisyUI would need a bundler) — pure vanilla CSS

### Shared autofill engine (v1.2.0)

- `lib/autofillEngine.js` — single pipeline: scan → rules → Gemini → apply → resume
- Used by both popup and background (no code duplication)
- **Fill status denominator uses only empty fields** — honest "Filled X of Y fields" message
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
- File inputs only for resume upload detection

**Label finding** (modern React/Next forms often lack `for=` / wrapping `<label>`):
- Prefer `label[for]`, wrapping label, `aria-labelledby` / `aria-label`
- Then previous sibling `<label>` and `:scope > label` on ancestors (up to 5 levels)
- Fallback: short previous sibling text / parent text without controls
- Example: `<div><label>Resume / Dossier</label><div><input type=file class="opacity-0"></div></div>`

**Resume/CV file detection** (v1.3.1):
- Nearby text (not just input attrs): `resume`, `cv` (word), `dossier`, `curriculum`, `резюме`, …
- OR dropzone chrome: `upload`/`attach` + `pdf`/`docx` (even with empty `accept` and no name/id)
- OR `accept` includes pdf/doc
- Reject pure image/video/audio accept lists
- Opacity-0 overlay inputs allowed if parent is visible

**Essay detection** (heuristic):
- `textarea` + (question mark OR essay keywords OR long prompt)

### Matching strategy

1. **Rules first** (`matcher.js` + `conceptVocabulary.js`) — free, offline, fast
2. **Gemini fallback** for unmatched *profile* fields — only metadata sent (name/id/label/placeholder/type + library keys)
3. **Library values never leave the device** — privacy by design

**Social / URL specificity (v1.3.2):**
- Separate concepts: `linkedin`, `github`, `twitter`, `portfolio`, `website`
- Keyword priority: platform-specific beats generic (`linkedin` > `portfolio` > `website`)
- Never use bare keyword `url` (false-positive on "LinkedIn / Portfolio URL")
- Do not fill LinkedIn fields with GitHub values (and vice versa)
- **Essay/open-ended textareas are never auto-filled from the profile library** (or Gemini key-matching) — they go to the ✨ AI answer panel only

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

- **Comments:** English
- **Identifiers:** English (camelCase for functions, kebab-case for files)
- **User-facing strings:** English (status messages, UI labels, tooltips)
- **Function prefix:** `af` for all extension functions (global scope in service worker/content script)
- **Message types:** `AF_*` (e.g., `AF_SCAN_FIELDS`, `AF_APPLY_VALUES`, `AF_TOAST`)
- **No TypeScript, no build tools, no npm**
- **No external dependencies** (except pdf.js and mammoth.js in `vendor/`)
- **Concept vocabulary keywords:** include Russian terms for matching fields on Russian-language sites

## Current state

- **Version:** 1.4.1
- **Last change:** Compact shortcut chips; auto-search shortcut only in bottom row
- **Language:** all code, comments, and UI strings in English

## Recommendations for future agents

1. **Keep content-script as the only DOM-touching code** — don't add DOM logic to popup/background/libs
2. **Use Shadow DOM for any page-injected UI** — avoids style conflicts
3. **Use `textContent` for dynamic content** (never innerHTML) — XSS prevention
4. **Keep autofillEngine as the single fill pipeline** — don't duplicate fill logic in popup/background
5. **Library values must never leave the device** — only send metadata to Gemini
6. **Rules first, Gemini fallback** — keep matching fast and offline-first
7. **Always scan/apply via multi-frame helpers** (`afScanTab`, `afApplyValuesOnTab`) — never assume fields are only in the top document
8. **Preserve `frameId` with every field** when applying values or restoring essay state
9. **Update this file after each commit** — keep decisions and state current
10. **Test in browser** — no automated tests; verify on a Greenhouse embed (e.g. fuga.com/jobs) after reload
11. **Check syntax with `node --check <file>`** — catches typos before commit
12. **Use English comments and English UI strings** — match existing style (concept vocabulary keywords may include other languages for form matching)

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
