// Popup: orchestrates page scanning, matching against the library (rules + Gemini fallback),
// generating answers to job application questions, and actually placing a resume file into the
// upload field. All chrome.storage/Gemini API calls go directly from here — no separate
// background service worker needed for this lightweight logic.

const statusEl = document.getElementById("af-status");
const autofillBtn = document.getElementById("af-autofill-btn");
const scanSaveBtn = document.getElementById("af-scan-save-btn");
const autoSearchInput = document.getElementById("af-auto-search");
const shortcutLabelEl = document.getElementById("af-shortcut-label");
const saveShortcutLabelEl = document.getElementById("af-save-shortcut-label");
const autoSearchShortcutChipEl = document.getElementById("af-auto-search-shortcut-chip");
const shortcutLinkEl = document.getElementById("af-shortcut-link");
const previewEl = document.getElementById("af-preview");
const previewListEl = document.getElementById("af-preview-list");
const libraryCountEl = document.getElementById("af-library-count");
const essayPanelEl = document.getElementById("af-essay-panel");
const essayListEl = document.getElementById("af-essay-list");
const resumeMenuEl = document.getElementById("af-resume-menu");
const resumeMenuListEl = document.getElementById("af-resume-menu-list");
const resumeMenuTitleEl = document.getElementById("af-resume-menu-title");
const mainViewEl = document.getElementById("af-main-view");
const libraryViewEl = document.getElementById("af-library-view");
const librarySearchEl = document.getElementById("af-library-search");
const librarySearchClearEl = document.getElementById("af-library-search-clear");
const libraryBrowserListEl = document.getElementById("af-library-browser-list");
const libraryEmptyEl = document.getElementById("af-library-empty");
const libraryNoResultsEl = document.getElementById("af-library-no-results");
const toggleLibraryBtn = document.getElementById("af-toggle-library");
const headerBrandEl = document.getElementById("af-header-brand");
const headerSearchEl = document.getElementById("af-header-search");
const appEl = document.querySelector(".af-app");

// Resume chosen in the current autofill session. Stored at module level (not in a closure)
// so the ✨ handler reads it on click — otherwise re-rendering the panel would lose
// already typed/generated answers.
let afChosenResume = null;
let afLibraryMode = false;
/** @type {{ key: string, label: string, value: string }[]} */
let afLibraryCache = [];
let afLibrarySearchQuery = "";
let afLibrarySaveTimer = null;

