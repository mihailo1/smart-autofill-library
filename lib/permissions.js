// Host access helpers: optional permissions instead of permanent <all_urls>.
// Must be called from a user gesture (popup button / command) when requesting.

const AF_CONTENT_SCRIPT_FILES = [
  "lib/conceptVocabulary.js",
  "lib/fieldDetection.js",
  "lib/fieldActions.js",
  "content/content-script.js",
];

function afIsRestrictedUrl(url) {
  return !url || /^(chrome|chrome-extension|edge|about|devtools|chrome-search|chrome-devtools):/i.test(url);
}

function afOriginPatternFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}/*`;
  } catch (_) {
    return null;
  }
}

async function afHasOriginPermission(url) {
  const origin = afOriginPatternFromUrl(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

/**
 * Request optional host permission for the tab's origin (user gesture required).
 * Returns { ok, origin, granted, error }.
 */
async function afRequestOriginPermission(url) {
  const origin = afOriginPatternFromUrl(url);
  if (!origin) {
    return { ok: false, origin: null, granted: false, error: "This page cannot be accessed by the extension." };
  }
  try {
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (already) return { ok: true, origin, granted: true, already: true };
    const granted = await chrome.permissions.request({ origins: [origin] });
    return { ok: granted, origin, granted, already: false };
  } catch (e) {
    return { ok: false, origin, granted: false, error: e.message || String(e) };
  }
}

async function afContentScriptAlive(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "AF_PING" }, { frameId: 0 });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

/**
 * Inject content stack into all frames if not already present.
 * Works with activeTab (temporary) or permanent optional host permission.
 */
async function afInjectContentScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: AF_CONTENT_SCRIPT_FILES,
  });
}

/**
 * Ensure we can talk to the page: optional origin permission + content scripts.
 * @param {chrome.tabs.Tab} tab
 * @param {{ request?: boolean }} options — request=true shows permission prompt (user gesture)
 */
async function afEnsurePageAccess(tab, options = {}) {
  const { request = true } = options;
  if (!tab || tab.id == null) {
    throw new Error("No active tab.");
  }
  if (afIsRestrictedUrl(tab.url)) {
    throw new Error("This extension doesn't work on this page.");
  }

  if (request) {
    const perm = await afRequestOriginPermission(tab.url);
    if (!perm.ok && perm.error && !perm.origin) throw new Error(perm.error);
    // If user denied permanent grant, still try activeTab injection (popup/command gesture).
  }

  const alive = await afContentScriptAlive(tab.id);
  if (!alive) {
    try {
      await afInjectContentScripts(tab.id);
    } catch (e) {
      // Second chance: request permission then inject
      if (request) {
        const perm = await afRequestOriginPermission(tab.url);
        if (!perm.ok) {
          throw new Error(
            perm.error ||
              "Permission denied. Click Autofill again and allow access for this site."
          );
        }
        await afInjectContentScripts(tab.id);
      } else {
        throw new Error(e.message || "Could not access the page. Allow this site or refresh.");
      }
    }
  }

  return { tabId: tab.id, url: tab.url };
}

if (typeof self !== "undefined") {
  self.AF_CONTENT_SCRIPT_FILES = AF_CONTENT_SCRIPT_FILES;
  self.afIsRestrictedUrl = afIsRestrictedUrl;
  self.afOriginPatternFromUrl = afOriginPatternFromUrl;
  self.afHasOriginPermission = afHasOriginPermission;
  self.afRequestOriginPermission = afRequestOriginPermission;
  self.afContentScriptAlive = afContentScriptAlive;
  self.afInjectContentScripts = afInjectContentScripts;
  self.afEnsurePageAccess = afEnsurePageAccess;
}
