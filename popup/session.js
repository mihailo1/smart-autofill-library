// AF.popup.session — classic-script module (no bundler).
(function (global) {
  const AF = global.AF || (global.AF = {});
  AF.popup = AF.popup || {};

/** Popup session (save preview / essay answers) survives close until tab change, URL change, or TTL. */
const AF_POPUP_SESSION_TTL_MS = 30 * 60 * 1000;

async function clearPopupState() {
  try {
    await new Promise((res) => chrome.storage.local.remove(["af_last_preview", "af_last_essay"], res));
  } catch (err) {
    console.warn("Failed to clear popup temp state", err);
  }
}

async function clearPreviewState() {
  try {
    await new Promise((res) => chrome.storage.local.remove(["af_last_preview"], res));
  } catch (err) {
    console.warn("Failed to clear preview state", err);
  }
}

async function clearEssayState() {
  try {
    await new Promise((res) => chrome.storage.local.remove(["af_last_essay"], res));
  } catch (err) {
    console.warn("Failed to clear essay state", err);
  }
}

function afSessionStillValid(blob, tab) {
  if (!blob || !tab) return false;
  if (blob.tabId != null && tab.id != null && Number(blob.tabId) !== Number(tab.id)) return false;
  const tabUrl = tab.url || "";
  if (blob.sourceUrl && blob.sourceUrl !== tabUrl) return false;
  if (blob.savedAt != null && Date.now() - Number(blob.savedAt) > AF_POPUP_SESSION_TTL_MS) return false;
  // Legacy blobs without tabId/savedAt: only restore if URL still matches.
  if (blob.savedAt == null && blob.sourceUrl && blob.sourceUrl !== tabUrl) return false;
  return !!(blob.sourceUrl || blob.tabId != null);
}

async function afPersistPreview(items, sourceUrl, tabId) {
  const payload = {
    items,
    sourceUrl: sourceUrl || "",
    tabId: tabId != null ? tabId : null,
    savedAt: Date.now(),
  };
  await new Promise((res) => chrome.storage.local.set({ af_last_preview: payload }, res));
}

async function afPersistEssay(fields, sourceUrl, tabId) {
  const payload = {
    fields,
    sourceUrl: sourceUrl || "",
    tabId: tabId != null ? tabId : null,
    savedAt: Date.now(),
  };
  await new Promise((res) => chrome.storage.local.set({ af_last_essay: payload }, res));
}

/** Hide UI only — keep storage so reopening the popup restores progress. */
function hidePreview(options = {}) {
  const { clearStorage = false } = options;
  previewEl.classList.add("hidden");
  previewListEl.innerHTML = "";
  if (clearStorage) clearPreviewState();
}

function hideEssayPanel(options = {}) {
  const { clearStorage = false } = options;
  essayPanelEl.classList.add("hidden");
  essayListEl.innerHTML = "";
  if (clearStorage) clearEssayState();
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

  AF.popup.session = { clearPopupState, clearPreviewState, clearEssayState, afSessionStillValid, afPersistPreview, afPersistEssay, hidePreview, hideEssayPanel, hideResumeMenu, getActiveTab, scanPage, refreshLibraryCount };
  global.clearPopupState = clearPopupState;
  global.clearPreviewState = clearPreviewState;
  global.clearEssayState = clearEssayState;
  global.afSessionStillValid = afSessionStillValid;
  global.afPersistPreview = afPersistPreview;
  global.afPersistEssay = afPersistEssay;
  global.hidePreview = hidePreview;
  global.hideEssayPanel = hideEssayPanel;
  global.hideResumeMenu = hideResumeMenu;
  global.getActiveTab = getActiveTab;
  global.scanPage = scanPage;
  global.refreshLibraryCount = refreshLibraryCount;
})(typeof self !== "undefined" ? self : window);
