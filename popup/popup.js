// Popup: оркестрирует сканирование страницы, сопоставление с библиотекой (правила + Gemini
// fallback), генерацию ответов на вопросы вакансий и реальную подстановку файла резюме в
// поле загрузки. Все обращения к chrome.storage/Gemini API идут прямо отсюда — отдельный
// background service worker не нужен для этой лёгкой логики.

const statusEl = document.getElementById("af-status");
const autofillBtn = document.getElementById("af-autofill-btn");
const scanSaveBtn = document.getElementById("af-scan-save-btn");
const autoSearchInput = document.getElementById("af-auto-search");
const shortcutLabelEl = document.getElementById("af-shortcut-label");
const saveShortcutLabelEl = document.getElementById("af-save-shortcut-label");
const shortcutLinkEl = document.getElementById("af-shortcut-link");
const previewEl = document.getElementById("af-preview");
const previewListEl = document.getElementById("af-preview-list");
const libraryCountEl = document.getElementById("af-library-count");
const essayPanelEl = document.getElementById("af-essay-panel");
const essayListEl = document.getElementById("af-essay-list");
const resumeMenuEl = document.getElementById("af-resume-menu");
const resumeMenuListEl = document.getElementById("af-resume-menu-list");
const resumeMenuTitleEl = document.getElementById("af-resume-menu-title");

// Резюме, выбранное в текущем сеансе автозаполнения. Хранится на уровне модуля (а не в
// замыкании renderEssayPanel), чтобы обработчик ✨ читал его в момент клика — иначе при
// повторной перерисовке панели терялись бы уже введённые/сгенерированные ответы.
let afChosenResume = null;

document.getElementById("af-open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById("af-preview-close").addEventListener("click", hidePreview);
document.getElementById("af-preview-cancel").addEventListener("click", hidePreview);
document.getElementById("af-essay-close").addEventListener("click", hideEssayPanel);
document.getElementById("af-essay-cancel").addEventListener("click", hideEssayPanel);
// Кнопку закрытия меню резюме навешивает сам pickResume (там она резолвит промис в null),
// поэтому глобальный обработчик здесь не нужен.

function setStatus(text) {
  statusEl.textContent = text;
}

function escapeAttr(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function clearPopupState() {
  try {
    await new Promise((res) => chrome.storage.local.remove(["af_last_preview", "af_last_essay"], res));
  } catch (err) {
    console.warn("Не удалось очистить временное состояние попапа", err);
  }
}

function hidePreview() {
  previewEl.classList.add("hidden");
  previewListEl.innerHTML = "";
  clearPopupState();
}

function hideEssayPanel() {
  essayPanelEl.classList.add("hidden");
  essayListEl.innerHTML = "";
  clearPopupState();
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
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "AF_SCAN_FIELDS" });
  } catch (e) {
    throw new Error("Не удалось получить доступ к странице. Обновите страницу и попробуйте снова.");
  }
}

function afSlugFromField(field) {
  const raw = field.name || field.id || field.label || field.placeholder || field.ariaLabel || field.afId;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return `custom_${slug || field.afId}`;
}

async function refreshLibraryCount() {
  const library = await afGetLibrary();
  const count = Object.keys(library.entries).length;
  libraryCountEl.textContent = count > 0 ? `В библиотеке: ${count} полей` : "Библиотека пуста";
}

// --- Меню выбора резюме (появляется по клику "Автозаполнить", если есть что выбирать) ---

