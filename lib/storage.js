// Wrapper over chrome.storage.local for the saved field library and settings
// (Gemini API key, selected model). Used in popup and options.
// Schema versioning: af_schema_version + afMigrateStorageIfNeeded on SW/popup start.

const AF_LIBRARY_KEY = "af_library";
const AF_SETTINGS_KEY = "af_settings";
const AF_SCHEMA_VERSION_KEY = "af_schema_version";
/** Bump when library/settings shape changes; add a step in afMigrateStorageIfNeeded. */
const AF_SCHEMA_VERSION = 1;

const AF_DEFAULT_SETTINGS = {
  geminiApiKey: "",
  geminiModel: "gemini-flash-lite-latest",
  useGeminiFallback: true,
  // Auto-search fields on pages: when enabled, content-script scans the DOM
  // and shows a floating hint if fillable fields are found.
  autoSearchMode: false,
  contextText: "",
  resumes: [], // [{ id, name, fileName, mimeType, dataBase64, textContent, uploadedAt }]
  defaultResumeId: "",
};

function afGetLibrary() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AF_LIBRARY_KEY], (result) => {
      const lib = result[AF_LIBRARY_KEY] || { entries: {} };
      if (!lib.entries || typeof lib.entries !== "object") lib.entries = {};
      resolve(lib);
    });
  });
}

function afSetLibrary(library) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AF_LIBRARY_KEY]: library }, resolve);
  });
}

// entries: array of { key, label, value, sourceUrl }
async function afSaveEntries(entries) {
  const library = await afGetLibrary();
  const now = new Date().toISOString();
  for (const entry of entries) {
    library.entries[entry.key] = {
      label: entry.label,
      value: entry.value,
      updatedAt: now,
      sourceUrl: entry.sourceUrl || "",
    };
  }
  await afSetLibrary(library);
  return library;
}

async function afDeleteEntry(key) {
  const library = await afGetLibrary();
  delete library.entries[key];
  await afSetLibrary(library);
  return library;
}

function afGetSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AF_SETTINGS_KEY], (result) => {
      resolve({ ...AF_DEFAULT_SETTINGS, ...(result[AF_SETTINGS_KEY] || {}) });
    });
  });
}

/**
 * Persist settings to chrome.storage.local ONLY.
 * geminiApiKey must never be written to storage.sync (if sync is added later).
 */
function afStripSecretsForSync(settings) {
  if (!settings || typeof settings !== "object") return {};
  const { geminiApiKey, ...safe } = settings;
  return safe;
}

function afSetSettings(settings) {
  return new Promise((resolve) => {
    // Always local — secrets stay on-device
    chrome.storage.local.set({ [AF_SETTINGS_KEY]: settings }, resolve);
  });
}

// --- Resume management (multiple uploaded PDF/DOCX files, one "default") ---

function afGenerateId() {
  return `r-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// resume: { name, fileName, mimeType, dataBase64, textContent }
async function afSaveResumeFile(resume) {
  const settings = await afGetSettings();
  const resumes = settings.resumes || [];
  resume.id = afGenerateId();
  resume.uploadedAt = new Date().toISOString();
  resumes.push(resume);
  settings.resumes = resumes;
  if (!settings.defaultResumeId) {
    settings.defaultResumeId = resume.id;
  }
  await afSetSettings(settings);
  return settings;
}

async function afRenameResume(id, name) {
  const settings = await afGetSettings();
  const resume = (settings.resumes || []).find((r) => r.id === id);
  if (resume) resume.name = name;
  await afSetSettings(settings);
  return settings;
}

async function afDeleteResume(id) {
  const settings = await afGetSettings();
  settings.resumes = (settings.resumes || []).filter((r) => r.id !== id);
  if (settings.defaultResumeId === id) {
    settings.defaultResumeId = settings.resumes[0]?.id || "";
  }
  await afSetSettings(settings);
  return settings;
}

async function afSetDefaultResume(id) {
  const settings = await afGetSettings();
  settings.defaultResumeId = id;
  await afSetSettings(settings);
  return settings;
}

/**
 * Migrate chrome.storage.local when AF_SCHEMA_VERSION increases.
 * v0 (missing) → v1: ensure library.entries object, settings shape, strip unknown junk later.
 */
async function afMigrateStorageIfNeeded() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AF_SCHEMA_VERSION_KEY, AF_LIBRARY_KEY, AF_SETTINGS_KEY], async (result) => {
      try {
        let version = Number(result[AF_SCHEMA_VERSION_KEY] || 0);
        if (!Number.isFinite(version) || version < 0) version = 0;

        let library = result[AF_LIBRARY_KEY];
        let settings = result[AF_SETTINGS_KEY];
        let dirty = false;

        // v0 → v1
        if (version < 1) {
          if (!library || typeof library !== "object") {
            library = { entries: {} };
            dirty = true;
          }
          if (!library.entries || typeof library.entries !== "object" || Array.isArray(library.entries)) {
            library.entries = {};
            dirty = true;
          }
          // Normalize entry shapes
          Object.keys(library.entries).forEach((key) => {
            const e = library.entries[key];
            if (!e || typeof e !== "object") {
              delete library.entries[key];
              dirty = true;
              return;
            }
            if (typeof e.value !== "string") {
              e.value = e.value == null ? "" : String(e.value);
              dirty = true;
            }
            if (typeof e.label !== "string") {
              e.label = e.label == null ? key : String(e.label);
              dirty = true;
            }
          });
          if (!settings || typeof settings !== "object") {
            settings = { ...AF_DEFAULT_SETTINGS };
            dirty = true;
          } else {
            settings = { ...AF_DEFAULT_SETTINGS, ...settings };
            if (!Array.isArray(settings.resumes)) {
              settings.resumes = [];
              dirty = true;
            }
          }
          version = 1;
          dirty = true;
        }

        if (dirty) {
          const payload = {
            [AF_SCHEMA_VERSION_KEY]: version,
            [AF_LIBRARY_KEY]: library || { entries: {} },
            [AF_SETTINGS_KEY]: settings || { ...AF_DEFAULT_SETTINGS },
          };
          chrome.storage.local.set(payload, () => resolve({ version, migrated: true }));
        } else if (result[AF_SCHEMA_VERSION_KEY] !== version) {
          chrome.storage.local.set({ [AF_SCHEMA_VERSION_KEY]: version }, () =>
            resolve({ version, migrated: false })
          );
        } else {
          resolve({ version, migrated: false });
        }
      } catch (e) {
        console.warn("afMigrateStorageIfNeeded failed", e);
        resolve({ version: AF_SCHEMA_VERSION, migrated: false, error: String(e) });
      }
    });
  });
}

if (typeof self !== "undefined") {
  self.afGetLibrary = afGetLibrary;
  self.afSetLibrary = afSetLibrary;
  self.afSaveEntries = afSaveEntries;
  self.afDeleteEntry = afDeleteEntry;
  self.afGetSettings = afGetSettings;
  self.afSetSettings = afSetSettings;
  self.afSaveResumeFile = afSaveResumeFile;
  self.afRenameResume = afRenameResume;
  self.afDeleteResume = afDeleteResume;
  self.afSetDefaultResume = afSetDefaultResume;
  self.afMigrateStorageIfNeeded = afMigrateStorageIfNeeded;
  self.afStripSecretsForSync = afStripSecretsForSync;
  self.AF_DEFAULT_SETTINGS = AF_DEFAULT_SETTINGS;
  self.AF_SCHEMA_VERSION = AF_SCHEMA_VERSION;
  self.AF_SCHEMA_VERSION_KEY = AF_SCHEMA_VERSION_KEY;
}
