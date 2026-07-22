// Shared autofill logic: scan → rules → Gemini → apply → resume.
// Used by background service worker (shortcut / hint click) and popup.

async function afSendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    throw new Error("Could not access the page. Please refresh and try again.");
  }
}

/**
 * Fills fields on a tab from the library.
 * @param {number} tabId
 * @param {object} options
 * @param {object|null} options.resume — resume file to place (if upload fields exist)
 * @param {boolean} options.placeDefaultResume — if resume not provided, use default from settings
 * @param {boolean} options.notifyPage — show toast on the page
 * @param {(text: string) => void} options.onStatus — status callback (for popup)
 * @returns {Promise<object>}
 */
async function afAutofillTab(tabId, options = {}) {
  const {
    resume = null,
    placeDefaultResume = true,
    notifyPage = true,
    onStatus = null,
  } = options;

  const setStatus = (text) => {
    if (typeof onStatus === "function") onStatus(text);
  };

  setStatus("Scanning page...");
  const scanResult = await afSendTabMessage(tabId, { type: "AF_SCAN_FIELDS" });
  const allFields = scanResult.fields || [];
  const resumeUploadFields = scanResult.resumeUploadFields || [];
  // Fields that actually need filling (were empty at scan time).
  const fillableFields = allFields.filter((f) => !(f.value || "").trim());

  if (allFields.length === 0 && resumeUploadFields.length === 0) {
    const msg = "No fillable fields found on this page.";
    setStatus(msg);
    if (notifyPage) {
      await afSendTabMessage(tabId, { type: "AF_TOAST", text: msg, kind: "info" }).catch(() => {});
    }
    return {
      filledCount: 0,
      totalFields: 0,
      usedGemini: false,
      resumePlaced: 0,
      resumeUploadFields,
      essayFieldsUnmatched: [],
      empty: true,
      message: msg,
    };
  }

  const library = await afGetLibrary();
  const settings = await afGetSettings();
  const essayFields = allFields.filter((f) => f.isEssay);

  let filledCount = 0;
  let usedGemini = false;
  const filledAfIds = new Set();

  if (allFields.length > 0) {
    const ruleResult = afMatchFieldsToLibrary(allFields, library);
    const mapping = { ...ruleResult.mapping };

    if (settings.useGeminiFallback && settings.geminiApiKey && ruleResult.unmatched.length > 0) {
      setStatus("Matching remaining fields via Gemini...");
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
        setStatus(`Gemini unavailable (${e.message}), using rules only.`);
      }
    }

    if (Object.keys(mapping).length > 0) {
      const applyResult = await afSendTabMessage(tabId, { type: "AF_APPLY_VALUES", mapping });
      filledCount = applyResult.filledCount || 0;
      Object.keys(mapping).forEach((afId) => filledAfIds.add(afId));
    }
  }

  const essayFieldsUnmatched = essayFields.filter((f) => !filledAfIds.has(f.afId));

  let chosenResume = resume;
  if (!chosenResume && placeDefaultResume && (settings.resumes || []).length > 0) {
    chosenResume =
      (settings.resumes || []).find((r) => r.id === settings.defaultResumeId) ||
      settings.resumes[0] ||
      null;
  }

  let resumePlaced = 0;
  if (resumeUploadFields.length > 0 && chosenResume) {
    for (const field of resumeUploadFields) {
      const result = await afSendTabMessage(tabId, {
        type: "AF_PLACE_FILE",
        afId: field.afId,
        base64: chosenResume.dataBase64,
        fileName: chosenResume.fileName,
        mimeType: chosenResume.mimeType,
      });
      if (result && result.ok) resumePlaced += 1;
    }
  }

  const statusLines = [
    `Filled ${filledCount} of ${fillableFields.length} fields.` +
      (usedGemini ? " (Gemini helped with some fields)" : ""),
  ];
  if (resumeUploadFields.length > 0) {
    if (resumePlaced > 0) {
      statusLines.push(`Resume file placed: ${resumePlaced} of ${resumeUploadFields.length}.`);
    } else if ((settings.resumes || []).length === 0) {
      statusLines.push("Resume upload field found, but no resumes uploaded (add in settings).");
    } else {
      statusLines.push("Resume not placed.");
    }
  }
  if (essayFieldsUnmatched.length > 0) {
    statusLines.push(
      `Unanswered questions: ${essayFieldsUnmatched.length} — open popup to generate ✨.`
    );
  }

  const message = statusLines.join("\n");
  setStatus(message);

  if (notifyPage) {
    const short =
      filledCount > 0
        ? `⚡ Filled: ${filledCount}` +
          (resumePlaced ? ` · resume ${resumePlaced}` : "") +
          (essayFieldsUnmatched.length ? ` · ${essayFieldsUnmatched.length} essays in popup` : "")
        : essayFieldsUnmatched.length > 0
          ? `Found ${essayFieldsUnmatched.length} questions — open popup ✨`
          : "Nothing to fill from library";
    await afSendTabMessage(tabId, {
      type: "AF_TOAST",
      text: short,
      kind: filledCount > 0 ? "success" : "info",
    }).catch(() => {});
  }

  return {
    filledCount,
    totalFields: allFields.length,
    usedGemini,
    resumePlaced,
    resumeUploadFields,
    essayFieldsUnmatched,
    essayFields,
    allFields,
    chosenResume,
    empty: false,
    message,
    settings,
  };
}

