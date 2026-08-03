const apiKeyInput = document.getElementById("af-api-key");
const modelInput = document.getElementById("af-model");
const useGeminiInput = document.getElementById("af-use-gemini");
const autoSearchInput = document.getElementById("af-auto-search");
const shortcutCurrentEl = document.getElementById("af-shortcut-current");
const saveShortcutCurrentEl = document.getElementById("af-save-shortcut-current");
const autoSearchShortcutCurrentEl = document.getElementById("af-auto-search-shortcut-current");
const saveSettingsBtn = document.getElementById("af-save-settings");
const settingsStatusEl = document.getElementById("af-settings-status");
const libraryListEl = document.getElementById("af-library-list");
const libraryEmptyEl = document.getElementById("af-library-empty");
const refreshLibraryBtn = document.getElementById("af-refresh-library");
const contextInput = document.getElementById("af-context");
const saveContextBtn = document.getElementById("af-save-context");
const contextStatusEl = document.getElementById("af-context-status");
const resumeListEl = document.getElementById("af-resume-list");
const resumeEmptyEl = document.getElementById("af-resume-empty");
const resumeFileInput = document.getElementById("af-resume-file-input");
const resumeUploadStatusEl = document.getElementById("af-resume-upload-status");

async function loadSettings() {
  const settings = await afGetSettings();
  apiKeyInput.value = settings.geminiApiKey || "";
  modelInput.value = settings.geminiModel || AF_DEFAULT_SETTINGS.geminiModel;
  useGeminiInput.checked = !!settings.useGeminiFallback;
  autoSearchInput.checked = !!settings.autoSearchMode;
  contextInput.value = settings.contextText || "";
}

autoSearchInput.addEventListener("change", async () => {
  const settings = await afGetSettings();
  settings.autoSearchMode = autoSearchInput.checked;
  await afSetSettings(settings);
});

function afShortcutOrUnset(value, fallback) {
  return value || fallback || "not set";
}

async function loadShortcutLabel() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "AF_GET_COMMAND_SHORTCUT" });
    const autofill = res?.shortcut || res?.shortcuts?.autofill || "";
    const save = res?.saveShortcut || res?.shortcuts?.save || "";
    const autoSearch = res?.autoSearchShortcut || res?.shortcuts?.autoSearch || "";
    if (shortcutCurrentEl) shortcutCurrentEl.textContent = afShortcutOrUnset(autofill, "Alt+Shift+A");
    if (saveShortcutCurrentEl) saveShortcutCurrentEl.textContent = afShortcutOrUnset(save, "Alt+Shift+S");
    if (autoSearchShortcutCurrentEl) {
      autoSearchShortcutCurrentEl.textContent = afShortcutOrUnset(autoSearch, "Alt+Shift+F");
    }
  } catch (e) {
    if (shortcutCurrentEl) shortcutCurrentEl.textContent = "Alt+Shift+A";
    if (saveShortcutCurrentEl) saveShortcutCurrentEl.textContent = "Alt+Shift+S";
    if (autoSearchShortcutCurrentEl) autoSearchShortcutCurrentEl.textContent = "Alt+Shift+F";
  }
}

// chrome:// links often blocked from <a>; open via API
const openShortcutsLink = document.getElementById("af-open-shortcuts");
if (openShortcutsLink) {
  openShortcutsLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
}

saveSettingsBtn.addEventListener("click", async () => {
  const settings = await afGetSettings();
  settings.geminiApiKey = apiKeyInput.value.trim();
  settings.geminiModel = modelInput.value.trim() || AF_DEFAULT_SETTINGS.geminiModel;
  settings.useGeminiFallback = useGeminiInput.checked;
  settings.autoSearchMode = autoSearchInput.checked;
  await afSetSettings(settings);
  settingsStatusEl.textContent = "Saved ✓";
  setTimeout(() => (settingsStatusEl.textContent = ""), 2000);
});

saveContextBtn.addEventListener("click", async () => {
  const settings = await afGetSettings();
  settings.contextText = contextInput.value;
  await afSetSettings(settings);
  contextStatusEl.textContent = "Saved ✓";
  setTimeout(() => (contextStatusEl.textContent = ""), 2000);
});

function escapeAttr(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function loadLibrary() {
  const library = await afGetLibrary();
  const keys = Object.keys(library.entries);
  libraryListEl.innerHTML = "";
  libraryEmptyEl.classList.toggle("hidden", keys.length > 0);

  keys.forEach((key) => {
    const entry = library.entries[key];
    const row = document.createElement("div");
    row.className = "af-library-item";
    row.innerHTML = `
      <div>
        <input type="text" class="af-lib-label" value="${escapeAttr(entry.label)}" data-key="${escapeAttr(key)}" />
        <div class="af-key-label">${escapeAttr(key)}</div>
      </div>
      <input type="text" class="af-lib-value" value="${escapeAttr(entry.value)}" data-key="${escapeAttr(key)}" />
      <button class="af-delete-btn" data-key="${escapeAttr(key)}">Delete</button>
    `;
    libraryListEl.appendChild(row);
  });

  libraryListEl.querySelectorAll(".af-lib-label, .af-lib-value").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const key = e.target.dataset.key;
      const lib = await afGetLibrary();
      if (!lib.entries[key]) return;
      if (e.target.classList.contains("af-lib-label")) {
        lib.entries[key].label = e.target.value;
      } else {
        lib.entries[key].value = e.target.value;
      }
      await afSetLibrary(lib);
    });
  });

  libraryListEl.querySelectorAll(".af-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      await afDeleteEntry(e.target.dataset.key);
      loadLibrary();
    });
  });
}

