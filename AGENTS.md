# AGENTS.md

This document captures architecture decisions, conventions, and guidelines for AI agents working on this repo. Update it after each commit to keep future agents aligned.

## Architecture

**Manifest V3 Chrome extension** · vanilla JS · no build step · no npm

```
filler/
├── manifest.json              # MV3 manifest (permissions, content scripts, background, commands)
├── background/
│   └── service-worker.js      # Keyboard shortcuts + fill requests from hint + storage migrate
├── content/
│   └── content-script.js      # DOM IO, auto-search, hint/toast UI
├── lib/
│   ├── af.js                  # Global AF namespace bootstrap (classic scripts)
│   ├── fieldDetection.js      # Scan / labels / essay / resume heuristics (DOM reads)
│   ├── fieldActions.js        # afApplyValues / afPlaceFile (DOM writes)
│   ├── fieldDetector.js       # Shim (docs only) — load detection + actions instead
│   ├── matcher.js             # Rule-based matching (offline, fast)
│   ├── conceptVocabulary.js   # Vocabulary for concept guessing
│   ├── geminiClient.js        # Gemini API + in-memory match session cache
│   ├── autofillEngine.js      # Shared fill pipeline (popup + background)
│   ├── storage.js             # chrome.storage.local + schema version migrate
│   └── resumeParser.js        # PDF/DOCX text extraction
├── popup/                     # AF.popup.* modules (classic scripts, no bundler)
│   ├── els.js util.js session.js library.js autofill.js essay.js popup.js
├── options/
├── test/run.js                # Zero-dep node unit tests
├── .github/workflows/ci.yml   # node --check + test/run.js
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

### UI (v1.4.0 / v1.5.0)

- Dark, Linear/Raycast-inspired design system (CSS variables, no build tools)
- Popup + options share accent gradient (`#5b6cff` → `#9b6dff`)
- Floating page hint/toast restyled to match
- No npm UI kits (shadcn/DaisyUI would need a bundler) — pure vanilla CSS

**Popup library browser (v1.5.0):**
- Toggle via header 🔍, footer pill, or `/` — swaps main view for search/edit without growing the shell
- Search lives **in the header** (replaces brand); clear × appears **inside** the input when non-empty
- List: copy value / edit label+value (debounced save) / delete
- **Height lock:** before swap, lock `.af-app` to current height capped at `--af-popup-max-h` (600px) and `window.innerHeight` — only `.af-library-browser-list` scrolls (no double scroll after tall autofill UI)
- Tall main mode (essay + resume picker): scroll only inside `.af-main-view`
- Footer pill: `padding-top: 10px` above counter in both modes; scroll areas use right padding + `scrollbar-gutter: stable` so the bar does not hug cards (main, essay, preview, resume menu, library list)
- **MV3 popup rounding:** Chrome draws an opaque rectangular host — true transparent/rounded window is impossible. Do **not** use body margin + transparent (ugly white frame). Fill host with `--af-bg` edge-to-edge; radius only on inner controls

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
- Then previous sibling / direct-child **`<label>`, `<legend>`, or `h1`–`h4`** (join.com puts the question in `<h2>LinkedIn Profile URL</h2>` next to a bare `<textarea>`)
- Weak fallback: short previous sibling text / parent text without controls
- **Never use validation copy as the label** — strip `[data-part=error-text]`, `.chakra-field__errorText`, `[data-testid=FormError]`, and reject texts like "Please enter the answer" / "required"
- Example: `<div><label>Resume / Dossier</label><div><input type=file class="opacity-0"></div></div>`
- Example (join.com): `<div><h2>LinkedIn Profile URL</h2><div><textarea></textarea><span>Please enter the answer</span></div></div>` → label is the h2, not the error

