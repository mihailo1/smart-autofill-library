// Shared autofill logic: scan → rules → Gemini → apply → resume.
// Used by background service worker (shortcut / hint click) and popup.
// Multi-frame aware: scans/applies across all frames (e.g. Greenhouse embeds).

/** @returns {Promise<number[]>} */
async function afGetTabFrameIds(tabId) {
  try {
    if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) {
      return [0];
    }
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames || frames.length === 0) return [0];
    // Prefer parent frames first so top-level is stable; skip error pages.
    return frames
      .filter((f) => f.errorOccurred !== true)
      .map((f) => f.frameId);
  } catch (_) {
    return [0];
  }
}

/**
 * Send a message to a specific frame. Throws if no content script there.
 */
async function afSendFrameMessage(tabId, frameId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

/**
 * Send to top frame only (toasts / UI that should not appear inside embeds).
 */
async function afSendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch (e) {
    // Fallback without frameId for older behavior / restricted pages
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e2) {
      throw new Error("Could not access the page. Please refresh and try again.");
    }
  }
}

/**
 * Message every frame that has our content script.
 * @returns {Promise<Array<{ frameId: number, response: any }>>}
 */
async function afSendAllFrames(tabId, message) {
  const frameIds = await afGetTabFrameIds(tabId);
  const results = await Promise.all(
    frameIds.map(async (frameId) => {
      try {
        const response = await chrome.tabs.sendMessage(tabId, message, { frameId });
        return { frameId, response };
      } catch (_) {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

/**
 * Scan all frames; attach frameId to every field so apply can route correctly.
 */
async function afScanTab(tabId) {
  const results = await afSendAllFrames(tabId, { type: "AF_SCAN_FIELDS" });
  if (results.length === 0) {
    throw new Error("Could not access the page. Please refresh and try again.");
  }

  const fields = [];
  const resumeUploadFields = [];
  let url = "";

  for (const { frameId, response } of results) {
    if (!response) continue;
    if (!url && response.url) url = response.url;
    for (const f of response.fields || []) {
      fields.push({ ...f, frameId });
    }
    for (const f of response.resumeUploadFields || []) {
      resumeUploadFields.push({ ...f, frameId });
    }
  }

  return { fields, resumeUploadFields, url, frameCount: results.length };
}

/**
 * Apply values, routing each afId to the frame it was scanned from.
 * @param {number} tabId
 * @param {Record<string, string>} mapping afId → value
 * @param {Array<{ afId: string, frameId?: number }>} fields fields with frameId
 */
async function afApplyValuesOnTab(tabId, mapping, fields) {
  const frameOf = new Map((fields || []).map((f) => [f.afId, f.frameId != null ? f.frameId : 0]));
  const byFrame = new Map();

  Object.entries(mapping || {}).forEach(([afId, value]) => {
    if (value === undefined || value === null || value === "") return;
    const frameId = frameOf.has(afId) ? frameOf.get(afId) : 0;
    if (!byFrame.has(frameId)) byFrame.set(frameId, {});
    byFrame.get(frameId)[afId] = value;
  });

  let filledCount = 0;
  for (const [frameId, frameMapping] of byFrame.entries()) {
    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        { type: "AF_APPLY_VALUES", mapping: frameMapping },
        { frameId: Number(frameId) }
      );
      filledCount += result?.filledCount || 0;
    } catch (e) {
      console.warn("AF apply failed in frame", frameId, e);
    }
  }
  return { filledCount };
}

/**
 * Place a file into a resume upload field in the correct frame.
 */
async function afPlaceFileOnTab(tabId, field, file) {
  const frameId = field.frameId != null ? field.frameId : 0;
  try {
    return await chrome.tabs.sendMessage(
      tabId,
      {
        type: "AF_PLACE_FILE",
        afId: field.afId,
        base64: file.dataBase64,
        fileName: file.fileName,
        mimeType: file.mimeType,
      },
      { frameId: Number(frameId) }
    );
  } catch (e) {
    console.warn("AF place file failed in frame", frameId, e);
    return { ok: false };
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
  const scanResult = await afScanTab(tabId);
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

    // Essays are excluded from Gemini *library* matching — they use ✨ generation instead.
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
      const applyResult = await afApplyValuesOnTab(tabId, mapping, allFields);
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
      const result = await afPlaceFileOnTab(tabId, field, chosenResume);
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
  const scanResult = await afScanTab(tabId);
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
  self.afGetTabFrameIds = afGetTabFrameIds;
  self.afSendFrameMessage = afSendFrameMessage;
  self.afSendTabMessage = afSendTabMessage;
  self.afSendAllFrames = afSendAllFrames;
  self.afScanTab = afScanTab;
  self.afApplyValuesOnTab = afApplyValuesOnTab;
  self.afPlaceFileOnTab = afPlaceFileOnTab;
  self.afAutofillTab = afAutofillTab;
  self.afSaveTabToLibrary = afSaveTabToLibrary;
  self.afSlugFromField = afSlugFromField;
}
