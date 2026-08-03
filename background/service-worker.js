// Background service worker: keyboard shortcuts and requests from content-script / popup.
// importScripts loads shared modules (classic scripts, no ES modules).

// browser polyfill first (Firefox/Edge); classic SW has no import maps
try {
  importScripts("../lib/vendor/browser-polyfill.min.js");
} catch (e) {
  console.warn("browser-polyfill load failed", e);
}

importScripts(
  "../lib/storage.js",
  "../lib/permissions.js",
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

async function afGetActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error("No active tab.");
  if (tab.url && afIsRestrictedUrl(tab.url)) {
    throw new Error("This extension doesn't work on this page.");
  }
  return tab;
}

async function afGetActiveTabId() {
  const tab = await afGetActiveTab();
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

async function afPrepareActiveTab(options = {}) {
  const tab =
    options.tabId != null
      ? (await chrome.tabs.get(options.tabId))
      : await afGetActiveTab();
  await afEnsurePageAccess(tab, { request: options.request !== false });
  return tab;
}

async function afRunAutofillOnActiveTab(options = {}) {
  const tab = await afPrepareActiveTab(options);
  return afAutofillTab(tab.id, {
    placeDefaultResume: options.placeDefaultResume !== false,
    resume: options.resume || null,
    notifyPage: options.notifyPage !== false,
    onStatus: options.onStatus || null,
  });
}

async function afRunSaveOnActiveTab(options = {}) {
  const tab = await afPrepareActiveTab(options);
  return afSaveTabToLibrary(tab.id, {
    notifyPage: options.notifyPage !== false,
    onStatus: options.onStatus || null,
  });
}

async function afToggleAutoSearch() {
  const settings = await afGetSettings();
  const enabling = !settings.autoSearchMode;
  if (enabling) {
    // Auto-search needs ongoing host access on the current site
    try {
      const tab = await afGetActiveTab();
      await afEnsurePageAccess(tab, { request: true });
    } catch (e) {
      throw new Error(e.message || "Allow this site to enable auto-search.");
    }
  }
  settings.autoSearchMode = enabling;
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
    /* no accessible tab — storage change still updates content scripts that are live */
  }
  return enabled;
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === AF_COMMAND_AUTOFILL) {
      await afRunAutofillOnActiveTab({ placeDefaultResume: true, notifyPage: true, request: true });
      return;
    }
    if (command === AF_COMMAND_SAVE) {
      await afRunSaveOnActiveTab({ notifyPage: true, request: true });
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
              : undefined;
        const result = await afRunAutofillOnActiveTab({
          tabId,
          placeDefaultResume: message.placeDefaultResume !== false,
          resume: message.resume || null,
          notifyPage: message.notifyPage !== false,
          request: message.request !== false,
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
              : undefined;
        const result = await afRunSaveOnActiveTab({
          tabId,
          notifyPage: message.notifyPage !== false,
          request: message.request !== false,
        });
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (message?.type === "AF_APPLICATION_TRACKED") {
    (async () => {
      try {
        const app = message.application || {};
        if (typeof afAddApplication === "function") {
          await afAddApplication({
            url: app.url || sender.tab?.url || "",
            title: app.title || "",
            company: app.company || "",
            description: app.description || "",
            answers: app.answers || [],
            source: app.source || "auto",
          });
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (message?.type === "AF_ENSURE_PAGE_ACCESS") {
    (async () => {
      try {
        const tab =
          message.tabId != null
            ? await chrome.tabs.get(message.tabId)
            : await afGetActiveTab();
        await afEnsurePageAccess(tab, { request: message.request !== false });
        sendResponse({ ok: true, tabId: tab.id, url: tab.url });
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
        // Hint path: do not prompt; require prior grant / active inject
        try {
          const tab = await chrome.tabs.get(tabId);
          await afEnsurePageAccess(tab, { request: false });
        } catch (_) {
          /* may already be injected */
        }
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

/**
 * Single entry-point for clearing ephemeral popup session data.
 * @param {"tab-activated"|"url"|"tab-removed"|"ttl"|"manual"} reason
 * @param {{ tabId?: number }} [ctx]
 */
async function afClearSessionData(reason, ctx = {}) {
  try {
    const { tabId } = ctx;
    const data = await chrome.storage.local.get(["af_last_preview", "af_last_essay"]);
    const blobs = [data.af_last_preview, data.af_last_essay].filter(Boolean);
    if (blobs.length === 0) return { cleared: false, reason };

    const now = Date.now();
    const expired = blobs.some(
      (b) => b.savedAt != null && now - Number(b.savedAt) > AF_POPUP_SESSION_TTL_MS
    );

    const onTab = (b) => b.tabId != null && tabId != null && Number(b.tabId) === Number(tabId);
    const otherTab = (b) => b.tabId != null && tabId != null && Number(b.tabId) !== Number(tabId);

    let clear = reason === "manual" || reason === "ttl" || expired;
    if (!clear && reason === "tab-activated") clear = blobs.some(otherTab);
    if (!clear && reason === "url") clear = blobs.some(onTab);
    if (!clear && reason === "tab-removed") clear = blobs.some(onTab);

    if (clear) {
      await chrome.storage.local.remove(["af_last_preview", "af_last_essay"]);
      return { cleared: true, reason };
    }
    return { cleared: false, reason };
  } catch (e) {
    console.warn("afClearSessionData failed", reason, e);
    return { cleared: false, reason, error: String(e) };
  }
}

// One dispatcher for all tab lifecycle events (no duplicated clear logic).
chrome.tabs.onActivated.addListener((activeInfo) => {
  afClearSessionData("tab-activated", { tabId: activeInfo.tabId });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  afClearSessionData("url", { tabId });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  afClearSessionData("tab-removed", { tabId });
});
