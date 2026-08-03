// Popup DOM element map + shared state (AF.popup.els / AF.popup.state).
// Load after lib/af.js, before other popup modules.
(function (global) {
  const AF = global.AF || (global.AF = {});
  AF.popup = AF.popup || {};
  AF.popup.els = {
    statusEl: document.getElementById("af-status"),
    autofillBtn: document.getElementById("af-autofill-btn"),
    scanSaveBtn: document.getElementById("af-scan-save-btn"),
    autoSearchInput: document.getElementById("af-auto-search"),
    shortcutLabelEl: document.getElementById("af-shortcut-label"),
    saveShortcutLabelEl: document.getElementById("af-save-shortcut-label"),
    autoSearchShortcutChipEl: document.getElementById("af-auto-search-shortcut-chip"),
    shortcutLinkEl: document.getElementById("af-shortcut-link"),
    previewEl: document.getElementById("af-preview"),
    previewListEl: document.getElementById("af-preview-list"),
    libraryCountEl: document.getElementById("af-library-count"),
    essayPanelEl: document.getElementById("af-essay-panel"),
    essayListEl: document.getElementById("af-essay-list"),
    resumeMenuEl: document.getElementById("af-resume-menu"),
    resumeMenuListEl: document.getElementById("af-resume-menu-list"),
    resumeMenuTitleEl: document.getElementById("af-resume-menu-title"),
    mainViewEl: document.getElementById("af-main-view"),
    libraryViewEl: document.getElementById("af-library-view"),
    librarySearchEl: document.getElementById("af-library-search"),
    librarySearchClearEl: document.getElementById("af-library-search-clear"),
    libraryBrowserListEl: document.getElementById("af-library-browser-list"),
    libraryEmptyEl: document.getElementById("af-library-empty"),
    libraryNoResultsEl: document.getElementById("af-library-no-results"),
    toggleLibraryBtn: document.getElementById("af-toggle-library"),
    headerBrandEl: document.getElementById("af-header-brand"),
    headerSearchEl: document.getElementById("af-header-search"),
    appEl: document.querySelector(".af-app"),
    libraryCloseBtn: document.getElementById("af-library-close"),
  };
  AF.popup.state = {
    chosenResume: null,
    libraryMode: false,
    libraryCache: [],
    librarySearchQuery: "",
    librarySaveTimer: null,
  };
  // Flat aliases for gradual migration (same names as old popup.js)
  const e = AF.popup.els;
  global.statusEl = e.statusEl;
  global.autofillBtn = e.autofillBtn;
  global.scanSaveBtn = e.scanSaveBtn;
  global.autoSearchInput = e.autoSearchInput;
  global.shortcutLabelEl = e.shortcutLabelEl;
  global.saveShortcutLabelEl = e.saveShortcutLabelEl;
  global.autoSearchShortcutChipEl = e.autoSearchShortcutChipEl;
  global.shortcutLinkEl = e.shortcutLinkEl;
  global.previewEl = e.previewEl;
  global.previewListEl = e.previewListEl;
  global.libraryCountEl = e.libraryCountEl;
  global.essayPanelEl = e.essayPanelEl;
  global.essayListEl = e.essayListEl;
  global.resumeMenuEl = e.resumeMenuEl;
  global.resumeMenuListEl = e.resumeMenuListEl;
  global.resumeMenuTitleEl = e.resumeMenuTitleEl;
  global.mainViewEl = e.mainViewEl;
  global.libraryViewEl = e.libraryViewEl;
  global.librarySearchEl = e.librarySearchEl;
  global.librarySearchClearEl = e.librarySearchClearEl;
  global.libraryBrowserListEl = e.libraryBrowserListEl;
  global.libraryEmptyEl = e.libraryEmptyEl;
  global.libraryNoResultsEl = e.libraryNoResultsEl;
  global.toggleLibraryBtn = e.toggleLibraryBtn;
  global.headerBrandEl = e.headerBrandEl;
  global.headerSearchEl = e.headerSearchEl;
  global.appEl = e.appEl;
  Object.defineProperty(global, "afChosenResume", {
    get() { return AF.popup.state.chosenResume; },
    set(v) { AF.popup.state.chosenResume = v; },
  });
  Object.defineProperty(global, "afLibraryMode", {
    get() { return AF.popup.state.libraryMode; },
    set(v) { AF.popup.state.libraryMode = v; },
  });
  Object.defineProperty(global, "afLibraryCache", {
    get() { return AF.popup.state.libraryCache; },
    set(v) { AF.popup.state.libraryCache = v; },
  });
  Object.defineProperty(global, "afLibrarySearchQuery", {
    get() { return AF.popup.state.librarySearchQuery; },
    set(v) { AF.popup.state.librarySearchQuery = v; },
  });
  Object.defineProperty(global, "afLibrarySaveTimer", {
    get() { return AF.popup.state.librarySaveTimer; },
    set(v) { AF.popup.state.librarySaveTimer = v; },
  });
})(typeof self !== "undefined" ? self : window);
