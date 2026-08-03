# Smart Autofill Library — полная структура проекта

> Документ для копирования / онбординга. Описывает репозиторий **как есть** (ветка `main`, версия расширения **1.6.0**).  
> Путь: `~/Documents/reps.nosync/filler`  
> GitHub: `https://github.com/mihailo1/smart-autofill-library.git`  
> Лицензия: MIT  
> Стек: **Chrome Manifest V3 · vanilla JS · без npm / без сборки**

---

## 1. Что это за продукт

Chrome-расширение **Smart Autofill Library**:

1. Сохраняет заполненные поля форм в **локальную библиотеку** (`chrome.storage.local`).
2. При следующем заходе на форму **заполняет** поля:
   - сначала **офлайн-правила** (`matcher` + vocabulary);
   - потом **Gemini** как fallback для матчинга и для ответов на open-ended вопросы.
3. Умеет **класть резюме** (PDF/DOCX) в file-input или Form.io-dropzone.
4. Все **значения** библиотеки **не уходят** в Gemini — только метаданные полей и ключи/labels.

---

## 2. Дерево файлов (полная)

```
filler/
├── manifest.json                 # MV3: permissions, content_scripts, background, commands, popup, options
├── README.md                     # Пользовательская документация
├── AGENTS.md                     # Архитектура и правила для AI-агентов (держать в актуальном состоянии)
├── PROJECT_STRUCTURE.md          # Этот файл
├── LICENSE                       # MIT
├── .gitignore
│
├── background/
│   └── service-worker.js         # Shortcuts, сообщения от hint/popup, очистка popup-session
│
├── content/
│   └── content-script.js         # DOM IO на странице, auto-search, hint, toast (all_frames)
│
├── lib/                          # Общая логика (классические скрипты, global self.*)
│   ├── af.js                     # AF namespace bootstrap
│   ├── fieldDetection.js         # DOM reads: scan / labels / essay / resume / dropzones
│   ├── fieldActions.js           # DOM writes: afApplyValues / afPlaceFile
│   ├── fieldDetector.js          # Shim (docs); load detection+actions
│   ├── conceptVocabulary.js      # Словарь концептов + afGuessConcept
│   ├── matcher.js                # Rules-first matching library ↔ fields
│   ├── geminiClient.js           # Gemini API + session match cache
│   ├── autofillEngine.js         # Multi-frame pipeline: scan → match → apply → resume
│   ├── storage.js                # library + settings + schema migrate (v1)
│   ├── resumeParser.js           # PDF (pdf.js) / DOCX (mammoth) → text
│   └── vendor/                   # pdf.min.js, pdf.worker.min.js, mammoth.browser.js
│
├── popup/                        # AF.popup.* modules (classic script order)
│   ├── popup.html / popup.css
│   ├── els.js util.js session.js library.js autofill.js essay.js
│   └── popup.js                  # bootstrap + restore session
│
├── options/
├── test/run.js                   # zero-dep node tests
├── .github/workflows/ci.yml
└── icons/
```

**Нет:** `package.json`, webpack/vite, TypeScript. Есть: `node test/run.js` + GitHub Actions.

---

## 3. Архитектурный принцип

```
┌──────────────────────────── Web page ────────────────────────────┐
│  top frame + cross-origin iframes (Greenhouse, Form.io, …)       │
│  content-script (all_frames) + fieldDetector                     │
│  hint/toast только в top frame (Shadow DOM)                      │
└──────────────────────────▲──────────────▲────────────────────────┘
                           │ messages     │ scan / apply / place
┌──────────────────────────┴──────────────┴────────────────────────┐
│  popup (UI orchestrator)     │  background service worker        │
│  · Autofill / Save           │  · Alt+Shift+A/S/F                │
│  · Essay panel ✨            │  · AF_RUN_AUTOFILL from hint      │
│  · Library browser           │  · AF_SCAN_TAB                    │
│  · Gemini from popup         │  · popup session TTL cleanup      │
└──────────────────────────┬───────────────────────────────────────┘
                           ▼
              lib/autofillEngine.js
                 rules → Gemini → apply → resume
```

### Жёсткие правила