// Показывает меню и резолвит выбранный resume-объект (или null, если резюме нет/меню закрыли).
function pickResume(settings, title) {
  return new Promise((resolve) => {
    const resumes = settings.resumes || [];
    resumeMenuTitleEl.textContent = title;
    resumeMenuListEl.innerHTML = resumes
      .map(
        (r) => `
        <button class="af-resume-menu-item" data-id="${escapeAttr(r.id)}">
          <span class="af-resume-menu-name">${escapeAttr(r.name || r.fileName || "Резюме")}</span>
          ${r.id === settings.defaultResumeId ? '<span class="af-resume-menu-default">по умолчанию</span>' : ""}
        </button>
      `
      )
      .join("");
    resumeMenuEl.classList.remove("hidden");

    let settled = false;
    const finish = (resume) => {
      if (settled) return;
      settled = true;
      hideResumeMenu();
      resolve(resume);
    };

    resumeMenuListEl.querySelectorAll(".af-resume-menu-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const resume = resumes.find((r) => r.id === btn.dataset.id) || null;
        finish(resume);
      });
    });

    document.getElementById("af-resume-menu-close").addEventListener(
      "click",
      () => finish(null),
      { once: true }
    );
  });
}

// --- Автозаполнение ---

autofillBtn.addEventListener("click", async () => {
  autofillBtn.disabled = true;
  hideEssayPanel();
  hideResumeMenu();
  setStatus("Сканирую страницу...");
  try {
    const tab = await getActiveTab();
    const scanResult = await scanPage(tab.id);
    const allFields = scanResult.fields || [];
    const resumeUploadFields = scanResult.resumeUploadFields || [];

    if (allFields.length === 0 && resumeUploadFields.length === 0) {
      setStatus("На странице не найдено подходящих полей.");
      return;
    }

    const essayFields = allFields.filter((f) => f.isEssay);

    const library = await afGetLibrary();
    const settings = await afGetSettings();

    let filledCount = 0;
    let usedGemini = false;

    // Сопоставляем с библиотекой ВСЕ поля (включая "вопросы вакансии") — сохранённый ответ
    // всегда имеет приоритет над генерацией. Только те essay-поля, для которых в библиотеке
    // ничего не нашлось, отправятся ниже в панель ✨.
    afChosenResume = null;
    const filledAfIds = new Set();

    if (allFields.length > 0) {
      const ruleResult = afMatchFieldsToLibrary(allFields, library);
      const mapping = { ...ruleResult.mapping };

      if (settings.useGeminiFallback && settings.geminiApiKey && ruleResult.unmatched.length > 0) {
        setStatus("Сопоставляю оставшиеся поля через Gemini...");
        try {
          const geminiMatches = await afCallGeminiForMatching(ruleResult.unmatched, library, settings);
          geminiMatches.forEach(({ afId, libraryKey }) => {
            const entry = library.entries[libraryKey];
            if (entry && entry.value) {
              mapping[afId] = entry.value;
              usedGemini = true;
            }
          });
        } catch (e) {
          console.warn("Gemini matching failed", e);
          setStatus(`Gemini недоступен (${e.message}), использую только правила.`);
        }
      }

      if (Object.keys(mapping).length > 0) {
        const applyResult = await chrome.tabs.sendMessage(tab.id, { type: "AF_APPLY_VALUES", mapping });
        filledCount = applyResult.filledCount;
        Object.keys(mapping).forEach((afId) => filledAfIds.add(afId));
      }
    }

    // В панель ✨ идут только те вопросы вакансии, для которых в библиотеке не нашлось ответа.
    const essayFieldsToGenerate = essayFields.filter((f) => !filledAfIds.has(f.afId));
    if (essayFieldsToGenerate.length > 0) {
      try {
        renderEssayPanel(essayFieldsToGenerate);
      } catch (err) {
        console.warn('Failed to render essay panel', err);
      }
    }

    let statusLines = [
      `Заполнено полей: ${filledCount} из ${allFields.length}.` + (usedGemini ? " (Gemini помог с частью полей)" : ""),
    ];

    // Резюме нужно только если на странице есть либо поле загрузки файла резюме, либо
    // вопросы вакансии без готового ответа (для них полезен текст резюме) — и только если резюме загружены.
    const needsResume = (resumeUploadFields.length > 0 || essayFieldsToGenerate.length > 0) && (settings.resumes || []).length > 0;

    if (needsResume) {
      const title =
        resumeUploadFields.length > 0
          ? "Выберите резюме — файл будет подставлен на страницу"
          : "Выберите резюме для генерации ответов";
      afChosenResume = await pickResume(settings, title);
    }

    if (resumeUploadFields.length > 0) {
      if (!afChosenResume && (settings.resumes || []).length === 0) {
        statusLines.push("На странице есть поле загрузки резюме, но резюме не загружены (добавьте в настройках).");
      } else if (afChosenResume) {
        let placedCount = 0;
        for (const field of resumeUploadFields) {
          const result = await chrome.tabs.sendMessage(tab.id, {
            type: "AF_PLACE_FILE",
            afId: field.afId,
            base64: afChosenResume.dataBase64,
            fileName: afChosenResume.fileName,
            mimeType: afChosenResume.mimeType,
          });
          if (result.ok) placedCount += 1;
        }
        statusLines.push(`Файл резюме подставлен в поле(я): ${placedCount} из ${resumeUploadFields.length}.`);
      } else {
        statusLines.push("Выбор резюме отменён — файл не подставлен.");
      }
    }

    setStatus(statusLines.join("\n"));

    // Панель вопросов уже отрендерена выше; здесь только дополняем статус. Обработчик ✨
    // сам возьмёт актуальное afChosenResume — повторно перерисовывать (и терять ответы) не нужно.
    if (essayFieldsToGenerate.length > 0) {
      setStatus(statusEl.textContent + `\nВопросов без готового ответа: ${essayFieldsToGenerate.length} — сгенерируйте через ✨.`);
    }
  } catch (e) {
    setStatus(`Ошибка: ${e.message}`);
  } finally {
    autofillBtn.disabled = false;
  }
});