**Resume/CV file detection** (v1.3.1, tightened v1.4.2):
- Place the saved CV **only** into primary resume/CV inputs — never into "Additional files", cover-letter files, portfolio, photo, etc.
- **Primary signals** (id/name/label): hard-accept `resume` / whole-word `cv` / `curriculum` / `dossier` / `lebenslauf` / `резюме` (e.g. Teamtailor `candidate_resume_remote_url` + "Upload CV")
- **Hard-reject** primary/local label: `additional files`, `other attachments`, `supporting documents`, `cover letter`, `portfolio`, `work samples`, photo/avatar, …; also Teamtailor `candidate_file_remote_url` (not `resume_…`)
- Nearby text is **local field-group only** — do not clone whole `<form>` (sibling "Upload CV" + privacy policy used to poison "Additional files")
- Unlabeled dropzone: only if `accept` is document-like **and** upload chrome; empty `accept` + "Drop your file" alone is not enough
- If multiple file inputs match but at least one is high-confidence (id/name/label says resume/CV), auto-place **only** into high-confidence fields
- Reject pure image/video/audio accept lists
- Opacity-0 overlay inputs allowed if parent is visible
- Cover letter is **not** a resume target (textarea → essay panel; file → never auto-CV)

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

**Keyword matching (v1.5.0):**
- Always use **word boundaries** on raw haystack — `"state"` must not match inside `"stated preferences"` (Ashby consent checkbox)
- Prefer label/aria/placeholder over long `name=` / `id=` (clip name/id to ~64 chars — legal paragraphs in `name` poison guessing)
- Compact substring match only for short machine-ish field ids, never long prose

### Save to library (v1.5.0)

`afBuildLibrarySaveItems` / `afIsJunkLibraryField` in `autofillEngine.js` (popup preview + silent shortcut):

- **Hide unchanged** — same library key + same normalized value → do not show in Save review
- **Show updates** — same key, different value → badge `update`, checked by default
- **Skip junk:** checkboxes/radios, confirm-email, consent/privacy/marketing, bare `on`/`true` values
- **Dedupe by key** in one save batch (email + "Confirm your email" → one row)
- Status line reports: new / updates / already saved (hidden) / skipped

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

### Classic-script modularity (v1.6.0)

