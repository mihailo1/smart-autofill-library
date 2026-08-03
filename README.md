<div align="center">

# ⚡ Smart Autofill Library

**A Chrome extension that learns how you fill out forms — and does it for you next time.**

Remembers your answers as you type them, matches them to new forms with rules first and [Gemini](https://ai.google.dev/) as a smart fallback, and even drafts answers to open-ended job-application questions in *your* voice.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![Chrome](https://img.shields.io/badge/Chrome-Extension-1a73e8?logo=googlechrome&logoColor=white)
![Gemini](https://img.shields.io/badge/AI-Gemini-8E75B2?logo=googlegemini&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

## ✨ What it does

- 💾 **Learns as you go** — save the fields you fill on any page into a personal library (email, phone, address, or anything custom).
- ⚡ **One-click autofill** — the next form gets filled instantly. Rule matching is free and offline; Gemini steps in only for the fields rules can't place.
- 📄 **Resume upload** — drop in one or more PDF/DOCX resumes; only the real Resume/CV field is filled (not “Additional files” / cover-letter uploads).
- 🧠 **Essay answers in your style** — drafts first-person answers from your context + resume, **shows grounding quotes** (no invented facts).
- 📋 **Application tracker** — when you submit a job form, saves the job link, description snippet, and form Q&A in Options.
- 🔒 **Private by design** — everything lives in `chrome.storage.local`. Only field *metadata* and library *keys* are ever sent to Gemini — **your saved values never leave the device**.

## 🚀 Install (developer mode)

1. Clone or download this repo.
2. Open `chrome://extensions` and toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select the project folder.
4. Pin the extension and open its **Options** to add your Gemini API key.

> 🔑 Grab a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
> The key is stored locally and used only for direct calls to the Gemini API from your device.

## 🕹️ How to use

| Action | What happens |
| --- | --- |
| **💾 Save to library** | Scans filled fields, hides ones already identical in the library, skips confirm-email/consent junk, and lets you review new or changed values. |
| **⚡ Autofill** | Matches every field against your library (rules → Gemini fallback) and fills them. |
| **📚 Library browser** | In the popup: 🔍 header button, footer pill, or `/` — search, copy, edit, or delete saved fields without leaving the popup. |
| **🔍 Auto search** | Toggle in the popup/options. When on, pages are scanned automatically and a small hint appears if fillable fields are found. |
| **⌨️ Shortcuts** | **Alt+Shift+A** — fill. **Alt+Shift+S** — save to library. **Alt+Shift+F** — toggle auto-search. Work even when auto-search is off. Rebind at `chrome://extensions/shortcuts`. |
| **✨ Generate** | For open-ended questions with no saved answer, drafts a reply from your context + resume. |
| **🧠 Save to context** | Stashes a good Q&A back into your context so future answers get sharper. |

## 🧩 How it works

```
┌──────────────────────────────────────────────────────────────┐
│                         Web page                             │
│  ┌──────────────┐      ┌──────────────────────────────────┐  │
│  │  hint / toast│◄─────│  content-script + fieldDetector  │  │
│  └──────────────┘      └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
         ▲                                        ▲
         │  fill / toast                          │  scan / apply
         │                                        │
┌──────────────────────┐                 ┌──────────────────────┐
│  background worker   │                 │        popup         │
│  (shortcuts + hint)  │                 │  (orchestrator UI)   │
└──────────────────────┘                 └──────────────────────┘
         │                                        │
         └────────────────┬───────────────────────┘
                          ▼
              ┌──────────────────────┐
              │   autofillEngine     │
              └──────────────────────┘
                 │              │
        rules first    Gemini fallback
                 ▼              ▼
          ┌──────────┐  ┌──────────────┐
          │ matcher  │  │ geminiClient │
          └──────────┘  └──────────────┘
```

- **`lib/fieldDetector.js`** — the only code that touches the page DOM: scans fields, guesses concepts, detects resume uploads and essay-style questions, and applies values.
- **`lib/matcher.js`** + **`lib/conceptVocabulary.js`** — fast, free, offline rule matching against a vocabulary of common concepts.
- **`lib/geminiClient.js`** — fallback matching, field classification, and essay-answer generation via the Gemini API.
- **`lib/autofillEngine.js`** — shared fill pipeline (rules → Gemini → apply → default resume) used by both the popup and the background worker. **Multi-frame aware** — scans and fills fields inside cross-origin embeds (Greenhouse, etc.).
- **`lib/storage.js`** — thin wrapper over `chrome.storage.local` for the library, settings, and resumes.
- **`lib/resumeParser.js`** (+ `vendor/` pdf.js & mammoth) — extracts text from PDF/DOCX resumes.
- **`background/`** — service worker for the keyboard commands and fill requests from the page hint.
- **`content/`** — content script: DOM IO, auto-search observer, floating hint + toast.
- **`popup/`** — the orchestrator UI. **`options/`** — settings, resumes, context, and the saved-field library.

## 🔐 Privacy & permissions

Everything is local. When Gemini is used, only **field metadata** (name/id/label/placeholder/type) and library **keys + labels** are sent — enough to decide *which* saved value maps to *which* field. The actual values (email, phone, essay answers) are substituted **locally** after Gemini responds.

**Site access:** the extension does **not** require “read data on all websites” at install. It uses **optional host permissions** plus `activeTab`: the first Autofill/Save (or auto-search) on a site asks you to allow that origin. Your Gemini API key stays in `chrome.storage.local` only (never designed for `storage.sync`).

## ⚙️ Tech

Manifest V3 · vanilla JS (no build step) · Gemini API · pdf.js · mammoth.js · webextension-polyfill (Chrome / Edge / Firefox)

## 🧑‍💻 For developers

See [`AGENTS.md`](./AGENTS.md) for architecture decisions, conventions, and guidelines for AI agents working on this repo.

```bash
# full local check (syntax + tests + AGENTS.md meta)
bash scripts/check.sh

# or separately:
node test/run.js
node scripts/update-agents-meta.js
```

CI (GitHub Actions) runs syntax + tests on every push/PR.

## 📝 License

MIT