// --- Сохранение в библиотеку ---

scanSaveBtn.addEventListener("click", async () => {
  scanSaveBtn.disabled = true;
  setStatus("Сканирую страницу...");
  try {
    const tab = await getActiveTab();
    const scanResult = await scanPage(tab.id);
    const fields = (scanResult.fields || []).filter((f) => !f.isEssay && (f.value || "").trim() !== "");

    if (fields.length === 0) {
      setStatus("Не найдено заполненных полей на странице.");
      return;
    }

    const settings = await afGetSettings();
    const unclassified = fields.filter((f) => !f.guessedConcept);
    let suggestions = [];
    if (settings.useGeminiFallback && settings.geminiApiKey && unclassified.length > 0) {
      setStatus("Классифицирую поля через Gemini...");
      try {
        suggestions = await afCallGeminiForClassification(unclassified, settings);
      } catch (e) {
        console.warn("Gemini classification failed", e);
      }
    }

    const suggestionMap = new Map(suggestions.map((s) => [s.afId, s]));

    const previewItems = fields.map((field) => {
      const suggestion = suggestionMap.get(field.afId);
      const key = field.guessedConcept || suggestion?.key || afSlugFromField(field);
      const label =
        (field.guessedConcept && afConceptLabel(field.guessedConcept)) ||
        suggestion?.label ||
        field.label ||
        field.placeholder ||
        field.name ||
        "Поле";
      return { afId: field.afId, key, label, value: field.value, sourceType: field.type };
    });

    await renderPreview(previewItems, tab.url);
    setStatus(`Найдено полей: ${previewItems.length}. Проверьте и сохраните.`);
  } catch (e) {
    setStatus(`Ошибка: ${e.message}`);
  } finally {
    scanSaveBtn.disabled = false;
  }
});

