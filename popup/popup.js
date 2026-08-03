// Popup bootstrap: wires events and restores session.
// Modules (classic scripts): els → util → session → library → autofill → essay → this file.

(function () {
  if (typeof afMigrateStorageIfNeeded === "function") {
    afMigrateStorageIfNeeded().catch((e) => console.warn("storage migrate", e));
  }

  document.getElementById("af-open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById("af-preview-close").addEventListener("click", () => hidePreview());
  document.getElementById("af-preview-cancel").addEventListener("click", () => hidePreview());
  document.getElementById("af-essay-close").addEventListener("click", () => hideEssayPanel());
  document.getElementById("af-essay-cancel").addEventListener("click", () => hideEssayPanel());

// --- Auto-search + shortcuts ---

autoSearchInput.addEventListener("change", async () => {
  if (autoSearchInput.checked && typeof afEnsurePageAccess === "function") {
    try {
      const tab = await getActiveTab();
      await afEnsurePageAccess(tab, { request: true });
    } catch (e) {
      autoSearchInput.checked = false;
      const settings = await afGetSettings();
      settings.autoSearchMode = false;
      await afSetSettings(settings);
      setStatus(e.message || "Allow this site to enable auto-search.");
      return;
    }
  }
  const settings = await afGetSettings();
  settings.autoSearchMode = autoSearchInput.checked;
  await afSetSettings(settings);
  setStatus(
    autoSearchInput.checked
      ? "Auto-search enabled on this site — hint will appear when fields are found."
      : "Auto-search disabled."
  );
});

shortcutLinkEl.addEventListener("click", (e) => {
  e.preventDefault();
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
    if (tab?.url && typeof afHasOriginPermission === "function") {
      const has = await afHasOriginPermission(tab.url);
      if (!has && statusEl && !statusEl.textContent) {
        setStatus("First use on a site asks for access (optional permission — not all websites).");
      }
    }
    const res = await new Promise((resolve) =>
      chrome.storage.local.get(["af_last_preview", "af_last_essay"], resolve)
    );

    const previewValid = afSessionStillValid(res.af_last_preview, tab);
    const essayValid = afSessionStillValid(res.af_last_essay, tab);

    if (previewValid && res.af_last_preview.items && res.af_last_preview.items.length > 0) {
      await renderPreview(res.af_last_preview.items, res.af_last_preview.sourceUrl || "");
      setStatus(`Restored ${res.af_last_preview.items.length} fields from previous session.`);
    } else if (res.af_last_preview && !previewValid) {
      await clearPreviewState();
    }

    if (essayValid && res.af_last_essay.fields && res.af_last_essay.fields.length > 0) {
      const restored = res.af_last_essay.fields.map((f) => ({
        afId: f.afId,
        frameId: f.frameId != null ? f.frameId : 0,
        label: f.question,
        value: f.value,
      }));
      renderEssayPanel(restored);
      setStatus(
        (statusEl.textContent ? statusEl.textContent + "\n" : "") +
          `Restored answers for ${res.af_last_essay.fields.length} question(s).`
      );
    } else if (res.af_last_essay && !essayValid) {
      await clearEssayState();
    }
  } catch (err) {
    console.warn("Error restoring popup state", err);
  }
})();
})();
