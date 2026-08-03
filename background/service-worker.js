// Background service worker: keyboard shortcuts and requests from content-script / popup.
// importScripts loads shared modules (classic scripts, no ES modules).

importScripts(
  "../lib/storage.js",
  "../lib/conceptVocabulary.js",
  "../lib/matcher.js",
  "../lib/geminiClient.js",
  "../lib/autofillEngine.js"
);

// Ensure library/settings shape before handling commands
if (typeof afMigrateStorageIfNeeded === "function") {
  afMigrateStorageIfNeeded().catch((e) => console.warn("storage migrate", e));
}

const AF_COMMAND_AUTOFILL = "af-autofill";
const AF_COMMAND_SAVE = "af-save-library";
const AF_COMMAND_AUTO_SEARCH = "af-toggle-auto-search";

async function afGetActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error("No active tab.");
  // chrome:// and store pages are not accessible by content scripts
  if (tab.url && /^(chrome|chrome-extension|edge|about|devtools):/i.test(tab.url)) {
    throw new Error("This extension doesn't work on this page.");
  }
  return tab.id;
}

async function afToastError(err) {
  try {
    const tabId = await afGetActiveTabId();
    await afSendTabMessage(tabId, {
      type: "AF_TOAST",
      text: `Error: ${err.message || err}`,
      kind: "error",
    });
  } catch (_) {
    /* ignore */
  }
}

async function afRunAutofillOnActiveTab(options = {}) {
  const tabId = options.tabId != null ? options.tabId : await afGetActiveTabId();
  return afAutofillTab(tabId, {
    placeDefaultResume: options.placeDefaultResume !== false,
    resume: options.resume || null,
    notifyPage: options.notifyPage !== false,
    onStatus: options.onStatus || null,
  });
}

async function afRunSaveOnActiveTab(options = {}) {
  const tabId = options.tabId != null ? options.tabId : await afGetActiveTabId();
  return afSaveTabToLibrary(tabId, {
    notifyPage: options.notifyPage !== false,
    onStatus: options.onStatus || null,
  });
}

async function afToggleAutoSearch() {
  const settings = await afGetSettings();
  settings.autoSearchMode = !settings.autoSearchMode;
  await afSetSettings(settings);
  const enabled = !!settings.autoSearchMode;
  try {
    const tabId = await afGetActiveTabId();
    await afSendTabMessage(tabId, {
      type: "AF_TOAST",
      text: enabled ? "🔍 Auto-search ON" : "Auto-search OFF",
      kind: "info",
    });
  } catch (_) {
    /* no accessible tab — storage change still updates content scripts */
  }
  return enabled;
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === AF_COMMAND_AUTOFILL) {
      await afRunAutofillOnActiveTab({ placeDefaultResume: true, notifyPage: true });
      return;
    }
    if (command === AF_COMMAND_SAVE) {
      await afRunSaveOnActiveTab({ notifyPage: true });
      return;
    }
    if (command === AF_COMMAND_AUTO_SEARCH) {
      await afToggleAutoSearch();
      return;
    }
  } catch (e) {
    console.warn("Command failed", command, e);
    await afToastError(e);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AF_RUN_AUTOFILL") {
    (async () => {
      try {
        const tabId =
          message.tabId != null
            ? message.tabId
            : sender.tab?.id != null
              ? sender.tab.id
              : await afGetActiveTabId();
        const result = await afRunAutofillOnActiveTab({
          tabId,
          placeDefaultResume: message.placeDefaultResume !== false,
          resume: message.resume || null,
          notifyPage: message.notifyPage !== false,
        });
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (message?.type === "AF_RUN_SAVE_LIBRARY") {
    (async () => {
      try {
        const tabId =
          message.tabId != null
            ? message.tabId
            : sender.tab?.id != null
              ? sender.tab.id
              : await afGetActiveTabId();
        const result = await afRunSaveOnActiveTab({
          tabId,
          notifyPage: message.notifyPage !== false,
        });
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  // Full-tab multi-frame scan (used by top-frame auto-search hint).
  if (message?.type === "AF_SCAN_TAB") {
    (async () => {
      try {
        const tabId =
          message.tabId != null
            ? message.tabId
            : sender.tab?.id != null
              ? sender.tab.id
              : await afGetActiveTabId();
        const result = await afScanTab(tabId);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e), fields: [], resumeUploadFields: [] });
      }
    })();
    return true;
  }

  // Nested frame DOM changed — tell top frame to re-run auto-search scan.
  if (message?.type === "AF_FRAME_DOM_CHANGED") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.tabs
        .sendMessage(tabId, { type: "AF_RESCAN_HINT" }, { frameId: 0 })
        .catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "AF_GET_COMMAND_SHORTCUT") {
    chrome.commands.getAll((commands) => {
      const list = commands || [];
      const autofill = list.find((c) => c.name === AF_COMMAND_AUTOFILL);
      const save = list.find((c) => c.name === AF_COMMAND_SAVE);
      const autoSearch = list.find((c) => c.name === AF_COMMAND_AUTO_SEARCH);
      sendResponse({
        shortcut: autofill?.shortcut || "",
        saveShortcut: save?.shortcut || "",
        autoSearchShortcut: autoSearch?.shortcut || "",
        shortcuts: {
          autofill: autofill?.shortcut || "",
          save: save?.shortcut || "",
          autoSearch: autoSearch?.shortcut || "",
        },
      });
    });
    return true;
  }

  return false;
});

// --- Popup session (preview / essay) lifecycle ---
// Survives popup close; cleared on tab switch, URL navigation, or 30 min TTL (checked on open).

const AF_POPUP_SESSION_TTL_MS = 30 * 60 * 1000;

async function afClearPopupSessionKeys() {
  try {
    await chrome.storage.local.remove(["af_last_preview", "af_last_essay"]);
  } catch (_) {
    /* ignore */
  }
}

async function afMaybeClearPopupSession({ reason, tabId } = {}) {
  try {
    const data = await chrome.storage.local.get(["af_last_preview", "af_last_essay"]);
    const blobs = [data.af_last_preview, data.af_last_essay].filter(Boolean);
    if (blobs.length === 0) return;

    const now = Date.now();
    const expired = blobs.some(
      (b) => b.savedAt != null && now - Number(b.savedAt) > AF_POPUP_SESSION_TTL_MS
    );
    if (expired) {
      await afClearPopupSessionKeys();
      return;
    }

    const onTab = (b) => b.tabId != null && tabId != null && Number(b.tabId) === Number(tabId);
    const otherTab = (b) => b.tabId != null && tabId != null && Number(b.tabId) !== Number(tabId);

    let clear = false;
    if (reason === "tab-activated") {
      // Switched away from the tab that owns the session
      clear = blobs.some(otherTab);
    } else if (reason === "url") {
      // Navigated within the session tab
      clear = blobs.some(onTab);
    } else if (reason === "tab-removed") {
      clear = blobs.some(onTab);
    }

    if (clear) await afClearPopupSessionKeys();
  } catch (e) {
    console.warn("afMaybeClearPopupSession failed", e);
  }
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  afMaybeClearPopupSession({ reason: "tab-activated", tabId: activeInfo.tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  afMaybeClearPopupSession({ reason: "url", tabId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  afMaybeClearPopupSession({ reason: "tab-removed", tabId });
});