document.getElementById("af-open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById("af-preview-close").addEventListener("click", hidePreview);
document.getElementById("af-preview-cancel").addEventListener("click", hidePreview);
document.getElementById("af-essay-close").addEventListener("click", hideEssayPanel);
document.getElementById("af-essay-cancel").addEventListener("click", hideEssayPanel);
// Resume menu close button is attached by pickResume itself (resolves the promise to null),
// so no global handler needed here.

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function escapeAttr(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function clearPopupState() {
  try {
    await new Promise((res) => chrome.storage.local.remove(["af_last_preview", "af_last_essay"], res));
  } catch (err) {
    console.warn("Failed to clear popup temp state", err);
  }
}

function hidePreview() {
  previewEl.classList.add("hidden");
  previewListEl.innerHTML = "";
  clearPopupState();
}

function hideEssayPanel() {
  essayPanelEl.classList.add("hidden");
  essayListEl.innerHTML = "";
  clearPopupState();
}

function hideResumeMenu() {
  resumeMenuEl.classList.add("hidden");
  resumeMenuListEl.innerHTML = "";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function scanPage(tabId) {
  // Multi-frame scan (top page + embeds like Greenhouse).
  return afScanTab(tabId);
}

async function refreshLibraryCount() {
  const library = await afGetLibrary();
  const count = Object.keys(library.entries || {}).length;
  libraryCountEl.textContent =
    count > 0 ? `${count} field${count === 1 ? "" : "s"} in library` : "Library empty";
}

// --- Library browser (search / copy / edit without growing the popup) ---

function afLibraryEntriesToList(library) {
  const entries = library?.entries || {};
  return Object.keys(entries)
    .map((key) => ({
      key,
      label: entries[key]?.label || key,
      value: entries[key]?.value || "",
    }))
    .sort((a, b) => {
      const la = (a.label || a.key).toLowerCase();
      const lb = (b.label || b.key).toLowerCase();
      return la.localeCompare(lb);
    });
}

function afLibraryFilterEntries(entries, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return entries;
  const tokens = q.split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const blob = `${entry.key} ${entry.label} ${entry.value}`.toLowerCase();
    return tokens.every((t) => blob.includes(t));
  });
}

/** Chrome action popups practically top out ~600px; never lock taller (causes double scroll). */
function afPopupHeightCap() {
  const cssCap = 600;
  const screenCap = Math.floor(((window.screen && window.screen.availHeight) || 900) * 0.7);
  // window.innerHeight in a popup is the current host height (already capped by Chrome).
  const hostCap = window.innerHeight > 40 ? window.innerHeight : cssCap;
  return Math.max(200, Math.min(cssCap, screenCap, hostCap));
}

function afLockPopupHeight() {
  // Lock .af-app to current main-mode height (capped). Only .af-library-browser-list scrolls.
  if (!appEl) return;
  const measured = Math.round(appEl.getBoundingClientRect().height);
  const h = Math.max(1, Math.min(measured, afPopupHeightCap()));
  const px = `${h}px`;
  appEl.style.height = px;
  appEl.style.maxHeight = px;
  appEl.style.minHeight = px;
  appEl.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  document.documentElement.style.maxHeight = px;
  document.body.style.maxHeight = px;
}

function afUnlockPopupHeight() {
  document.documentElement.style.overflow = "";
  document.documentElement.style.maxHeight = "";
  document.body.style.overflow = "";
  document.body.style.maxHeight = "";
  if (appEl) {
    appEl.style.height = "";
    appEl.style.maxHeight = "";
    appEl.style.minHeight = "";
    appEl.style.overflow = "";
  }
}

function setLibraryMode(open) {
  const wantOpen = !!open;

  if (wantOpen && !afLibraryMode) {
    // Measure main-mode shell first, then swap — no growth.
    afLockPopupHeight();
    appEl?.classList.add("af-mode-library");
  }

  afLibraryMode = wantOpen;
  mainViewEl.classList.toggle("hidden", afLibraryMode);
  libraryViewEl.classList.toggle("hidden", !afLibraryMode);
  headerBrandEl?.classList.toggle("hidden", afLibraryMode);
  headerSearchEl?.classList.toggle("hidden", !afLibraryMode);

  if (afLibraryMode) {
    libraryViewEl.removeAttribute("hidden");
    headerSearchEl?.removeAttribute("hidden");
  } else {
    libraryViewEl.setAttribute("hidden", "");
    headerSearchEl?.setAttribute("hidden", "");
    appEl?.classList.remove("af-mode-library");
    afUnlockPopupHeight();
  }

  toggleLibraryBtn.setAttribute("aria-pressed", afLibraryMode ? "true" : "false");
  libraryCountEl.classList.toggle("af-pill-active", afLibraryMode);
  toggleLibraryBtn.title = afLibraryMode
    ? "Back to autofill"
    : "Browse library (search, copy, edit)";

  if (afLibraryMode) {
    afSyncLibrarySearchClear();
    requestAnimationFrame(() => {
      librarySearchEl.focus();
      librarySearchEl.select?.();
    });
  } else {
    // Reset query when leaving library so next open is clean.
    librarySearchEl.value = "";
    afLibrarySearchQuery = "";
    afSyncLibrarySearchClear();
  }
}

function afSyncLibrarySearchClear() {
  if (!librarySearchClearEl) return;
  const has = String(librarySearchEl?.value || "").length > 0;
  librarySearchClearEl.classList.toggle("hidden", !has);
}

async function loadLibraryBrowser(preserveScroll) {
  const scrollTop = preserveScroll ? libraryBrowserListEl.scrollTop : 0;
  const library = await afGetLibrary();
  afLibraryCache = afLibraryEntriesToList(library);
  renderLibraryBrowser();
  if (preserveScroll) libraryBrowserListEl.scrollTop = scrollTop;
  await refreshLibraryCount();
}

function renderLibraryBrowser() {
  const filtered = afLibraryFilterEntries(afLibraryCache, afLibrarySearchQuery);
  const total = afLibraryCache.length;

  libraryEmptyEl.classList.toggle("hidden", total > 0);
  libraryNoResultsEl.classList.toggle("hidden", !(total > 0 && filtered.length === 0));
  libraryBrowserListEl.classList.toggle("hidden", filtered.length === 0);

  // Counter in footer shows total; keep it accurate while filtering.
  if (afLibrarySearchQuery.trim() && total > 0) {
    libraryCountEl.textContent = `${filtered.length} of ${total}`;
  } else {
    libraryCountEl.textContent =
      total > 0 ? `${total} field${total === 1 ? "" : "s"} in library` : "Library empty";
  }

  libraryBrowserListEl.innerHTML = filtered
    .map((entry) => {
      const valueRows = Math.min(4, Math.max(1, String(entry.value || "").split("\n").length));
      return `
      <div class="af-lib-row" role="listitem" data-key="${escapeAttr(entry.key)}">
        <div class="af-lib-row-top">
          <div class="af-lib-row-text">
            <input
              type="text"
              class="af-lib-label-input"
              value="${escapeAttr(entry.label)}"
              data-key="${escapeAttr(entry.key)}"
              data-field="label"
              placeholder="Label"
              spellcheck="false"
            />
            <div class="af-lib-key" title="${escapeAttr(entry.key)}">${escapeHtml(entry.key)}</div>
          </div>
          <div class="af-lib-actions">
            <button type="button" class="af-lib-action" data-action="copy-value" data-key="${escapeAttr(entry.key)}" title="Copy value" aria-label="Copy value">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button type="button" class="af-lib-action" data-action="copy-key" data-key="${escapeAttr(entry.key)}" title="Copy key" aria-label="Copy key">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10H7z"/><path d="M3 11V5a2 2 0 0 1 2-2h6"/><path d="M21 13v6a2 2 0 0 1-2 2h-6"/></svg>
            </button>
            <button type="button" class="af-lib-action af-lib-action-danger" data-action="delete" data-key="${escapeAttr(entry.key)}" title="Delete field" aria-label="Delete field">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>
            </button>
          </div>
        </div>
        <textarea
          class="af-lib-value-input"
          rows="${valueRows}"
          data-key="${escapeAttr(entry.key)}"
          data-field="value"
          placeholder="Value"
          spellcheck="false"
        >${escapeHtml(entry.value)}</textarea>
      </div>`;
    })
    .join("");
}

async function afCopyText(text) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function afFlashCopied(btn) {
  if (!btn) return;
  btn.classList.add("af-copied");
  const prev = btn.title;
  btn.title = "Copied";
  setTimeout(() => {
    btn.classList.remove("af-copied");
    btn.title = prev;
  }, 900);
}

function afScheduleLibraryFieldSave(key, field, value) {
  // Update local cache immediately so search stays consistent while typing.
  const item = afLibraryCache.find((e) => e.key === key);
  if (item) item[field] = value;

  if (afLibrarySaveTimer) clearTimeout(afLibrarySaveTimer);
  afLibrarySaveTimer = setTimeout(async () => {
    afLibrarySaveTimer = null;
    try {
      const library = await afGetLibrary();
      if (!library.entries[key]) return;
      if (field === "label") library.entries[key].label = value;
      if (field === "value") library.entries[key].value = value;
      library.entries[key].updatedAt = new Date().toISOString();
      await afSetLibrary(library);
      await refreshLibraryCount();
    } catch (err) {
      console.warn("Failed to save library field", err);
    }
  }, 280);
}

toggleLibraryBtn.addEventListener("click", async () => {
  if (afLibraryMode) {
    setLibraryMode(false);
    return;
  }
  await loadLibraryBrowser(false);
  setLibraryMode(true);
});

libraryCountEl.addEventListener("click", async () => {
  if (afLibraryMode) {
    setLibraryMode(false);
    return;
  }
  await loadLibraryBrowser(false);
  setLibraryMode(true);
});

librarySearchEl.addEventListener("input", () => {
  afLibrarySearchQuery = librarySearchEl.value;
  afSyncLibrarySearchClear();
  renderLibraryBrowser();
});

librarySearchClearEl?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  librarySearchEl.value = "";
  afLibrarySearchQuery = "";
  afSyncLibrarySearchClear();
  renderLibraryBrowser();
  librarySearchEl.focus();
});

libraryBrowserListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const key = btn.dataset.key;
  const action = btn.dataset.action;
  const entry = afLibraryCache.find((item) => item.key === key);
  if (!entry) return;

  if (action === "copy-value") {
    const ok = await afCopyText(entry.value);
    if (ok) afFlashCopied(btn);
    return;
  }
  if (action === "copy-key") {
    const ok = await afCopyText(entry.key);
    if (ok) afFlashCopied(btn);
    return;
  }
  if (action === "delete") {
    const label = entry.label || entry.key;
    if (!confirm(`Delete “${label}” from the library?`)) return;
    await afDeleteEntry(key);
    await loadLibraryBrowser(true);
  }
});

libraryBrowserListEl.addEventListener("input", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  const key = el.dataset.key;
  const field = el.dataset.field;
  if (!key || (field !== "label" && field !== "value")) return;
  afScheduleLibraryFieldSave(key, field, el.value);
});

// Slash focuses search when library mode is open; Escape closes library mode.
document.addEventListener("keydown", (e) => {
  if (!afLibraryMode) {
    // Quick open library with "/" when not typing in another field.
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      e.preventDefault();
      toggleLibraryBtn.click();
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    setLibraryMode(false);
    return;
  }
  if (e.key === "/" && document.activeElement !== librarySearchEl) {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    librarySearchEl.focus();
    librarySearchEl.select?.();
  }
});