async function renderPreview(items, sourceUrl) {
  previewListEl.innerHTML = "";
  // get library to know which keys already exist
  const library = await afGetLibrary();
  const existingKeys = new Set(Object.keys(library.entries || {}));

  items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "af-field-card";
    // Uncheck items whose key already exists in the library
    const shouldBeChecked = !existingKeys.has(item.key);
    row.innerHTML = `
      <div class="af-field-card-top">
        <input type="checkbox" ${shouldBeChecked ? 'checked' : ''} data-idx="${idx}" class="af-row-check" />
        <input type="text" class="af-field-label" value="${escapeAttr(item.label)}" data-field="label" data-idx="${idx}" placeholder="Название поля" />
        <span class="af-type-badge">${escapeAttr(item.sourceType)}</span>
      </div>
      <div class="af-field-card-body">
        <div class="af-field-group">
          <label class="af-mini-label">Ключ</label>
          <input type="text" class="af-field-key" value="${escapeAttr(item.key)}" data-field="key" data-idx="${idx}" placeholder="Ключ (латиницей)" />
        </div>
        <div class="af-field-group">
          <label class="af-mini-label">Значение</label>
          <input type="text" class="af-field-value" value="${escapeAttr(item.value)}" data-field="value" data-idx="${idx}" placeholder="Значение" />
        </div>
      </div>
    `;
    previewListEl.appendChild(row);
  });

  // store dataset on preview element and persist to storage so closing popup doesn't lose it
  previewEl.dataset.items = JSON.stringify(items);
  previewEl.dataset.sourceUrl = sourceUrl || "";
  previewEl.classList.remove("hidden");

  // persist preview to storage for popup reopen
  try {
    await new Promise((res) => chrome.storage.local.set({ af_last_preview: { items, sourceUrl } }, res));
  } catch (e) {
    console.warn('Failed to persist preview', e);
  }

  // wire up change handlers and persist incremental changes
  previewListEl.querySelectorAll("input[data-field]").forEach((input) => {
    input.addEventListener("input", async (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      const currentItems = JSON.parse(previewEl.dataset.items);
      currentItems[idx][field] = e.target.value;
      previewEl.dataset.items = JSON.stringify(currentItems);
      try {
        await new Promise((res) => chrome.storage.local.set({ af_last_preview: { items: currentItems, sourceUrl } }, res));
      } catch (err) {
        console.warn('Failed to persist preview change', err);
      }
    });
  });

  // also persist checkbox changes
  previewListEl.querySelectorAll('.af-row-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      try {
        const currentItems = JSON.parse(previewEl.dataset.items);
        await new Promise((res) => chrome.storage.local.set({ af_last_preview: { items: currentItems, sourceUrl } }, res));
      } catch (err) {
        console.warn('Failed to persist preview checkbox change', err);
      }
    });
  });
}

document.getElementById("af-preview-confirm").addEventListener("click", async () => {
  const items = JSON.parse(previewEl.dataset.items || "[]");
  const sourceUrl = previewEl.dataset.sourceUrl || "";
  const checkedIdxs = Array.from(previewListEl.querySelectorAll(".af-row-check"))
    .filter((cb) => cb.checked)
    .map((cb) => Number(cb.dataset.idx));

  const entriesToSave = checkedIdxs
    .map((idx) => items[idx])
    .filter((item) => item.key && item.value)
    .map((item) => ({ key: item.key, label: item.label, value: item.value, sourceUrl }));

  if (entriesToSave.length === 0) {
    setStatus("Ничего не выбрано для сохранения.");
    return;
  }

  await afSaveEntries(entriesToSave);
  hidePreview();
  setStatus(`Сохранено полей: ${entriesToSave.length}.`);
  refreshLibraryCount();
});

// --- Вопросы вакансии (essay) ---

