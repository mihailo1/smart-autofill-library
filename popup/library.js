// AF.popup.library — classic-script module (no bundler).
(function (global) {
  const AF = global.AF || (global.AF = {});
  AF.popup = AF.popup || {};

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

  AF.popup.library = { afLibraryEntriesToList, afLibraryFilterEntries, afPopupHeightCap, afLockPopupHeight, afUnlockPopupHeight, setLibraryMode, afSyncLibrarySearchClear, loadLibraryBrowser, renderLibraryBrowser, afCopyText, afFlashCopied, afScheduleLibraryFieldSave };
  global.afLibraryEntriesToList = afLibraryEntriesToList;
  global.afLibraryFilterEntries = afLibraryFilterEntries;
  global.afPopupHeightCap = afPopupHeightCap;
  global.afLockPopupHeight = afLockPopupHeight;
  global.afUnlockPopupHeight = afUnlockPopupHeight;
  global.setLibraryMode = setLibraryMode;
  global.afSyncLibrarySearchClear = afSyncLibrarySearchClear;
  global.loadLibraryBrowser = loadLibraryBrowser;
  global.renderLibraryBrowser = renderLibraryBrowser;
  global.afCopyText = afCopyText;
  global.afFlashCopied = afFlashCopied;
  global.afScheduleLibraryFieldSave = afScheduleLibraryFieldSave;
})(typeof self !== "undefined" ? self : window);