// --- Resume picker menu (appears on "Autofill" click if there's something to choose) ---

// Shows the menu and resolves the selected resume object (or null if none/menu closed).
function pickResume(settings, title) {
  return new Promise((resolve) => {
    const resumes = settings.resumes || [];
    resumeMenuTitleEl.textContent = title;
    resumeMenuListEl.innerHTML = resumes
      .map(
        (r) => `
        <button class="af-resume-menu-item" data-id="${escapeAttr(r.id)}">
          <span class="af-resume-menu-name">${escapeAttr(r.name || r.fileName || "Resume")}</span>
          ${r.id === settings.defaultResumeId ? '<span class="af-resume-menu-default">default</span>' : ""}
        </button>
      `
      )
      .join("");
    resumeMenuEl.classList.remove("hidden");

    let settled = false;
    const finish = (resume) => {
      if (settled) return;
      settled = true;
      hideResumeMenu();
      resolve(resume);
    };

    resumeMenuListEl.querySelectorAll(".af-resume-menu-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const resume = resumes.find((r) => r.id === btn.dataset.id) || null;
        finish(resume);
      });
    });

    document.getElementById("af-resume-menu-close").addEventListener(
      "click",
      () => finish(null),
      { once: true }
    );
  });
}

// --- Autofill ---