- No bundler: split via **file order + `AF` namespace / `self.*` globals**
- **fieldDetection.js** (reads) vs **fieldActions.js** (writes) — test detection helpers without firing DOM events
- **popup/** modules: `els` → `util` → `session` → `library` → `autofill` → `essay` → `popup.js` bootstrap
- Register on `AF.popup.*` and re-export globals for compatibility

### Storage schema versioning (v1.6.0)

- Key `af_schema_version` (current: **1**)
- `afMigrateStorageIfNeeded()` on service worker start and popup open
- When changing `entries[key]` shape: bump version and add a migration step

### Gemini match cache (v1.6.0)

- In-memory map in `geminiClient.js`: hash(fields metadata + library keys + model) → matches
- Session-only (cleared when SW dies); avoids repeat API calls on same form
- `afGeminiMatchCacheClear()` if library edits need invalidation later

### Tests & CI (v1.6.0)

- `node test/run.js` — matcher, vocabulary, fieldDetection pure helpers (no npm)
- GitHub Actions: `node --check` all non-vendor JS + unit tests on push/PR

### Optional host permissions (v1.7.0)

- **No required `host_permissions: <all_urls>`** — uses `optional_host_permissions` + `activeTab` + `scripting`
- On Autofill/Save/auto-search: `afEnsurePageAccess(tab)` → optional origin grant + inject content stack if needed
- Content script guard `__AF_CONTENT_SCRIPT__` prevents double listeners on re-inject
- `AF_PING` probes live CS; `lib/permissions.js` shared by popup + service worker
- Auto-search only works on origins the user has allowed (install UX + CWS review friendlier)

### Session cleanup (v1.7.0)

- Single entry: `afClearSessionData(reason, { tabId })` in service worker
- Listeners only dispatch reasons: `tab-activated` | `url` | `tab-removed`

### SPA URL detect (v1.7.0)

- No `location.href` polling; `history.pushState` / `replaceState` monkey-patch + `popstate` / `hashchange`
- Scans still gated on `afAutoSearchEnabled`

### Tooling (v1.7.0)

- `node scripts/update-agents-meta.js` — regenerates line counts + AF_* list in AGENTS.md
- `bash scripts/check.sh` — syntax + tests + agents meta (local pre-commit style)

### Secrets

- `geminiApiKey` only in `chrome.storage.local` via `afSetSettings`
- `afStripSecretsForSync(settings)` strips the key if anything ever writes to `storage.sync`

### Application tracker (v1.8.0)

- Content: form submit / Apply click / thank-you page → scrape job meta + Q&A → `AF_APPLICATION_TRACKED`
- Storage: `af_applications[]` (schema v2), dedupe same URL within 24h
- Options UI: Applications table (when, job, link, Q&A, delete)

### Essay grounding (v1.8.0)

- Gemini essay returns JSON `{ answer, sources: [{ source: resume|context, quote }] }`
- Popup shows green grounding panel under each generated answer

### Cross-browser (v1.8.0)

- Vendored `lib/vendor/browser-polyfill.min.js` first in content / popup / options / SW
- `browser_specific_settings.gecko` for Firefox; Edge uses Chromium APIs + polyfill

## Current state

- **Version:** 1.8.0
- **Last change:** Application tracker, essay grounding UI, webextension-polyfill for Firefox/Edge
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
10. **Test in browser** — no automated tests; verify on Greenhouse / Teamtailor / join.com / Ashby after reload
11. **Check syntax with `node --check <file>`** — catches typos before commit; CI also runs this
12. **Run `node test/run.js`** before push when touching matcher / vocabulary / detection
13. **Use English comments and English UI strings** — match existing style (concept vocabulary keywords may include other languages for form matching)
14. **Do not try true rounded MV3 popup windows** — host is opaque rectangle; full-bleed dark only
15. **Save preview must hide library-identical values** — use `afBuildLibrarySaveItems`, don't re-list all filled fields
16. **Bump `AF_SCHEMA_VERSION` + migration** when changing storage shapes
17. **Keep popup module load order** in `popup.html` — do not introduce ES modules without a bundler

## Known limitations

- No automated tests — manual testing only
- No build step — can't use modern JS features (ES modules, etc.) without a bundler
- Service worker uses `importScripts` (classic scripts) — can't use top-level await or dynamic imports
- Content script can't access `chrome.storage` directly in some contexts — use message passing or `chrome.storage.local.get` in content script
- `Date.now()` works in content script but not in service worker (restricted APIs)
- **Chrome action popup shape cannot be customized** (no real transparent rounded corners on `popup.html`)
- Real rounded "floating" UI requires abandoning `default_popup` for a content-script overlay (Keep-style) — not implemented

## How to update this file

After each commit:
1. Add new decisions under "Decisions" with the version tag
2. Update "Current state" with the new version and last commit
3. Add any new conventions or recommendations
4. Remove outdated information

<!-- BEGIN GENERATED META -->

### Generated metadata (do not edit by hand)

_Updated by `node scripts/update-agents-meta.js` · 2026-08-03_

#### Line counts (non-vendor JS)

| File | Lines |
|------|------:|
| `lib/fieldDetection.js` | 750 |
| `lib/autofillEngine.js` | 561 |
| `content/content-script.js` | 536 |
| `popup/library.js` | 352 |
| `popup/autofill.js` | 339 |
| `background/service-worker.js` | 329 |
| `lib/storage.js` | 326 |
| `options/options.js` | 311 |
| `lib/geminiClient.js` | 280 |
| `lib/matcher.js` | 248 |
| `popup/essay.js` | 204 |
| `lib/conceptVocabulary.js` | 196 |
| `test/run.js` | 189 |
| `lib/applicationTracker.js` | 182 |
| `lib/fieldActions.js` | 136 |
| `popup/popup.js` | 133 |
| `lib/permissions.js` | 130 |
| `scripts/update-agents-meta.js` | 125 |
| `popup/session.js` | 115 |
| `popup/els.js` | 93 |
| `lib/resumeParser.js` | 59 |
| `popup/util.js` | 27 |
| `lib/af.js` | 12 |
| `lib/fieldDetector.js` | 6 |
| **Total** | **5639** |

#### Message-like `AF_*` identifiers

`AF_APPLICATIONS_KEY`, `AF_APPLICATION_TRACKED`, `AF_APPLY_VALUES`, `AF_ENSURE_PAGE_ACCESS`, `AF_FRAME_DOM_CHANGED`, `AF_GET_COMMAND_SHORTCUT`, `AF_PING`, `AF_PLACE_FILE`, `AF_RESCAN_HINT`, `AF_RUN_AUTOFILL`, `AF_RUN_SAVE_LIBRARY`, `AF_SCAN_FIELDS`, `AF_SCAN_TAB`, `AF_SET_AUTO_SEARCH`, `AF_TOAST`

<!-- END GENERATED META -->