| Правило | Смысл |
|--------|--------|
| **Только content + fieldDetector трогают DOM страницы** | popup/background не делают `querySelector` на tab document |
| **`af` prefix** | все глобальные функции: `afCollectFields`, `afScanTab`, … |
| **`AF_*` messages** | типы сообщений между частями расширения |
| **Library values never leave device** | в Gemini — metadata + keys/labels, не email/phone/text values |
| **Rules first** | Gemini только для unmatched / essays / classification |
| **Multi-frame** | всегда `afScanTab` / `afApplyValuesOnTab` / `afPlaceFileOnTab` с `frameId` |

---

## 4. `manifest.json` (MV3)

| Секция | Значение |
|--------|----------|
| `version` | `1.5.1` |
| `permissions` | `storage`, `unlimitedStorage`, `activeTab`, `scripting`, `webNavigation` |
| `host_permissions` | `<all_urls>` |
| `background.service_worker` | `background/service-worker.js` |
| `action.default_popup` | `popup/popup.html` |
| `options_page` | `options/options.html` |
| `content_scripts` | `conceptVocabulary.js` → `fieldDetector.js` → `content-script.js` |
| content flags | `all_frames: true`, `run_at: document_idle` |
| `commands` | `af-autofill` Alt+Shift+A, `af-save-library` Alt+Shift+S, `af-toggle-auto-search` Alt+Shift+F |
| `web_accessible_resources` | `lib/vendor/pdf.worker.min.js` |

Content scripts — **классические** (не ES modules): порядок в массиве = порядок загрузки.

---

## 5. Потоки данных

### 5.1 Autofill (popup или shortcut)

1. `afScanTab(tabId)` → все frameIds через `webNavigation.getAllFrames`
2. В каждом frame: `AF_SCAN_FIELDS` → `afCollectFields()` → `{ fields, resumeUploadFields }` + `frameId`
3. `afMatchFieldsToLibrary` (rules)
4. Неmatched (не essay) → `afCallGeminiForMatching` (только metadata)
5. `afApplyValuesOnTab` → `AF_APPLY_VALUES` per frame
6. Essay → panel ✨ в popup
7. Resume fields → picker → `afPlaceFileOnTab` → `AF_PLACE_FILE`

### 5.2 Save to library

1. Scan filled non-essay fields
2. Gemini classification для unclassified (optional)
3. `afBuildLibrarySaveItems` — hide identical, skip junk, dedupe keys
4. Preview UI → `afSaveEntries`

### 5.3 Auto-search hint (top frame)

1. Setting `autoSearchMode`
2. MutationObserver + debounce 600ms
3. Nested frame → `AF_FRAME_DOM_CHANGED` → top `AF_RESCAN_HINT`
4. Top may call background `AF_SCAN_TAB` for multi-frame count
5. Hint click → background `AF_RUN_AUTOFILL`

---

## 6. Содержание основных файлов

### 6.1 `background/service-worker.js` (~253 lines)

**Роль:** service worker; `importScripts` подтягивает storage, vocabulary, matcher, gemini, autofillEngine.

**Команды:**

- `af-autofill` → `afRunAutofillOnActiveTab`
- `af-save-library` → `afSaveTabToLibrary`
- `af-toggle-auto-search` → flip setting + toast

**Сообщения:**

| type | Действие |
|------|----------|
| `AF_RUN_AUTOFILL` | autofill tab |
| `AF_RUN_SAVE_LIBRARY` | silent save |
| `AF_SCAN_TAB` | multi-frame scan (hint) |
| `AF_FRAME_DOM_CHANGED` | forward `AF_RESCAN_HINT` to top |
| `AF_GET_COMMAND_SHORTCUT` | shortcuts for UI |

**Popup session cleanup (TTL 30 min):**

- `tabs.onActivated` — сменилась вкладка → clear `af_last_preview` / `af_last_essay`
- `tabs.onUpdated` (url) — навигация на session-tab → clear
- `tabs.onRemoved` — закрыли tab → clear

---

### 6.2 `content/content-script.js` (~483 lines)

**Роль:** во **всех** frames. UI (hint/toast) только если `window === window.top`.

**Входящие сообщения:**