autofillBtn.addEventListener("click", async () => {
  autofillBtn.disabled = true;
  hideEssayPanel();
  hideResumeMenu();
  setStatus("Scanning page...");
  try {
    const tab = await getActiveTab();
    const scanResult = await scanPage(tab.id);
    const allFields = scanResult.fields || [];
    const resumeUploadFields = scanResult.resumeUploadFields || [];

    if (allFields.length === 0 && resumeUploadFields.length === 0) {
      setStatus("No fillable fields found on this page.");
      return;
    }

    const essayFields = allFields.filter((f) => f.isEssay);

    const library = await afGetLibrary();
    const settings = await afGetSettings();

    let filledCount = 0;
    let usedGemini = false;

    // Match profile fields against the library. Essay/open-ended questions are NOT
    // filled from website/portfolio/github — they go to the ✨ AI panel.
    afChosenResume = null;
    const filledAfIds = new Set();

    if (allFields.length > 0) {
      const ruleResult = afMatchFieldsToLibrary(allFields, library);
      const mapping = { ...ruleResult.mapping };

      const geminiCandidates =
        typeof afFieldsForGeminiMatching === "function"
          ? afFieldsForGeminiMatching(ruleResult.unmatched)
          : ruleResult.unmatched.filter((f) => !f.isEssay);

      if (settings.useGeminiFallback && settings.geminiApiKey && geminiCandidates.length > 0) {
        setStatus("Matching remaining fields via Gemini...");
        try {
          let geminiMatches = await afCallGeminiForMatching(geminiCandidates, library, settings);
          if (typeof afFilterGeminiMatches === "function") {
            geminiMatches = afFilterGeminiMatches(geminiMatches, allFields, library);
          }
          geminiMatches.forEach(({ afId, libraryKey }) => {
            const entry = library.entries[libraryKey];
            if (entry && entry.value) {
              mapping[afId] = entry.value;
              usedGemini = true;
            }
          });
        } catch (e) {
          console.warn("Gemini matching failed", e);
          setStatus(`Gemini unavailable (${e.message}), using rules only.`);
        }
      }

      if (Object.keys(mapping).length > 0) {
        const applyResult = await afApplyValuesOnTab(tab.id, mapping, allFields);
        filledCount = applyResult.filledCount || 0;
        Object.keys(mapping).forEach((afId) => filledAfIds.add(afId));
      }
    }

    // Essay questions always go to the ✨ panel (not auto-filled from profile library).
    const essayFieldsToGenerate = essayFields.filter((f) => !filledAfIds.has(f.afId));
    if (essayFieldsToGenerate.length > 0) {
      try {
        renderEssayPanel(essayFieldsToGenerate);
      } catch (err) {
        console.warn('Failed to render essay panel', err);
      }
    }

    let statusLines = [
      `Filled ${filledCount} of ${allFields.length} fields.` + (usedGemini ? " (Gemini helped with some fields)" : ""),
    ];

    // Resume is only needed if the page has a resume upload field or unanswered essay
    // questions (resume text is useful for those) — and only if resumes are uploaded.
    const needsResume = (resumeUploadFields.length > 0 || essayFieldsToGenerate.length > 0) && (settings.resumes || []).length > 0;

    if (needsResume) {
      const title =
        resumeUploadFields.length > 0
          ? "Select resume — file will be placed on the page"
          : "Select resume for generating answers";
      afChosenResume = await pickResume(settings, title);
    }

    if (resumeUploadFields.length > 0) {
      if (!afChosenResume && (settings.resumes || []).length === 0) {
        statusLines.push("Resume upload field found on page, but no resumes uploaded (add in settings).");
      } else if (afChosenResume) {
        let placedCount = 0;
        for (const field of resumeUploadFields) {
          const result = await afPlaceFileOnTab(tab.id, field, afChosenResume);
          if (result && result.ok) placedCount += 1;
        }
        statusLines.push(`Resume file placed in ${placedCount} of ${resumeUploadFields.length} field(s).`);
      } else {
        statusLines.push("Resume selection cancelled — file not placed.");
      }
    }

    setStatus(statusLines.join("\n"));

    // Essay panel already rendered above; just append status. The ✨ handler reads
    // the current afChosenResume — no need to re-render (and lose answers).
    if (essayFieldsToGenerate.length > 0) {
      setStatus(statusEl.textContent + `\nUnanswered questions: ${essayFieldsToGenerate.length} — generate via ✨.`);
    }
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  } finally {
    autofillBtn.disabled = false;
  }
});

// --- Save to library ---

scanSaveBtn.addEventListener("click", async () => {
  scanSaveBtn.disabled = true;
  setStatus("Scanning page...");
  try {
    const tab = await getActiveTab();
    const scanResult = await scanPage(tab.id);
    const fields = (scanResult.fields || []).filter((f) => !f.isEssay && (f.value || "").trim() !== "");

    if (fields.length === 0) {
      setStatus("No filled fields found on this page.");
      return;
    }

    const settings = await afGetSettings();
    const library = await afGetLibrary();
    // Don't spend Gemini calls classifying consent/confirm junk or empty shells.
    const candidates = fields.filter((f) => !afIsJunkLibraryField(f));
    const unclassified = candidates.filter((f) => !f.guessedConcept);
    let suggestions = [];
    if (settings.useGeminiFallback && settings.geminiApiKey && unclassified.length > 0) {
      setStatus("Classifying fields via Gemini...");
      try {
        suggestions = await afCallGeminiForClassification(unclassified, settings);
      } catch (e) {
        console.warn("Gemini classification failed", e);
      }
    }

    const suggestionMap = new Map(suggestions.map((s) => [s.afId, s]));
    const { items: previewItems, stats } = afBuildLibrarySaveItems(
      fields,
      library,
      suggestionMap,
      tab.url || ""
    );

    if (previewItems.length === 0) {
      const parts = [];
      if (stats.unchanged) parts.push(`${stats.unchanged} already in library`);
      if (stats.junk) parts.push(`${stats.junk} skipped (confirm/consent/etc.)`);
      setStatus(parts.length ? `Nothing new to save — ${parts.join(", ")}.` : "Nothing new to save.");
      hidePreview();
      return;
    }

    await renderPreview(previewItems, tab.url);
    const statusParts = [`${previewItems.length} to review`];
    if (stats.fresh) statusParts.push(`${stats.fresh} new`);
    if (stats.updates) statusParts.push(`${stats.updates} updated value`);
    if (stats.unchanged) statusParts.push(`${stats.unchanged} already saved (hidden)`);
    if (stats.junk) statusParts.push(`${stats.junk} skipped`);
    setStatus(statusParts.join(" · ") + ".");
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  } finally {
    scanSaveBtn.disabled = false;
  }
});

