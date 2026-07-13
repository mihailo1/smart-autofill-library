const apiKeyInput = document.getElementById("af-api-key");
const modelInput = document.getElementById("af-model");
const useGeminiInput = document.getElementById("af-use-gemini");
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
  contextInput.value = settings.contextText || "";
}

saveSettingsBtn.addEventListener("click", async () => {
  const settings = await afGetSettings();
  settings.geminiApiKey = apiKeyInput.value.trim();
  settings.geminiModel = modelInput.value.trim() || AF_DEFAULT_SETTINGS.geminiModel;
  settings.useGeminiFallback = useGeminiInput.checked;
  await afSetSettings(settings);
  settingsStatusEl.textContent = "Сохранено ✓";
  setTimeout(() => (settingsStatusEl.textContent = ""), 2000);
});

saveContextBtn.addEventListener("click", async () => {
  const settings = await afGetSettings();
  settings.contextText = contextInput.value;
  await afSetSettings(settings);
  contextStatusEl.textContent = "Сохранено ✓";
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
      <button class="af-delete-btn" data-key="${escapeAttr(key)}">Удалить</button>
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

// --- Резюме (файлы PDF/DOCX) ---

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

  resumeUploadStatusEl.textContent = "Загружаю и извлекаю текст...";
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

    resumeUploadStatusEl.textContent = extraction.warning ? `Загружено (⚠ ${extraction.warning})` : "Загружено ✓";
    setTimeout(() => (resumeUploadStatusEl.textContent = ""), extraction.warning ? 6000 : 2000);
    resumeFileInput.value = "";
    loadResumes();
  } catch (err) {
    resumeUploadStatusEl.textContent = `Ошибка: ${err.message}`;
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
          <span>По умолчанию</span>
        </label>
        <button class="af-delete-btn" data-id="${escapeAttr(resume.id)}">Удалить</button>
      </div>
      <input type="text" class="af-resume-name" value="${escapeAttr(resume.name)}" data-id="${escapeAttr(resume.id)}" placeholder="Название резюме (например «Frontend», «Продукт»)" />
      <div class="af-resume-file-meta">
        📄 ${escapeAttr(resume.fileName || "файл")}
        ${resume.textContent ? `<span class="af-resume-text-ok">текст извлечён (${resume.textContent.length} симв.)</span>` : `<span class="af-resume-text-warn">текст не извлечён</span>`}
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

// Версия берётся из манифеста, чтобы не поддерживать её в двух местах.
const versionEl = document.getElementById("af-version");
if (versionEl && typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
}

loadSettings();
loadLibrary();
loadResumes();