| type | Кто | Что |
|------|-----|-----|
| `AF_SCAN_FIELDS` | engine | `afCollectFields()` |
| `AF_APPLY_VALUES` | engine | `afApplyValues(mapping)` |
| `AF_PLACE_FILE` | engine | `afPlaceFile(...)` file input или dropzone |
| `AF_TOAST` | bg/popup | toast (top only) |
| `AF_SET_AUTO_SEARCH` | storage/settings | вкл/выкл observer |
| `AF_RESCAN_HINT` | nested/bg | перескан hint |

**Исходящие:**

- `AF_SCAN_TAB` → background (top, multi-frame count)
- `AF_FRAME_DOM_CHANGED` → background (nested)
- `AF_RUN_AUTOFILL` → background (hint button)

**UI:** Shadow DOM hosts `#af-smart-hint-host`, `#af-smart-toast-host`; `textContent` only.

**Auto-search:** MutationObserver `childList+subtree`, debounce 600ms; SPA via `location.href` poll when enabled.

---

### 6.3 `lib/fieldDetector.js` (~870 lines) — DOM

**Единственный модуль, который ходит по DOM страницы.**

| Функция | Назначение |
|---------|------------|
| `afIsEligibleField` | exclude password/hidden/disabled/file/… + visible |
| `afFindLabelText` | label[for], wrapping, aria, **h1–h4**, strip FormError / «Please enter…» |
| `afCollectNearbyFieldText` | локальный контекст (не весь form) для resume heuristics |
| `afIsEssayQuestion` | textarea + keywords / `?` / long prompt |
| `afIsResumeUploadField` | `input[type=file]` = resume/CV, не Additional files |
| `afFindResumeDropzoneRoots` | Form.io: `.formio-component-cv`, `[ref=fileDrop]`, `.fileSelector` |
| `afFindResumeUploadFields` | file inputs + dropzones; confidence high/medium/low |
| `afCollectFields` | `{ fields, resumeUploadFields }` + `data-af-id` |
| `afApplyValues` | set value + input/change |
| `afPlaceFile` | DataTransfer на file input **или** synthetic drop на Form.io dropzone |

**Поле field meta:**

```js
{
  afId, tag, type, name, id, autocomplete, placeholder, ariaLabel,
  label, value, guessedConcept, guessedConfidence, isEssay
  // + frameId добавляет autofillEngine после scan
}
```

**Resume meta:**

```js
{ afId, tag, type, kind: "file-input"|"dropzone", name, id, label, accept, confidence }
```

---

### 6.4 `lib/conceptVocabulary.js` (~195 lines)

- `AF_CONCEPTS[]` — key, label, autocomplete, keywords (EN+RU), priority  
  Примеры: email, firstName, lastName, fullName, phone, linkedin, github, country, …
- `afGuessConcept(meta)` — autocomplete → keywords (word boundaries)
- `AF_PROFILE_LINK_CONCEPTS` — не заливать essay URL-концептами
- `afValueLooksLikeUrlOrHandle`

**Важно:** keyword matching с word boundaries (`state` ≠ `stated`); name/id длиннее ~64 символов обрезаются (legal text в name=).

---

### 6.5 `lib/matcher.js` (~247 lines)

| Функция | Назначение |
|---------|------------|
| `afMatchFieldsToLibrary` | rules: guessedConcept / library key text / platform signals |
| `afMatchLibraryKeyByText` | linkedin/github priority |
| `afLibraryKeyCompatibleWithField` | не класть github в linkedin field |
| `afFieldsForGeminiMatching` | filter before Gemini |
| `afFilterGeminiMatches` | post-filter unsafe Gemini pairs |

---

### 6.6 `lib/geminiClient.js` (~194 lines)

- Endpoint: `generativelanguage.googleapis.com/v1beta/models`
- Default model from settings: `gemini-flash-lite-latest`
- **`afCallGeminiForMatching`** — fields metadata + library keys → `[{ afId, libraryKey }]`
- **`afCallGeminiForClassification`** — suggest key/label for save
- **`afCallGeminiForEssayAnswer`** — Q + context + resume text → answer (no invented facts)

---

### 6.7 `lib/autofillEngine.js` (~560 lines)

Общий pipeline для **popup** и **service worker**.