refreshLibraryBtn.addEventListener("click", loadLibrary);

// --- Resumes (PDF/DOCX files) ---

function afFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // data:mime;base64,XXXX
      const base64 = result.split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

resumeFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  resumeUploadStatusEl.textContent = "Uploading and extracting text...";
  try {
    const [dataBase64, extraction] = await Promise.all([
      afFileToBase64(file),
      afExtractResumeText(file),
    ]);

    await afSaveResumeFile({
      name: file.name.replace(/\.(pdf|docx)$/i, ""),
      fileName: file.name,
      mimeType: file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      dataBase64,
      textContent: extraction.text || "",
    });

    resumeUploadStatusEl.textContent = extraction.warning ? `Uploaded (⚠ ${extraction.warning})` : "Uploaded ✓";
    setTimeout(() => (resumeUploadStatusEl.textContent = ""), extraction.warning ? 6000 : 2000);
    resumeFileInput.value = "";
    loadResumes();
  } catch (err) {
    resumeUploadStatusEl.textContent = `Error: ${err.message}`;
  }
});

async function loadResumes() {
  const settings = await afGetSettings();
  const resumes = settings.resumes || [];
  resumeListEl.innerHTML = "";
  resumeEmptyEl.classList.toggle("hidden", resumes.length > 0);

  resumes.forEach((resume) => {
    const isDefault = resume.id === settings.defaultResumeId;
    const row = document.createElement("div");
    row.className = "af-resume-item" + (isDefault ? " af-resume-item-active" : "");
    row.innerHTML = `
      <div class="af-resume-item-top">
        <label class="af-radio">
          <input type="radio" name="af-default-resume" data-id="${escapeAttr(resume.id)}" ${isDefault ? "checked" : ""} />
          <span>Default</span>
        </label>
        <button class="af-delete-btn" data-id="${escapeAttr(resume.id)}">Delete</button>
      </div>
      <input type="text" class="af-resume-name" value="${escapeAttr(resume.name)}" data-id="${escapeAttr(resume.id)}" placeholder="Resume name (e.g. 'Frontend', 'Product')" />
      <div class="af-resume-file-meta">
        📄 ${escapeAttr(resume.fileName || "file")}
        ${resume.textContent ? `<span class="af-resume-text-ok">text extracted (${resume.textContent.length} chars)</span>` : `<span class="af-resume-text-warn">text not extracted</span>`}
      </div>
    `;
    resumeListEl.appendChild(row);
  });

  resumeListEl.querySelectorAll('input[name="af-default-resume"]').forEach((radio) => {
    radio.addEventListener("change", async (e) => {
      await afSetDefaultResume(e.target.dataset.id);
      loadResumes();
    });
  });

  resumeListEl.querySelectorAll(".af-resume-name").forEach((input) => {
    input.addEventListener("change", async (e) => {
      await afRenameResume(e.target.dataset.id, e.target.value);
    });
  });

  resumeListEl.querySelectorAll(".af-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      await afDeleteResume(e.target.dataset.id);
      loadResumes();
    });
  });
}

// --- Applications tracker table ---

const applicationsBody = document.getElementById("af-applications-body");
const applicationsEmpty = document.getElementById("af-applications-empty");
const refreshApplicationsBtn = document.getElementById("af-refresh-applications");

function afEscapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function afFormatWhen(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_) {
    return "—";
  }
}

async function loadApplications() {
  if (!applicationsBody) return;
  const list = typeof afGetApplications === "function" ? await afGetApplications() : [];
  applicationsBody.innerHTML = "";
  if (applicationsEmpty) applicationsEmpty.classList.toggle("hidden", list.length > 0);
  const table = document.getElementById("af-applications-table");
  if (table) table.classList.toggle("hidden", list.length === 0);

  list.forEach((app) => {
    const tr = document.createElement("tr");
    const jobLabel = [app.title, app.company].filter(Boolean).join(" · ") || "Untitled job";
    const desc = (app.description || "").slice(0, 160);
    const qa = (app.answers || [])
      .slice(0, 6)
      .map((a) => `<div class="af-app-qa"><strong>${afEscapeHtml(a.q)}</strong><span>${afEscapeHtml(a.a)}</span></div>`)
      .join("");
    const more =
      (app.answers || []).length > 6
        ? `<div class="af-app-qa-more">+${(app.answers || []).length - 6} more</div>`
        : "";
    tr.innerHTML = `
      <td class="af-app-when">${afEscapeHtml(afFormatWhen(app.submittedAt))}</td>
      <td class="af-app-job">
        <div class="af-app-job-title">${afEscapeHtml(jobLabel)}</div>
        ${desc ? `<div class="af-app-job-desc">${afEscapeHtml(desc)}</div>` : ""}
      </td>
      <td class="af-app-link"><a href="${afEscapeHtml(app.url)}" target="_blank" rel="noopener">Open</a></td>
      <td class="af-app-answers">${qa || "—"}${more}</td>
      <td><button type="button" class="af-delete-btn" data-id="${afEscapeHtml(app.id)}">Delete</button></td>
    `;
    applicationsBody.appendChild(tr);
  });

  applicationsBody.querySelectorAll(".af-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (typeof afDeleteApplication === "function") {
        await afDeleteApplication(btn.dataset.id);
        loadApplications();
      }
    });
  });
}

refreshApplicationsBtn?.addEventListener("click", () => loadApplications());

// Version taken from manifest to avoid maintaining it in two places.
const versionEl = document.getElementById("af-version");
if (versionEl && typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
}

loadSettings();
loadShortcutLabel();
loadLibrary();
loadResumes();
loadApplications();
