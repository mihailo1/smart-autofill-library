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
      <div class="af-essay-grounding hidden" data-afid="${escapeAttr(field.afId)}" aria-live="polite"></div>
    `;
    essayListEl.appendChild(item);
    if (field.sources && field.sources.length) {
      afRenderEssayGrounding(item.querySelector(".af-essay-grounding"), field.sources);
    }
  });
  essayPanelEl.classList.remove("hidden");

  function afRenderEssayGrounding(host, sources) {
    if (!host) return;
    const list = Array.isArray(sources) ? sources.filter((s) => s && s.quote) : [];
    if (!list.length) {
      host.classList.add("hidden");
      host.textContent = "";
      return;
    }
    host.classList.remove("hidden");
    host.innerHTML = "";
    const title = document.createElement("div");
    title.className = "af-essay-grounding-title";
    title.textContent = "Grounded in your materials (no invented facts)";
    host.appendChild(title);
    list.forEach((s) => {
      const row = document.createElement("div");
      row.className = "af-essay-grounding-item";
      const badge = document.createElement("span");
      badge.className = "af-essay-grounding-badge";
      badge.textContent = s.source === "resume" ? "Resume" : "Context";
      const q = document.createElement("span");
      q.className = "af-essay-grounding-quote";
      q.textContent = s.quote;
      row.appendChild(badge);
      row.appendChild(q);
      host.appendChild(row);
    });
  }

  // Persist essay panel so reopening the popup restores typed/generated answers
  async function persistEssayState() {
    try {
      const current = Array.from(essayListEl.querySelectorAll(".af-essay-item")).map((el) => {
        const afId = el.dataset.afid;
        const frameId = Number(el.dataset.frameId || 0);
        const question = el.dataset.question;
        const textarea = el.querySelector(".af-essay-answer");
        let sources = [];
        try {
          sources = JSON.parse(el.dataset.sources || "[]");
        } catch (_) {
          sources = [];
        }
        return { afId, frameId, question, value: textarea.value, sources };
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
        const result = await afCallGeminiForEssayAnswer(
          question,
          settings.contextText || "",
          resumeForAnswer?.textContent || "",
          settings
        );
        const answer = typeof result === "string" ? result : result?.answer || "";
        const sources = typeof result === "object" && result ? result.sources || [] : [];
        textarea.value = answer;
        item.dataset.sources = JSON.stringify(sources);
        afRenderEssayGrounding(item.querySelector(".af-essay-grounding"), sources);
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