function renderEssayPanel(essayFields) {
  essayListEl.innerHTML = "";
  // essayFields: [{ afId, label?, placeholder?, value? }]
  essayFields.forEach((field) => {
    const item = document.createElement("div");
    item.className = "af-essay-item";
    item.dataset.afid = field.afId;
    const question = field.label || field.placeholder || field.ariaLabel || field.question || "Вопрос анкеты";
    item.dataset.question = question;
    item.innerHTML = `
      <div class="af-essay-header">
        <span class="af-essay-question">${escapeAttr(question)}</span>
        <div class="af-essay-btn-group">
          <button class="af-sparkle-btn af-context-btn" data-afid="${escapeAttr(field.afId)}" title="Сохранить вопрос и ответ в контекст">🧠</button>
          <button class="af-sparkle-btn" data-afid="${escapeAttr(field.afId)}" title="Сгенерировать ответ">✨</button>
        </div>
      </div>
      <textarea class="af-essay-answer" data-afid="${escapeAttr(field.afId)}" rows="4" placeholder="Ответ появится здесь после генерации, или впишите вручную...">${escapeAttr(field.value || '')}</textarea>
    `;
    essayListEl.appendChild(item);
  });
  essayPanelEl.classList.remove("hidden");

  // Persist current essay panel to storage so popup reopen restores typed/generated answers
  async function persistEssayState() {
    try {
      const current = Array.from(essayListEl.querySelectorAll('.af-essay-item')).map(el => {
        const afId = el.dataset.afid;
        const question = el.dataset.question;
        const textarea = el.querySelector('.af-essay-answer');
        return { afId, question, value: textarea.value };
      });
      const tab = await getActiveTab();
      await new Promise((res) => chrome.storage.local.set({ af_last_essay: { fields: current, sourceUrl: tab?.url || "" } }, res));
    } catch (err) {
      console.warn('Failed to persist essay state', err);
    }
  }

  essayListEl.querySelectorAll(".af-context-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const contextBtn = e.currentTarget;
      const afId = contextBtn.dataset.afid;
      const item = essayListEl.querySelector(`.af-essay-item[data-afid="${CSS.escape(afId)}"]`);
      const textarea = item.querySelector(".af-essay-answer");
      const question = item.dataset.question;
      const answer = textarea.value.trim();

      if (!answer) {
        setStatus("Сначала впишите или сгенерируйте ответ, чтобы сохранить его в контекст.");
        return;
      }

      const settings = await afGetSettings();
      const addition = `Q: ${question}\nA: ${answer}`;
      settings.contextText = settings.contextText ? `${settings.contextText}\n\n${addition}` : addition;
      await afSetSettings(settings);

      const original = contextBtn.textContent;
      contextBtn.disabled = true;
      contextBtn.textContent = "✅";
      setTimeout(() => {
        contextBtn.textContent = original;
        contextBtn.disabled = false;
      }, 1200);

      // persist essay panel after saving to context
      await persistEssayState();
    });
  });

  essayListEl.querySelectorAll(".af-sparkle-btn:not(.af-context-btn)").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const afId = e.currentTarget.dataset.afid;
      const item = essayListEl.querySelector(`.af-essay-item[data-afid="${CSS.escape(afId)}"]`);
      const textarea = item.querySelector(".af-essay-answer");
      const question = item.dataset.question;
      const sparkleBtn = e.currentTarget;

      const settings = await afGetSettings();
      if (!settings.geminiApiKey) {
        setStatus("Укажите Gemini API-ключ в настройках, чтобы генерировать ответы.");
        return;
      }

      sparkleBtn.disabled = true;
      sparkleBtn.classList.add("af-loading");
      sparkleBtn.textContent = "";

      try {
        const resumeForAnswer =
          afChosenResume || (settings.resumes || []).find((r) => r.id === settings.defaultResumeId);
        const answer = await afCallGeminiForEssayAnswer(
          question,
          settings.contextText || "",
          resumeForAnswer?.textContent || "",
          settings
        );
        textarea.value = answer;
        await persistEssayState();
      } catch (err) {
        setStatus(`Ошибка генерации: ${err.message}`);
      } finally {
        sparkleBtn.disabled = false;
        sparkleBtn.classList.remove("af-loading");
        sparkleBtn.textContent = "✨";
      }
    });
  });

  // save on manual typing
  essayListEl.querySelectorAll('.af-essay-answer').forEach(txt => {
    txt.addEventListener('input', () => {
      // debounce or fire immediately — immediate is fine for small data
      persistEssayState();
    });
  });
}