async function renderPreview(items, sourceUrl) {
  previewListEl.innerHTML = "";

  items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "af-field-card" + (item.saveStatus === "update" ? " af-field-card-update" : "");
    // New + updates are checked; (unchanged no longer appear here)
    const shouldBeChecked = true;
    const badge =
      item.saveStatus === "update"
        ? `<span class="af-type-badge af-type-badge-update" title="Library has a different value">update</span>`
        : `<span class="af-type-badge">${escapeAttr(item.sourceType || "text")}</span>`;
    row.innerHTML = `
      <div class="af-field-card-top">
        <input type="checkbox" ${shouldBeChecked ? "checked" : ""} data-idx="${idx}" class="af-row-check" />
        <input type="text" class="af-field-label" value="${escapeAttr(item.label)}" data-field="label" data-idx="${idx}" placeholder="Field name" />
        ${badge}
      </div>
      <div class="af-field-card-body">
        <div class="af-field-group">
          <label class="af-mini-label">Key</label>
          <input type="text" class="af-field-key" value="${escapeAttr(item.key)}" data-field="key" data-idx="${idx}" placeholder="Key (latin)" />
        </div>
        <div class="af-field-group">
          <label class="af-mini-label">Value</label>
          <input type="text" class="af-field-value" value="${escapeAttr(item.value)}" data-field="value" data-idx="${idx}" placeholder="Value" />
        </div>
      </div>
    `;
    previewListEl.appendChild(row);
  });

  // store dataset on preview element and persist to storage so closing popup doesn't lose it
  previewEl.dataset.items = JSON.stringify(items);
  previewEl.dataset.sourceUrl = sourceUrl || "";
  previewEl.classList.remove("hidden");

  // persist preview to storage for popup reopen
  try {
    await new Promise((res) => chrome.storage.local.set({ af_last_preview: { items, sourceUrl } }, res));
  } catch (e) {
    console.warn('Failed to persist preview', e);
  }

  // wire up change handlers and persist incremental changes
  previewListEl.querySelectorAll("input[data-field]").forEach((input) => {
    input.addEventListener("input", async (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      const currentItems = JSON.parse(previewEl.dataset.items);
      currentItems[idx][field] = e.target.value;
      previewEl.dataset.items = JSON.stringify(currentItems);
      try {
        await new Promise((res) => chrome.storage.local.set({ af_last_preview: { items: currentItems, sourceUrl } }, res));
      } catch (err) {
        console.warn('Failed to persist preview change', err);
      }
    });
  });

  // also persist checkbox changes
  previewListEl.querySelectorAll('.af-row-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        const currentItems = JSON.parse(previewEl.dataset.items);
        await new Promise((res) => chrome.storage.local.set({ af_last_preview: { items: currentItems, sourceUrl } }, res));
      } catch (err) {
        console.warn('Failed to persist preview checkbox change', err);
      }
    });
  });
}

document.getElementById("af-preview-confirm").addEventListener("click", async () => {
  const items = JSON.parse(previewEl.dataset.items || "[]");
  const sourceUrl = previewEl.dataset.sourceUrl || "";
  const checkedIdxs = Array.from(previewListEl.querySelectorAll(".af-row-check"))
    .filter((cb) => cb.checked)
    .map((cb) => Number(cb.dataset.idx));

  const entriesToSave = checkedIdxs
    .map((idx) => items[idx])
    .filter((item) => item.key && item.value)
    .map((item) => ({ key: item.key, label: item.label, value: item.value, sourceUrl }));

  if (entriesToSave.length === 0) {
    setStatus("Nothing selected to save.");
    return;
  }

  await afSaveEntries(entriesToSave);
  hidePreview();
  setStatus(`Saved ${entriesToSave.length} fields.`);
  await refreshLibraryCount();
  if (afLibraryMode) await loadLibraryBrowser(true);
});

// --- Job application questions (essay) ---

