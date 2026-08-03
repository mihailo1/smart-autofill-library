// AF.popup.essay — classic-script module (no bundler).
(function (global) {
  const AF = global.AF || (global.AF = {});
  AF.popup = AF.popup || {};

// --- Job application questions (essay) ---

function renderEssayPanel(essayFields) {
  essayListEl.innerHTML = "";
  // essayFields: [{ afId, frameId?, label?, placeholder?, value? }]
  essayFields.forEach((field) => {
    const item = document.createElement("div");
    item.className = "af-essay-item";
    item.dataset.afid = field.afId;
    item.dataset.frameId = field.frameId != null ? String(field.frameId) : "0";
    const question = field.label || field.placeholder || field.ariaLabel || field.question || "Application question";
    item.dataset.question = question;
    item.innerHTML = `
      <div class="af-essay-header">
        <span class="af-essay-question">${escapeAttr(question)}</span>
        <div class="af-essay-btn-group">
          <button class="af-sparkle-btn af-context-btn" data-afid="${escapeAttr(field.afId)}" title="Save question and answer to context">🧠</button>
          <button class="af-sparkle-btn" data-afid="${escapeAttr(field.afId)}" title="Generate answer">✨</button>
        </div>
      </div>
      <textarea class="af-essay-answer" data-afid="${escapeAttr(field.afId)}" data-frame-id="${escapeAttr(field.frameId != null ? field.frameId : 0)}" rows="4" placeholder="Answer will appear here after generation, or type manually...">${escapeAttr(field.value || '')}</textarea>
    `;
    essayListEl.appendChild(item);
  });
  essayPanelEl.classList.remove("hidden");

  // Persist essay panel so reopening the popup restores typed/generated answers
  async function persistEssayState() {
    try {
      const current = Array.from(essayListEl.querySelectorAll(".af-essay-item")).map((el) => {
        const afId = el.dataset.afid;
        const frameId = Number(el.dataset.frameId || 0);
        const question = el.dataset.question;
        const textarea = el.querySelector(".af-essay-answer");
        return { afId, frameId, question, value: textarea.value };
      });
      const tab = await getActiveTab();
      await afPersistEssay(current, tab?.url || "", tab?.id);
    } catch (err) {
      console.warn("Failed to persist essay state", err);
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
        setStatus("Type or generate an answer first, then save it to context.");
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
        setStatus("Set your Gemini API key in settings to generate answers.");
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
        setStatus(`Generation error: ${err.message}`);
      } finally {
        sparkleBtn.disabled = false;
        sparkleBtn.classList.remove("af-loading");
        sparkleBtn.textContent = "✨";
      }
    });
  });

  // save on manual typing
  essayListEl.querySelectorAll(".af-essay-answer").forEach((txt) => {
    txt.addEventListener("input", () => {
      persistEssayState();
    });
  });

  // Snapshot immediately so closing the popup right after autofill still restores the panel
  persistEssayState();
}

document.getElementById("af-essay-apply").addEventListener("click", async () => {
  const mapping = {};
  const fields = [];
  essayListEl.querySelectorAll(".af-essay-answer").forEach((textarea) => {
    if (textarea.value.trim() !== "") {
      const afId = textarea.dataset.afid;
      const frameId = Number(textarea.dataset.frameId || 0);
      mapping[afId] = textarea.value;
      fields.push({ afId, frameId });
    }
  });

  if (Object.keys(mapping).length === 0) {
    setStatus("No answers to insert.");
    return;
  }

  try {
    const tab = await getActiveTab();
    const applyResult = await afApplyValuesOnTab(tab.id, mapping, fields);
    setStatus(`Inserted ${applyResult.filledCount} answer(s).`);
    hideEssayPanel({ clearStorage: true });
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
});

  AF.popup.essay = { renderEssayPanel };
  global.renderEssayPanel = renderEssayPanel;
})(typeof self !== "undefined" ? self : window);