| Функция | Назначение |
|---------|------------|
| `afGetTabFrameIds` | `webNavigation.getAllFrames` |
| `afSendFrameMessage` / `afSendTabMessage` / `afSendAllFrames` | messaging |
| `afScanTab` | merge fields + resumeUploadFields + frameId |
| `afApplyValuesOnTab` | group by frameId → AF_APPLY_VALUES |
| `afPlaceFileOnTab` | AF_PLACE_FILE with base64 |
| `afAutofillTab` | full autofill pipeline |
| `afIsJunkLibraryField` | skip checkbox/consent/confirm-email |
| `afBuildLibrarySaveItems` | new/update/unchanged/junk stats for Save UI |
| `afSaveTabToLibrary` | silent save (shortcut) |
| `afSlugFromField` | fallback key `custom_…` |

---

### 6.8 `lib/storage.js` (~128 lines)

**Keys:**

| Key | Содержимое |
|-----|------------|
| `af_library` | `{ entries: { [key]: { label, value, updatedAt, sourceUrl } } }` |
| `af_settings` | API key, model, useGeminiFallback, autoSearchMode, contextText, resumes[], defaultResumeId |

**API:** `afGetLibrary`, `afSetLibrary`, `afSaveEntries`, `afDeleteEntry`, `afGetSettings`, `afSetSettings`, resume CRUD (`afSaveResumeFile`, `afRenameResume`, `afDeleteResume`, `afSetDefaultResume`).

**Resume object:**

```js
{ id, name, fileName, mimeType, dataBase64, textContent, uploadedAt }
```

**Временная popup-сессия (отдельно):**

| Key | Назначение |
|-----|------------|
| `af_last_preview` | Save review items + tabId + sourceUrl + savedAt |
| `af_last_essay` | Essay Q/A + tabId + sourceUrl + savedAt |

TTL **30 минут**; clear при смене tab/URL (background).

---

### 6.9 `lib/resumeParser.js` (~58 lines)

- `afExtractResumeText(file)` → PDF via pdf.js / DOCX via mammoth  
- Используется **только в options** (есть `window` / document)  
- Worker: `chrome.runtime.getURL("lib/vendor/pdf.worker.min.js")`

---

### 6.10 `popup/` — UI оркестратор

#### `popup.html`

- Header: brand **или** library search; 🔍 library toggle; ⚙️ options  
- Main: resume menu, Autofill + Save, auto-search toggle, shortcut chips, status, essay panel, save preview  
- Library view: list only (search in header)  
- Footer: pill «N fields in library»  

Скрипты: vocabulary → storage → matcher → gemini → autofillEngine → popup.js  

#### `popup.js` (~1068 lines) — ключевые зоны

1. **Library mode** — `setLibraryMode`, height lock (`--af-popup-max-h` 600px), search/filter, copy value, edit, delete  
2. **Autofill** — scan → match → gemini → apply → essay → pickResume → place files  
3. **Save** — `afBuildLibrarySaveItems` → preview → `afSaveEntries`  
4. **Essay panel** — ✨ generate, 🧠 save to context, Insert on page  
5. **Session restore** — `afSessionStillValid` (tabId + url + 30min); hide panel ≠ clear storage  

#### `popup.css` (~1058 lines)

- Dark theme CSS variables (`--af-bg`, `--af-accent`, …)  
- Layout: flex column, max-height 600px, main-view scroll / library list scroll  
- Footer padding-top 10px; scrollbar-gutter + right padding  

---

### 6.11 `options/`

| Файл | Содержание |
|------|------------|
| `options.html` | Gemini key/model, auto-search, shortcuts help, field library list, context textarea, resume upload |
| `options.js` | load/save settings, library edit/delete, resume upload+parse, default resume radio |
| `options.css` | та же design system |

---

## 7. Сообщения `AF_*` (сводка)

| Message | Направление | Назначение |
|---------|-------------|------------|
| `AF_SCAN_FIELDS` | engine → content | scan one frame |
| `AF_SCAN_TAB` | content/top → bg | multi-frame scan |
| `AF_APPLY_VALUES` | engine → content | fill mapping |
| `AF_PLACE_FILE` | engine → content | resume file / dropzone |
| `AF_TOAST` | bg/popup → content top | toast |
| `AF_SET_AUTO_SEARCH` | settings → content | enable observer |
| `AF_FRAME_DOM_CHANGED` | nested content → bg | iframe mutated |
| `AF_RESCAN_HINT` | bg → top content | re-run hint scan |
| `AF_RUN_AUTOFILL` | hint/popup → bg | run full fill |
| `AF_RUN_SAVE_LIBRARY` | bg shortcut | silent save |
| `AF_GET_COMMAND_SHORTCUT` | popup/options → bg | display shortcuts |