function afSlugFromField(field) {
  const raw = field.name || field.id || field.label || field.placeholder || field.ariaLabel || field.afId;
  const slug = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return `custom_${slug || field.afId}`;
}

/**
 * Saves filled fields from the page to the library (no UI preview).
 * Essay fields are skipped. Keys: guessedConcept → Gemini → slug.
 * Existing keys are updated.
 */
async function afSaveTabToLibrary(tabId, options = {}) {
  const { notifyPage = true, onStatus = null } = options;
  const setStatus = (text) => {
    if (typeof onStatus === "function") onStatus(text);
  };

  setStatus("Scanning page...");
  const scanResult = await afSendTabMessage(tabId, { type: "AF_SCAN_FIELDS" });
  const fields = (scanResult.fields || []).filter((f) => !f.isEssay && (f.value || "").trim() !== "");
  const sourceUrl = scanResult.url || "";

  if (fields.length === 0) {
    const msg = "No filled fields found on this page.";
    setStatus(msg);
    if (notifyPage) {
      await afSendTabMessage(tabId, { type: "AF_TOAST", text: msg, kind: "info" }).catch(() => {});
    }
    return { savedCount: 0, empty: true, message: msg };
  }

  const settings = await afGetSettings();
  const unclassified = fields.filter((f) => !f.guessedConcept);
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
  const entriesToSave = fields.map((field) => {
    const suggestion = suggestionMap.get(field.afId);
    const key = field.guessedConcept || suggestion?.key || afSlugFromField(field);
    const label =
      (field.guessedConcept && typeof afConceptLabel === "function" && afConceptLabel(field.guessedConcept)) ||
      suggestion?.label ||
      field.label ||
      field.placeholder ||
      field.name ||
      "Field";
    return { key, label, value: field.value, sourceUrl };
  }).filter((item) => item.key && item.value);

  if (entriesToSave.length === 0) {
    const msg = "Nothing to save.";
    setStatus(msg);
    if (notifyPage) {
      await afSendTabMessage(tabId, { type: "AF_TOAST", text: msg, kind: "info" }).catch(() => {});
    }
    return { savedCount: 0, empty: true, message: msg };
  }

  await afSaveEntries(entriesToSave);
  const message = `Saved ${entriesToSave.length} fields.`;
  setStatus(message);

  if (notifyPage) {
    await afSendTabMessage(tabId, {
      type: "AF_TOAST",
      text: `💾 ${message}`,
      kind: "success",
    }).catch(() => {});
  }

  return {
    savedCount: entriesToSave.length,
    empty: false,
    message,
    entries: entriesToSave,
  };
}

if (typeof self !== "undefined") {
  self.afSendTabMessage = afSendTabMessage;
  self.afAutofillTab = afAutofillTab;
  self.afSaveTabToLibrary = afSaveTabToLibrary;
  self.afSlugFromField = afSlugFromField;
}