function renderEssayPanel(essayFields) {
  essayListEl.innerHTML = "";
  // essayFields: [{ afId, frameId?, label?, placeholder?, value? }]
  essayFields.forEach((field) => {
    const item = document.createElement("div");
    item.className = "af-essay-item";
    item.dataset.afid = field.afId;
    item.dataset.frameId = field.frameId != null ? String(field.frameId) : "0";
    const question = field.label || field.placeholder || field.ariaLabel || field.question || "Application question";
    item.dataset.question = question;
    item.innerHTML = `
      <div class="af-essay-header">
        <span class="af-essay-question">${escapeAttr(question)}</span>
        <div class="af-essay-btn-group">
          <button class="af-sparkle-btn af-context-btn" data-afid="${escapeAttr(field.afId)}" title="Save question and answer to context">🧠</button>
          <button class="af-sparkle-btn" data-afid="${escapeAttr(field.afId)}" title="Generate answer">✨</button>
        </div>
      </div>
      <textarea class="af-essay-answer" data-afid="${escapeAttr(field.afId)}" data-frame-id="${escapeAttr(field.frameId != null ? field.frameId : 0)}" rows="4" placeholder="Answer will appear here after generation, or type manually...">${escapeAttr(field.value || '')}</textarea>
    `;
    essayListEl.appendChild(item);
  });
  essayPanelEl.classList.remove("hidden");

  // Persist current essay panel to storage so popup reopen restores typed/generated answers
  async function persistEssayState() {
    try {
      const current = Array.from(essayListEl.querySelectorAll('.af-essay-item')).map(el => {
        const afId = el.dataset.afid;
        const frameId = Number(el.dataset.frameId || 0);
        const question = el.dataset.question;
        const textarea = el.querySelector('.af-essay-answer');
        return { afId, frameId, question, value: textarea.value };
      });
      const tab = await getActiveTab();
      await new Promise((res) => chrome.storage.local.set({ af_last_essay: { fields: current, sourceUrl: tab?.url || "" } }, res));
    } catch (err) {
      console.warn('Failed to persist essay state', err);
    }
  }

  essayListEl.querySelectorAll(".af-context-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const contextBtn = e.currentTarget;
      const afId = contextBtn.dataset.afid;
      const item = essayListEl.querySelector(`.af-essay-item[data-afid="${CSS.escape(afId)}"]`);
      const textarea = item.querySelector(".af-essay-answer");
      const question = item.dataset.question;
      const answer = textarea.value.trim();

      if (!answer) {
        setStatus("Type or generate an answer first, then save it to context.");
        return;
      }

      const settings = await afGetSettings();
      const addition = `Q: ${question}\nA: ${answer}`;
      settings.contextText = settings.contextText ? `${settings.contextText}\n\n${addition}` : addition;
      await afSetSettings(settings);

      const original = contextBtn.textContent;
      contextBtn.disabled = true;
      contextBtn.textContent = "✅";
      setTimeout(() => {
        contextBtn.textContent = original;
        contextBtn.disabled = false;
      }, 1200);

      // persist essay panel after saving to context
      await persistEssayState();
    });
  });

  essayListEl.querySelectorAll(".af-sparkle-btn:not(.af-context-btn)").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const afId = e.currentTarget.dataset.afid;
      const item = essayListEl.querySelector(`.af-essay-item[data-afid="${CSS.escape(afId)}"]`);
      const textarea = item.querySelector(".af-essay-answer");
      const question = item.dataset.question;
      const sparkleBtn = e.currentTarget;

      const settings = await afGetSettings();
      if (!settings.geminiApiKey) {
        setStatus("Set your Gemini API key in settings to generate answers.");
        return;
      }

      sparkleBtn.disabled = true;
      sparkleBtn.classList.add("af-loading");
      sparkleBtn.textContent = "";

      try {
        const resumeForAnswer =
          afChosenResume || (settings.resumes || []).find((r) => r.id === settings.defaultResumeId);
        const answer = await afCallGeminiForEssayAnswer(
          question,
          settings.contextText || "",
          resumeForAnswer?.textContent || "",
          settings
        );
        textarea.value = answer;
        await persistEssayState();
      } catch (err) {
        setStatus(`Generation error: ${err.message}`);
      } finally {
        sparkleBtn.disabled = false;
        sparkleBtn.classList.remove("af-loading");
        sparkleBtn.textContent = "✨";
      }
    });
  });

  // save on manual typing
  essayListEl.querySelectorAll('.af-essay-answer').forEach(txt => {
    txt.addEventListener('input', () => {
      // debounce or fire immediately — immediate is fine for small data
      persistEssayState();
    });
  });
}

