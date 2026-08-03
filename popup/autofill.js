// AF.popup.autofill — classic-script module (no bundler).
(function (global) {
  const AF = global.AF || (global.AF = {});
  AF.popup = AF.popup || {};

// --- Resume picker menu (appears on "Autofill" click if there's something to choose) ---

// Shows the menu and resolves the selected resume object (or null if none/menu closed).
function pickResume(settings, title) {
  return new Promise((resolve) => {
    const resumes = settings.resumes || [];
    resumeMenuTitleEl.textContent = title;
    resumeMenuListEl.innerHTML = resumes
      .map(
        (r) => `
        <button class="af-resume-menu-item" data-id="${escapeAttr(r.id)}">
          <span class="af-resume-menu-name">${escapeAttr(r.name || r.fileName || "Resume")}</span>
          ${r.id === settings.defaultResumeId ? '<span class="af-resume-menu-default">default</span>' : ""}
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

// --- Autofill ---

autofillBtn.addEventListener("click", async () => {
  autofillBtn.disabled = true;
  hideEssayPanel();
  hideResumeMenu();
  setStatus("Scanning page...");
  try {
    const tab = await getActiveTab();
    const scanResult = await scanPage(tab.id);
    const allFields = scanResult.fields || [];
    const resumeUploadFields = scanResult.resumeUploadFields || [];

    if (allFields.length === 0 && resumeUploadFields.length === 0) {
      setStatus("No fillable fields found on this page.");
      return;
    }

    const essayFields = allFields.filter((f) => f.isEssay);

    const library = await afGetLibrary();
    const settings = await afGetSettings();

    let filledCount = 0;
    let usedGemini = false;

    // Match profile fields against the library. Essay/open-ended questions are NOT
    // filled from website/portfolio/github — they go to the ✨ AI panel.
    afChosenResume = null;
    const filledAfIds = new Set();

    if (allFields.length > 0) {
      const ruleResult = afMatchFieldsToLibrary(allFields, library);
      const mapping = { ...ruleResult.mapping };

      const geminiCandidates =
        typeof afFieldsForGeminiMatching === "function"
          ? afFieldsForGeminiMatching(ruleResult.unmatched)
          : ruleResult.unmatched.filter((f) => !f.isEssay);

      if (settings.useGeminiFallback && settings.geminiApiKey && geminiCandidates.length > 0) {
        setStatus("Matching remaining fields via Gemini...");
        try {
          let geminiMatches = await afCallGeminiForMatching(geminiCandidates, library, settings);
          if (typeof afFilterGeminiMatches === "function") {
            geminiMatches = afFilterGeminiMatches(geminiMatches, allFields, library);
          }
          geminiMatches.forEach(({ afId, libraryKey }) => {
            const entry = library.entries[libraryKey];
            if (entry && entry.value) {
              mapping[afId] = entry.value;
              usedGemini = true;
            }
          });
        } catch (e) {
          console.warn("Gemini matching failed", e);
          setStatus(`Gemini unavailable (${e.message}), using rules only.`);
        }
      }

      if (Object.keys(mapping).length > 0) {
        const applyResult = await afApplyValuesOnTab(tab.id, mapping, allFields);
        filledCount = applyResult.filledCount || 0;
        Object.keys(mapping).forEach((afId) => filledAfIds.add(afId));
      }
    }

    // Essay questions always go to the ✨ panel (not auto-filled from profile library).
    const essayFieldsToGenerate = essayFields.filter((f) => !filledAfIds.has(f.afId));
    if (essayFieldsToGenerate.length > 0) {
      try {
        renderEssayPanel(essayFieldsToGenerate);
      } catch (err) {
        console.warn('Failed to render essay panel', err);
      }
    }

    let statusLines = [
      `Filled ${filledCount} of ${allFields.length} fields.` + (usedGemini ? " (Gemini helped with some fields)" : ""),
    ];

    // Resume is only needed if the page has a resume upload field or unanswered essay
    // questions (resume text is useful for those) — and only if resumes are uploaded.
    const needsResume = (resumeUploadFields.length > 0 || essayFieldsToGenerate.length > 0) && (settings.resumes || []).length > 0;

    if (needsResume) {
      const title =
        resumeUploadFields.length > 0
          ? "Select resume — file will be placed on the page"
          : "Select resume for generating answers";
      afChosenResume = await pickResume(settings, title);
    }

    if (resumeUploadFields.length > 0) {
      if (!afChosenResume && (settings.resumes || []).length === 0) {
        statusLines.push("Resume upload field found on page, but no resumes uploaded (add in settings).");
      } else if (afChosenResume) {
        let placedCount = 0;
        for (const field of resumeUploadFields) {
          const result = await afPlaceFileOnTab(tab.id, field, afChosenResume);
          if (result && result.ok) placedCount += 1;
        }
        statusLines.push(`Resume file placed in ${placedCount} of ${resumeUploadFields.length} field(s).`);
      } else {
        statusLines.push("Resume selection cancelled — file not placed.");
      }
    }

    setStatus(statusLines.join("\n"));

    // Essay panel already rendered above; just append status. The ✨ handler reads
    // the current afChosenResume — no need to re-render (and lose answers).
    if (essayFieldsToGenerate.length > 0) {
      setStatus(statusEl.textContent + `\nUnanswered questions: ${essayFieldsToGenerate.length} — generate via ✨.`);
    }
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  } finally {
    autofillBtn.disabled = false;
  }
});

// --- Save to library ---

scanSaveBtn.addEventListener("click", async () => {
  scanSaveBtn.disabled = true;
  setStatus("Scanning page...");
  try {
    const tab = await getActiveTab();
    const scanResult = await scanPage(tab.id);
    const fields = (scanResult.fields || []).filter((f) => !f.isEssay && (f.value || "").trim() !== "");

    if (fields.length === 0) {
      setStatus("No filled fields found on this page.");
      return;
    }

    const settings = await afGetSettings();
    const library = await afGetLibrary();
    // Don't spend Gemini calls classifying consent/confirm junk or empty shells.
    const candidates = fields.filter((f) => !afIsJunkLibraryField(f));
    const unclassified = candidates.filter((f) => !f.guessedConcept);
    let suggestions = [];
    if (settings.useGeminiFallback && settings.geminiApiKey && unclassified.length > 0) {
      setStatus("Classifying fields via Gemini...");
      try {
        suggestions = await afCallGeminiForClassification(unclassified, settings);
      } catch (e) {
        console.warn("Gemini classification failed", e);
      }
    }

    const suggestionMap = new Map(suggestions.map((s) => [s.afId, s]));
    const { items: previewItems, stats } = afBuildLibrarySaveItems(
      fields,
      library,
      suggestionMap,
      tab.url || ""
    );

    if (previewItems.length === 0) {
      const parts = [];
      if (stats.unchanged) parts.push(`${stats.unchanged} already in library`);
      if (stats.junk) parts.push(`${stats.junk} skipped (confirm/consent/etc.)`);
      setStatus(parts.length ? `Nothing new to save — ${parts.join(", ")}.` : "Nothing new to save.");
      hidePreview();
      return;
    }

    await renderPreview(previewItems, tab.url);
    const statusParts = [`${previewItems.length} to review`];
    if (stats.fresh) statusParts.push(`${stats.fresh} new`);
    if (stats.updates) statusParts.push(`${stats.updates} updated value`);
    if (stats.unchanged) statusParts.push(`${stats.unchanged} already saved (hidden)`);
    if (stats.junk) statusParts.push(`${stats.junk} skipped`);
    setStatus(statusParts.join(" · ") + ".");
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  } finally {
    scanSaveBtn.disabled = false;
  }
});

async function renderPreview(items, sourceUrl) {
  previewListEl.innerHTML = "";

  items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "af-field-card" + (item.saveStatus === "update" ? " af-field-card-update" : "");
    // New + updates are checked; (unchanged no longer appear here)
    const shouldBeChecked = true;
    const badge =
      item.saveStatus === "update"
        ? `<span class="af-type-badge af-type-badge-update" title="Library has a different value">update</span>`
        : `<span class="af-type-badge">${escapeAttr(item.sourceType || "text")}</span>`;
    row.innerHTML = `
      <div class="af-field-card-top">
        <input type="checkbox" ${shouldBeChecked ? "checked" : ""} data-idx="${idx}" class="af-row-check" />
        <input type="text" class="af-field-label" value="${escapeAttr(item.label)}" data-field="label" data-idx="${idx}" placeholder="Field name" />
        ${badge}
      </div>
      <div class="af-field-card-body">
        <div class="af-field-group">
          <label class="af-mini-label">Key</label>
          <input type="text" class="af-field-key" value="${escapeAttr(item.key)}" data-field="key" data-idx="${idx}" placeholder="Key (latin)" />
        </div>
        <div class="af-field-group">
          <label class="af-mini-label">Value</label>
          <input type="text" class="af-field-value" value="${escapeAttr(item.value)}" data-field="value" data-idx="${idx}" placeholder="Value" />
        </div>
      </div>
    `;
    previewListEl.appendChild(row);
  });

  // store dataset on preview element and persist so closing the popup doesn't lose progress
  previewEl.dataset.items = JSON.stringify(items);
  previewEl.dataset.sourceUrl = sourceUrl || "";
  previewEl.classList.remove("hidden");

  let previewTabId = null;
  try {
    const tab = await getActiveTab();
    previewTabId = tab?.id ?? null;
    await afPersistPreview(items, sourceUrl, previewTabId);
  } catch (e) {
    console.warn("Failed to persist preview", e);
  }

  const persistPreviewNow = async () => {
    try {
      const currentItems = JSON.parse(previewEl.dataset.items || "[]");
      const tab = await getActiveTab();
      await afPersistPreview(currentItems, sourceUrl, tab?.id ?? previewTabId);
    } catch (err) {
      console.warn("Failed to persist preview change", err);
    }
  };

  previewListEl.querySelectorAll("input[data-field]").forEach((input) => {
    input.addEventListener("input", async (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      const currentItems = JSON.parse(previewEl.dataset.items);
      currentItems[idx][field] = e.target.value;
      previewEl.dataset.items = JSON.stringify(currentItems);
      await persistPreviewNow();
    });
  });

  previewListEl.querySelectorAll(".af-row-check").forEach((cb) => {
    cb.addEventListener("change", () => {
      persistPreviewNow();
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
    setStatus("Nothing selected to save.");
    return;
  }

  await afSaveEntries(entriesToSave);
  hidePreview({ clearStorage: true });
  setStatus(`Saved ${entriesToSave.length} fields.`);
  await refreshLibraryCount();
  if (afLibraryMode) await loadLibraryBrowser(true);
});

  AF.popup.autofill = { pickResume, renderPreview };
  global.pickResume = pickResume;
  global.renderPreview = renderPreview;
})(typeof self !== "undefined" ? self : window);
