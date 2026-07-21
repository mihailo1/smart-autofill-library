// Content script: DOM-сканирование, автопоиск полей, плавающий хинт, toast, apply.
// Сообщения от popup / background; сам не ходит в сеть и не читает значения библиотеки.

const AF_HINT_HOST_ID = "af-smart-hint-host";
const AF_TOAST_HOST_ID = "af-smart-toast-host";
const AF_SCAN_DEBOUNCE_MS = 600;

let afAutoSearchEnabled = false;
let afScanTimer = null;
let afObserver = null;
let afLastFieldCount = 0;
let afShortcutLabel = "Alt+Shift+A";
let afHintDismissedForUrl = "";

// --- Сообщения ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  if (message.type === "AF_TOAST") {
    afShowToast(message.text || "", message.kind || "info");
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "AF_SET_AUTO_SEARCH") {
    afSetAutoSearch(!!message.enabled);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// --- Auto search mode ---

function afSetAutoSearch(enabled) {
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
  if (!afAutoSearchEnabled) return;
  if (afScanTimer) clearTimeout(afScanTimer);
  afScanTimer = setTimeout(() => {
    afScanTimer = null;
    afRunAutoScan();
  }, AF_SCAN_DEBOUNCE_MS);
}

function afRunAutoScan() {
  if (!afAutoSearchEnabled) return;
  if (document.visibilityState === "hidden") return;

  try {
    const { fields, resumeUploadFields } = afCollectFields();
    // Считаем только пустые поля — уже заполненные не должны держать хинт.
    // Пустые essay тоже считаем — пользователю полезно знать, что форма есть.
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
  if (afObserver) return;
  afObserver = new MutationObserver(() => afScheduleScan());
  if (document.documentElement) {
    // Только структура DOM — атрибуты на больших SPA слишком шумные.
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

// --- Hint UI (Shadow DOM, чтобы не ломать стили страницы) ---

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
        gap: 8px;
        background: #1f2430;
        color: #fff;
        border-radius: 999px;
        padding: 8px 10px 8px 14px;
        box-shadow: 0 8px 28px rgba(20, 30, 60, 0.28);
        font-size: 13px;
        line-height: 1.2;
        max-width: min(360px, calc(100vw - 40px));
        animation: af-in 0.2s ease-out;
        cursor: default;
        user-select: none;
      }
      @keyframes af-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .icon { font-size: 14px; flex-shrink: 0; }
      .text { flex: 1; min-width: 0; }
      .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub { font-size: 11px; opacity: 0.72; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .fill-btn {
        border: none;
        background: #2f6fed;
        color: white;
        font-weight: 600;
        font-size: 12px;
        border-radius: 999px;
        padding: 6px 12px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .fill-btn:hover { background: #2563d9; }
      .fill-btn:disabled { opacity: 0.6; cursor: wait; }
      .close {
        border: none;
        background: transparent;
        color: rgba(255,255,255,0.7);
        font-size: 14px;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 6px;
        flex-shrink: 0;
        line-height: 1;
      }
      .close:hover { background: rgba(255,255,255,0.12); color: #fff; }
    </style>
    <div class="wrap" part="wrap">
      <span class="icon">⚡</span>
      <div class="text">
        <div class="title" id="title">Поля для автозаполнения</div>
        <div class="sub" id="sub"></div>
      </div>
      <button class="fill-btn" id="fill" type="button">Заполнить</button>
      <button class="close" id="close" type="button" title="Скрыть">✕</button>
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
  const host = afEnsureHintHost();
  const shadow = host.shadowRoot;

  let title = `${count} ${afPluralFields(count)} для автозаполнения`;
  if ((resumeUploadFields || []).length > 0) {
    title += " · резюме";
  }

  shadow.getElementById("title").textContent = title;
  shadow.getElementById("sub").textContent = `Шорткат: ${afShortcutLabel || "не задан"}`;
  host.style.display = "block";
}

function afHideHint() {
  const host = document.getElementById(AF_HINT_HOST_ID);
  if (host) host.style.display = "none";
}

function afPluralFields(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "поле";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "поля";
  return "полей";
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
      afShowToast(response?.error || "Ошибка автозаполнения", "error");
    }
  } catch (e) {
    afShowToast(e.message || String(e), "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Заполнить";
    }
    // Пересканируем — часть полей уже заполнена, но хинт можно оставить.
    afScheduleScan();
  }
}

// --- Toast ---

function afShowToast(text, kind = "info") {
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
          background: #1f2430;
          color: #fff;
          border-radius: 10px;
          padding: 10px 14px;
          font-size: 13px;
          line-height: 1.35;
          box-shadow: 0 8px 28px rgba(20, 30, 60, 0.28);
          max-width: min(340px, calc(100vw - 40px));
          white-space: pre-line;
          animation: af-in 0.18s ease-out;
        }
        .toast.success { background: #1a7f4b; }
        .toast.error { background: #b42318; }
        .toast.info { background: #1f2430; }
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.af_settings) return;
  const next = changes.af_settings.newValue || {};
  const prev = changes.af_settings.oldValue || {};
  if (!!next.autoSearchMode !== !!prev.autoSearchMode) {
    afHintDismissedForUrl = "";
    afSetAutoSearch(!!next.autoSearchMode);
  }
});

// SPA navigations: soft URL change. Ватчер живёт только пока автопоиск включён.
let afNavIntervalId = null;
let afLastHref = location.href;

function afStartNavWatcher() {
  if (afNavIntervalId != null) return;
  afLastHref = location.href;
  afNavIntervalId = setInterval(() => {
    if (location.href !== afLastHref) {
      afLastHref = location.href;
      afHintDismissedForUrl = "";
      afScheduleScan();
    }
  }, 1000);
}

function afStopNavWatcher() {
  if (afNavIntervalId != null) {
    clearInterval(afNavIntervalId);
    afNavIntervalId = null;
  }
}

afInitContent();