document.getElementById("af-essay-apply").addEventListener("click", async () => {
  const mapping = {};
  essayListEl.querySelectorAll(".af-essay-answer").forEach((textarea) => {
    if (textarea.value.trim() !== "") {
      mapping[textarea.dataset.afid] = textarea.value;
    }
  });

  if (Object.keys(mapping).length === 0) {
    setStatus("Нет ответов для вставки.");
    return;
  }

  try {
    const tab = await getActiveTab();
    const applyResult = await chrome.tabs.sendMessage(tab.id, { type: "AF_APPLY_VALUES", mapping });
    setStatus(`Вставлено ответов: ${applyResult.filledCount}.`);
    hideEssayPanel();
  } catch (e) {
    setStatus(`Ошибка: ${e.message}`);
  }
});

// --- Автопоиск + шорткат ---

autoSearchInput.addEventListener("change", async () => {
  const settings = await afGetSettings();
  settings.autoSearchMode = autoSearchInput.checked;
  await afSetSettings(settings);
  setStatus(
    autoSearchInput.checked
      ? "Автопоиск включён — на страницах с полями появится хинт."
      : "Автопоиск выключен."
  );
});

shortcutLinkEl.addEventListener("click", (e) => {
  e.preventDefault();
  // Chrome opens the shortcuts page when user goes to chrome://extensions/shortcuts
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

async function loadAutoSearchToggle() {
  const settings = await afGetSettings();
  autoSearchInput.checked = !!settings.autoSearchMode;
}

function afSetShortcutLabel(el, shortcut) {
  if (!el) return;
  if (shortcut) {
    el.textContent = shortcut;
    el.title = "";
  } else {
    el.textContent = "не задан";
    el.title = "Назначьте комбинацию на странице шорткатов Chrome";
  }
}

async function loadShortcutLabel() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "AF_GET_COMMAND_SHORTCUT" });
    afSetShortcutLabel(shortcutLabelEl, res?.shortcut || res?.shortcuts?.autofill || "");
    afSetShortcutLabel(saveShortcutLabelEl, res?.saveShortcut || res?.shortcuts?.save || "");
  } catch (e) {
    if (shortcutLabelEl) shortcutLabelEl.textContent = "Alt+Shift+A";
    if (saveShortcutLabelEl) saveShortcutLabelEl.textContent = "Alt+Shift+S";
  }
}

(async function initPopup() {
  await refreshLibraryCount();
  await loadAutoSearchToggle();
  await loadShortcutLabel();
  try {
    const tab = await getActiveTab();
    const tabUrl = tab?.url || "";
    const res = await new Promise((resolve) => chrome.storage.local.get(["af_last_preview", "af_last_essay"], resolve));

    const previewValid = res.af_last_preview && res.af_last_preview.sourceUrl === tabUrl;
    const essayValid = res.af_last_essay && res.af_last_essay.sourceUrl === tabUrl;

    if (previewValid && res.af_last_preview.items && res.af_last_preview.items.length > 0) {
      await renderPreview(res.af_last_preview.items, res.af_last_preview.sourceUrl || "");
      setStatus(`Восстановлено ${res.af_last_preview.items.length} полей из предыдущей сессии.`);
    }

    if (essayValid && res.af_last_essay.fields && res.af_last_essay.fields.length > 0) {
      const restored = res.af_last_essay.fields.map((f) => ({ afId: f.afId, label: f.question, value: f.value }));
      renderEssayPanel(restored);
      setStatus((statusEl.textContent ? statusEl.textContent + "\n" : "") + `Восстановлены ответы на ${res.af_last_essay.fields.length} вопросов.`);
    }

    if ((res.af_last_preview && !previewValid) || (res.af_last_essay && !essayValid)) {
      await clearPopupState();
    }
  } catch (err) {
    console.warn("Error restoring popup state", err);
  }
})();