document.getElementById("af-essay-apply").addEventListener("click", async () => {
  const mapping = {};
  const fields = [];
  essayListEl.querySelectorAll(".af-essay-answer").forEach((textarea) => {
    if (textarea.value.trim() !== "") {
      const afId = textarea.dataset.afid;
      const frameId = Number(textarea.dataset.frameId || 0);
      mapping[afId] = textarea.value;
      fields.push({ afId, frameId });
    }
  });

  if (Object.keys(mapping).length === 0) {
    setStatus("No answers to insert.");
    return;
  }

  try {
    const tab = await getActiveTab();
    const applyResult = await afApplyValuesOnTab(tab.id, mapping, fields);
    setStatus(`Inserted ${applyResult.filledCount} answer(s).`);
    hideEssayPanel();
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
});

// --- Auto-search + shortcuts ---

autoSearchInput.addEventListener("change", async () => {
  const settings = await afGetSettings();
  settings.autoSearchMode = autoSearchInput.checked;
  await afSetSettings(settings);
  setStatus(
    autoSearchInput.checked
      ? "Auto-search enabled — hint will appear on pages with fields."
      : "Auto-search disabled."
  );
});

shortcutLinkEl.addEventListener("click", (e) => {
  e.preventDefault();
  // Chrome opens the shortcuts page when user goes to chrome://extensions/shortcuts
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

async function loadAutoSearchToggle() {
  const settings = await afGetSettings();
  autoSearchInput.checked = !!settings.autoSearchMode;
}

function afSetShortcutLabel(el, shortcut) {
  if (!el) return;
  if (shortcut) {
    el.textContent = shortcut;
    el.title = "";
  } else {
    el.textContent = "not set";
    el.title = "Assign a shortcut on the Chrome shortcuts page";
  }
}

async function loadShortcutLabel() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "AF_GET_COMMAND_SHORTCUT" });
    afSetShortcutLabel(shortcutLabelEl, res?.shortcut || res?.shortcuts?.autofill || "");
    afSetShortcutLabel(saveShortcutLabelEl, res?.saveShortcut || res?.shortcuts?.save || "");
    afSetShortcutLabel(
      autoSearchShortcutChipEl,
      res?.autoSearchShortcut || res?.shortcuts?.autoSearch || ""
    );
  } catch (e) {
    if (shortcutLabelEl) shortcutLabelEl.textContent = "Alt+Shift+A";
    if (saveShortcutLabelEl) saveShortcutLabelEl.textContent = "Alt+Shift+S";
    if (autoSearchShortcutChipEl) autoSearchShortcutChipEl.textContent = "Alt+Shift+F";
  }
}

// Keep toggle in sync when auto-search is flipped via keyboard shortcut.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.af_settings) return;
  const next = changes.af_settings.newValue || {};
  if (autoSearchInput) autoSearchInput.checked = !!next.autoSearchMode;
});

(async function initPopup() {
  await refreshLibraryCount();
  await loadAutoSearchToggle();
  await loadShortcutLabel();
  try {
    const tab = await getActiveTab();
    const tabUrl = tab?.url || "";
    const res = await new Promise((resolve) => chrome.storage.local.get(["af_last_preview", "af_last_essay"], resolve));

    const previewValid = res.af_last_preview && res.af_last_preview.sourceUrl === tabUrl;
    const essayValid = res.af_last_essay && res.af_last_essay.sourceUrl === tabUrl;

    if (previewValid && res.af_last_preview.items && res.af_last_preview.items.length > 0) {
      await renderPreview(res.af_last_preview.items, res.af_last_preview.sourceUrl || "");
      setStatus(`Restored ${res.af_last_preview.items.length} fields from previous session.`);
    }

    if (essayValid && res.af_last_essay.fields && res.af_last_essay.fields.length > 0) {
      const restored = res.af_last_essay.fields.map((f) => ({
        afId: f.afId,
        frameId: f.frameId != null ? f.frameId : 0,
        label: f.question,
        value: f.value,
      }));
      renderEssayPanel(restored);
      setStatus((statusEl.textContent ? statusEl.textContent + "\n" : "") + `Restored answers for ${res.af_last_essay.fields.length} question(s).`);
    }

    if ((res.af_last_preview && !previewValid) || (res.af_last_essay && !essayValid)) {
      await clearPopupState();
    }
  } catch (err) {
    console.warn("Error restoring popup state", err);
  }
})();
