// Обёртка над chrome.storage.local для библиотеки сохранённых значений полей и настроек
// (API-ключ Gemini, выбранная модель). Используется в popup и options.

const AF_LIBRARY_KEY = "af_library";
const AF_SETTINGS_KEY = "af_settings";

const AF_DEFAULT_SETTINGS = {
  geminiApiKey: "",
  geminiModel: "gemini-flash-lite-latest",
  useGeminiFallback: true,
  contextText: "",
  resumes: [], // [{ id, name, fileName, mimeType, dataBase64, textContent, uploadedAt }]
  defaultResumeId: "",
};

function afGetLibrary() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AF_LIBRARY_KEY], (result) => {
      resolve(result[AF_LIBRARY_KEY] || { entries: {} });
    });
  });
}

function afSetLibrary(library) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AF_LIBRARY_KEY]: library }, resolve);
  });
}

// entries: массив { key, label, value, sourceUrl }
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

function afSetSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AF_SETTINGS_KEY]: settings }, resolve);
  });
}

// --- Управление резюме (несколько загруженных файлов PDF/DOCX, одно "по умолчанию") ---

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
  self.AF_DEFAULT_SETTINGS = AF_DEFAULT_SETTINGS;
}
