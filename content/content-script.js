// Content script: DOM scanning, auto-search, floating hint, toast, apply.
// Injected into all frames (all_frames: true). Only the top frame owns UI (hint/toast)
// and auto-search; iframes only answer scan/apply/place messages.
// Guard against double injection via scripting.executeScript.

const AF_IS_TOP_FRAME = window === window.top;

if (self.__AF_CONTENT_SCRIPT__) {
  // Already live in this frame — still answer pings from new injectors.
  chrome.runtime.onMessage.addListener((message, _s, sendResponse) => {
    if (message?.type === "AF_PING") {
      sendResponse({ ok: true, top: AF_IS_TOP_FRAME, href: location.href, dup: true });
      return true;
    }
    return false;
  });
} else {
self.__AF_CONTENT_SCRIPT__ = true;

const AF_HINT_HOST_ID = "af-smart-hint-host";
const AF_TOAST_HOST_ID = "af-smart-toast-host";
const AF_SCAN_DEBOUNCE_MS = 600;

let afAutoSearchEnabled = false;
let afScanTimer = null;
let afObserver = null;
let afLastFieldCount = 0;
let afShortcutLabel = "Alt+Shift+A";
let afHintDismissedForUrl = "";

// --- Messages ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "AF_PING") {
    sendResponse({ ok: true, top: AF_IS_TOP_FRAME, href: location.href });
    return true;
  }

  if (message.type === "AF_SCAN_FIELDS") {
    const { fields, resumeUploadFields } = afCollectFields();
    sendResponse({ fields, resumeUploadFields, url: window.location.href });
    return true;
  }

  if (message.type === "AF_APPLY_VALUES") {
    const filledCount = afApplyValues(message.mapping || {});
    sendResponse({ filledCount });
    return true;
  }

  if (message.type === "AF_PLACE_FILE") {
    const { afId, base64, fileName, mimeType } = message;
    const ok = afPlaceFile(afId, base64, fileName, mimeType);
    sendResponse({ ok });
    return true;
  }

  // UI messages only make sense in the top frame (visible page chrome).
  if (message.type === "AF_TOAST") {
    if (!AF_IS_TOP_FRAME) {
      sendResponse({ ok: false, skipped: true });
      return true;
    }
    afShowToast(message.text || "", message.kind || "info");
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "AF_SET_AUTO_SEARCH") {
    if (!AF_IS_TOP_FRAME) {
      sendResponse({ ok: false, skipped: true });
      return true;
    }
    afSetAutoSearch(!!message.enabled);
    sendResponse({ ok: true });
    return true;
  }

  // Background asks top frame to re-scan after a nested frame mutated.
  if (message.type === "AF_RESCAN_HINT") {
    if (AF_IS_TOP_FRAME && afAutoSearchEnabled) {
      afScheduleScan();
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// --- Auto search mode (top frame only) ---

function afSetAutoSearch(enabled) {
  if (!AF_IS_TOP_FRAME) return;
  afAutoSearchEnabled = enabled;
  if (enabled) {
    afStartObserving();
    afStartNavWatcher();
    afScheduleScan();
  } else {
    afStopObserving();
    afStopNavWatcher();
    afHideHint();
    afLastFieldCount = 0;
  }
}

function afScheduleScan() {
  if (!afAutoSearchEnabled || !AF_IS_TOP_FRAME) return;
  if (afScanTimer) clearTimeout(afScanTimer);
  afScanTimer = setTimeout(() => {
    afScanTimer = null;
    afRunAutoScan();
  }, AF_SCAN_DEBOUNCE_MS);
}

async function afRunAutoScan() {
  if (!afAutoSearchEnabled || !AF_IS_TOP_FRAME) return;
  if (document.visibilityState === "hidden") return;

  try {
    // Full-tab scan via background so fields inside cross-origin iframes
    // (Greenhouse, Lever, etc.) are counted too.
    let fields = [];
    let resumeUploadFields = [];
    try {
      const res = await chrome.runtime.sendMessage({ type: "AF_SCAN_TAB" });
      if (res && res.ok !== false) {
        fields = res.fields || [];
        resumeUploadFields = res.resumeUploadFields || [];
      } else {
        throw new Error(res?.error || "scan failed");
      }
    } catch (_) {
      // Fallback: local document only (e.g. background not ready).
      const local = afCollectFields();
      fields = local.fields || [];
      resumeUploadFields = local.resumeUploadFields || [];
    }

    const emptyFields = (fields || []).filter((f) => !(f.value || "").trim());
    const count = emptyFields.length + (resumeUploadFields || []).length;
    afLastFieldCount = count;

    if (count > 0 && afHintDismissedForUrl !== location.href) {
      afShowHint(count, fields, resumeUploadFields);
    } else {
      afHideHint();
    }
  } catch (e) {
    console.warn("AF auto-scan failed", e);
  }
}

function afStartObserving() {
  if (!AF_IS_TOP_FRAME) return;
  if (afObserver) return;
  afObserver = new MutationObserver(() => afScheduleScan());
  if (document.documentElement) {
    // Only DOM structure — attributes on large SPAs are too noisy.
    afObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  document.addEventListener("visibilitychange", afOnVisibility, false);
  window.addEventListener("focus", afScheduleScan, false);
}

function afStopObserving() {
  if (afObserver) {
    afObserver.disconnect();
    afObserver = null;
  }
  if (afScanTimer) {
    clearTimeout(afScanTimer);
    afScanTimer = null;
  }
  document.removeEventListener("visibilitychange", afOnVisibility, false);
  window.removeEventListener("focus", afScheduleScan, false);
}

function afOnVisibility() {
  if (document.visibilityState === "visible") afScheduleScan();
}

// --- Hint UI (Shadow DOM to avoid breaking page styles) ---

function afEnsureHintHost() {
  let host = document.getElementById(AF_HINT_HOST_ID);
  if (host) return host;

  host = document.createElement("div");
  host.id = AF_HINT_HOST_ID;
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.zIndex = "2147483646";
  host.style.bottom = "20px";
  host.style.right = "20px";
  host.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap {
        display: flex;
        align-items: center;
        gap: 10px;
        background: linear-gradient(145deg, #161925 0%, #12141c 100%);
        color: #f2f3f7;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 999px;
        padding: 8px 10px 8px 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(109,124,255,0.08);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.2;
        max-width: min(380px, calc(100vw - 40px));
        animation: af-in 0.22s ease-out;
        cursor: default;
        user-select: none;
        backdrop-filter: blur(10px);
      }
      @keyframes af-in {
        from { opacity: 0; transform: translateY(10px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .bolt {
        width: 28px; height: 28px; border-radius: 9px; flex-shrink: 0;
        display: grid; place-items: center; color: #fff;
        background: linear-gradient(135deg, #5b6cff, #9b6dff);
        box-shadow: 0 4px 14px rgba(91,108,255,0.4);
      }
      .text { flex: 1; min-width: 0; }
      .title { font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub { font-size: 11px; color: #9aa3b8; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .fill-btn {
        border: none;
        background: linear-gradient(135deg, #5b6cff, #7a5cff);
        color: white;
        font-weight: 650;
        font-size: 12px;
        border-radius: 999px;
        padding: 7px 13px;
        cursor: pointer;
        flex-shrink: 0;
        box-shadow: 0 4px 12px rgba(91,108,255,0.35);
        font-family: inherit;
      }
      .fill-btn:hover { filter: brightness(1.08); }
      .fill-btn:disabled { opacity: 0.6; cursor: wait; filter: none; }
      .close {
        border: none;
        background: transparent;
        color: rgba(255,255,255,0.55);
        font-size: 14px;
        cursor: pointer;
        padding: 4px 6px;
        border-radius: 8px;
        flex-shrink: 0;
        line-height: 1;
      }
      .close:hover { background: rgba(255,255,255,0.08); color: #fff; }
    </style>
    <div class="wrap" part="wrap">
      <span class="bolt" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor"/></svg>
      </span>
      <div class="text">
        <div class="title" id="title">Autofill fields</div>
        <div class="sub" id="sub"></div>
      </div>
      <button class="fill-btn" id="fill" type="button">Fill</button>
      <button class="close" id="close" type="button" title="Hide">✕</button>
    </div>
  `;

  shadow.getElementById("fill").addEventListener("click", () => {
    afTriggerAutofillFromHint();
  });
  shadow.getElementById("close").addEventListener("click", () => {
    afHintDismissedForUrl = location.href;
    afHideHint();
  });

  (document.documentElement || document.body).appendChild(host);
  return host;
}

function afShowHint(count, fields, resumeUploadFields) {
  if (!AF_IS_TOP_FRAME) return;
  const host = afEnsureHintHost();
  const shadow = host.shadowRoot;

  let title = `${count} ${count === 1 ? "field" : "fields"} to autofill`;
  if ((resumeUploadFields || []).length > 0) {
    title += " · resume";
  }

  shadow.getElementById("title").textContent = title;
  shadow.getElementById("sub").textContent = `Shortcut: ${afShortcutLabel || "not set"}`;
  host.style.display = "block";
}

function afHideHint() {
  const host = document.getElementById(AF_HINT_HOST_ID);
  if (host) host.style.display = "none";
}

async function afTriggerAutofillFromHint() {
  const host = document.getElementById(AF_HINT_HOST_ID);
  const btn = host?.shadowRoot?.getElementById("fill");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "…";
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "AF_RUN_AUTOFILL",
      placeDefaultResume: true,
      notifyPage: true,
    });
    if (!response?.ok) {
      afShowToast(response?.error || "Autofill error", "error");
    }
  } catch (e) {
    afShowToast(e.message || String(e), "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Fill";
    }
    // Re-scan — some fields are now filled, but hint may still be useful.
    afScheduleScan();
  }
}

// --- Toast ---

function afShowToast(text, kind = "info") {
  if (!AF_IS_TOP_FRAME) return;
  let host = document.getElementById(AF_TOAST_HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = AF_TOAST_HOST_ID;
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.bottom = "72px";
    host.style.right = "20px";
    host.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .toast {
          background: linear-gradient(145deg, #161925, #12141c);
          color: #f2f3f7;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          padding: 11px 14px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 12.5px;
          font-weight: 500;
          line-height: 1.4;
          box-shadow: 0 12px 36px rgba(0,0,0,0.35);
          max-width: min(340px, calc(100vw - 40px));
          white-space: pre-line;
          animation: af-in 0.18s ease-out;
        }
        .toast.success {
          background: linear-gradient(145deg, #143528, #102a20);
          border-color: rgba(62, 207, 142, 0.35);
        }
        .toast.error {
          background: linear-gradient(145deg, #3a1515, #2a1010);
          border-color: rgba(255, 107, 107, 0.35);
        }
        .toast.info { }
        @keyframes af-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      </style>
      <div class="toast" id="toast"></div>
    `;
    (document.documentElement || document.body).appendChild(host);
  }

  const toast = host.shadowRoot.getElementById("toast");
  toast.className = `toast ${kind}`;
  toast.textContent = text;
  host.style.display = "block";

  if (host._afHideTimer) clearTimeout(host._afHideTimer);
  host._afHideTimer = setTimeout(() => {
    host.style.display = "none";
  }, 3200);
}

// --- Init ---

async function afInitContent() {
  // Nested frames only handle DOM scan/apply messages — no UI, no observers.
  if (!AF_IS_TOP_FRAME) return;

  try {
    const settings = await new Promise((resolve) => {
      chrome.storage.local.get(["af_settings"], (result) => {
        resolve(result.af_settings || {});
      });
    });
    afSetAutoSearch(!!settings.autoSearchMode);
  } catch (e) {
    console.warn("AF init settings failed", e);
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: "AF_GET_COMMAND_SHORTCUT" });
    if (res?.shortcut) afShortcutLabel = res.shortcut;
  } catch (_) {
    /* background may not be ready yet */
  }
}

if (AF_IS_TOP_FRAME) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.af_settings) return;
    const next = changes.af_settings.newValue || {};
    const prev = changes.af_settings.oldValue || {};
    if (!!next.autoSearchMode !== !!prev.autoSearchMode) {
      afHintDismissedForUrl = "";
      afSetAutoSearch(!!next.autoSearchMode);
    }
  });
}

// SPA navigations: pushState / replaceState / popstate (no polling).
let afLastHref = location.href;
let afHistoryPatched = false;

function afOnSpaUrlMaybeChanged() {
  if (!AF_IS_TOP_FRAME || !afAutoSearchEnabled) return;
  if (location.href === afLastHref) return;
  afLastHref = location.href;
  afHintDismissedForUrl = "";
  afScheduleScan();
}

function afPatchHistoryForSpa() {
  if (!AF_IS_TOP_FRAME || afHistoryPatched) return;
  afHistoryPatched = true;
  const wrap = (type) => {
    const orig = history[type];
    if (typeof orig !== "function") return;
    history[type] = function afPatchedHistory() {
      const ret = orig.apply(this, arguments);
      try {
        afOnSpaUrlMaybeChanged();
      } catch (_) {
        /* ignore */
      }
      return ret;
    };
  };
  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", afOnSpaUrlMaybeChanged);
  window.addEventListener("hashchange", afOnSpaUrlMaybeChanged);
}

function afStartNavWatcher() {
  if (!AF_IS_TOP_FRAME) return;
  afLastHref = location.href;
  afPatchHistoryForSpa();
}

function afStopNavWatcher() {
  // Keep history patches (cheap); scans only run while auto-search is enabled
  // via afOnSpaUrlMaybeChanged guard on afAutoSearchEnabled.
  afLastHref = location.href;
}

// Nested frames: when their DOM changes (SPA job form steps), ask top to re-scan.
// Only while auto-search is enabled — otherwise no observers in embeds.
if (!AF_IS_TOP_FRAME) {
  let afChildScanTimer = null;
  let afChildObserver = null;

  const notifyTop = () => {
    if (afChildScanTimer) clearTimeout(afChildScanTimer);
    afChildScanTimer = setTimeout(() => {
      afChildScanTimer = null;
      chrome.runtime.sendMessage({ type: "AF_FRAME_DOM_CHANGED" }).catch(() => {});
    }, AF_SCAN_DEBOUNCE_MS);
  };

  function afSetChildObserving(enabled) {
    if (enabled && !afChildObserver) {
      try {
        afChildObserver = new MutationObserver(notifyTop);
        if (document.documentElement) {
          afChildObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
      } catch (_) {
        afChildObserver = null;
      }
    } else if (!enabled && afChildObserver) {
      afChildObserver.disconnect();
      afChildObserver = null;
    }
  }

  chrome.storage.local.get(["af_settings"], (result) => {
    afSetChildObserving(!!(result.af_settings || {}).autoSearchMode);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.af_settings) return;
    afSetChildObserving(!!(changes.af_settings.newValue || {}).autoSearchMode);
  });
}

afInitContent();

} // end __AF_CONTENT_SCRIPT__ guard