---

## 8. Storage schema (подробно)

### Library entry

```js
library.entries["email"] = {
  label: "Email",
  value: "user@example.com",
  updatedAt: "2026-…",
  sourceUrl: "https://…"
}
```

### Settings defaults

```js
{
  geminiApiKey: "",
  geminiModel: "gemini-flash-lite-latest",
  useGeminiFallback: true,
  autoSearchMode: false,
  contextText: "",
  resumes: [],
  defaultResumeId: ""
}
```

### Popup session blob

```js
{
  items: [/* save preview */] | fields: [/* essay */],
  sourceUrl: "https://…",
  tabId: 123,
  savedAt: 1710000000000
}
```

---

## 9. UI-режимы popup

| Режим | Как войти | Содержимое |
|-------|-----------|------------|
| Main | default | Autofill, Save, toggles, status, panels |
| Library | 🔍 / footer pill / `/` | search in header, field list, Esc back |
| Resume picker | during Autofill if resume fields + resumes exist | list of uploaded CVs |
| Essay | after Autofill if open-ended | ✨ / 🧠 / Insert |
| Save preview | after Save | checkboxes key/label/value |

**MV3 limitation:** настоящее скругление окна popup невозможно; host — прямоугольник, заливка `--af-bg` edge-to-edge.

---

## 10. Версии (краткая история)

| Version | Суть |
|---------|------|
| 1.0–1.2 | core library, gemini, auto-search, shortcuts |
| 1.3 | multi-frame, resume detection |
| 1.4 | UI redesign, smarter social matching |
| **1.5.0** | library browser, smart save filter, resume vs additional files, label/keyword fixes, height lock |
| **1.5.1** | footer + scrollbar spacing |

Дополнительно в коде (после 1.5.1, может быть uncommitted): Form.io dropzone place, session TTL, no hover lift на кнопках, Fill CV button removed.

---

## 11. Как разрабатывать

1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → папка `filler`
2. После правок JS/CSS/HTML → **Reload** extension
3. Content script: refresh tab
4. Service worker: Reload extension (или «Inspect service worker»)
5. Syntax: `node --check path/to/file.js`
6. Нет unit-тестов — ручная проверка: Teamtailor, Greenhouse, join.com, Ashby, Form.io/Sourceflow
7. После коммита обновить **AGENTS.md** (Current state + Decisions)

### Conventions

- Comments / UI strings: **English**
- Vocabulary keywords: English + Russian for RU forms
- No ES modules in extension runtime (except если добавите bundler)
- Global export: `if (typeof self !== "undefined") { self.afFoo = afFoo; }`

---

## 12. Карта «куда лезть» при задаче

| Задача | Файлы |
|--------|--------|
| Не видит поле / плохой label | `lib/fieldDetector.js` |
| Неверный concept / keyword | `lib/conceptVocabulary.js` |
| LinkedIn ↔ GitHub путает | `lib/matcher.js` |
| Gemini промпты / essay | `lib/geminiClient.js` |
| Iframe / multi-frame | `lib/autofillEngine.js` |
| Storage / resumes | `lib/storage.js`, `options/*` |
| Hint / toast / auto-search | `content/content-script.js` |
| Shortcuts / session clear | `background/service-worker.js` |
| Popup UI / library browser | `popup/*` |
| Permissions / inject | `manifest.json` |
| Правила для AI | `AGENTS.md` |

---

## 13. Зависимости (vendor only)

| Library | Файл | Зачем |
|---------|------|--------|
| pdf.js | `pdf.min.js` + `pdf.worker.min.js` | текст из PDF resume |
| mammoth | `mammoth.browser.js` | текст из DOCX |

Gemini — runtime HTTP API, не vendor.

---

## 14. Privacy checklist

- [x] Library values only in `chrome.storage.local`
- [x] Gemini gets field metadata + library keys/labels, not values
- [x] Resume files as base64 local only
- [x] No analytics / no backend of the extension itself

---

*Конец документа. Можно копировать целиком. При крупных изменениях архитектуры обновляйте вместе с `AGENTS.md`.*
