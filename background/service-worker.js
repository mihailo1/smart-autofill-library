// Background service worker: keyboard shortcuts and requests from content-script / popup.
// importScripts loads shared modules (classic scripts, no ES modules).

importScripts(
  "../lib/storage.js",
  "../lib/conceptVocabulary.js",
  "../lib/matcher.js",
  "../lib/geminiClient.js",
  "../lib/autofillEngine.js"
);

const AF_COMMAND_AUTOFILL = "af-autofill";
const AF_COMMAND_SAVE = "af-save-library";

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
    await chrome.tabs.sendMessage(tabId, {
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

  if (message?.type === "AF_GET_COMMAND_SHORTCUT") {
    chrome.commands.getAll((commands) => {
      const list = commands || [];
      const autofill = list.find((c) => c.name === AF_COMMAND_AUTOFILL);
      const save = list.find((c) => c.name === AF_COMMAND_SAVE);
      sendResponse({
        shortcut: autofill?.shortcut || "",
        saveShortcut: save?.shortcut || "",
        shortcuts: {
          autofill: autofill?.shortcut || "",
          save: save?.shortcut || "",
        },
      });
    });
    return true;
  }

  return false;
});
