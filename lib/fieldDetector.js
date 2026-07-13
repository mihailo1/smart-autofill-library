// Работает в контексте content-script на реальной странице. Отвечает за:
// 1) сканирование полей формы (input/select/textarea, кроме password/hidden/disabled)
// 2) сбор метаданных поля (name/id/label/placeholder/autocomplete) + угадывание концепта
// 3) применение значений (автозаполнение) с диспатчем input/change событий

const AF_FIELD_ATTR = "data-af-id";
let afFieldCounter = 0;

function afIsEligibleField(el) {
  if (el.disabled || el.readOnly) return false;
  if (el.type === "password" || el.type === "hidden" || el.type === "submit" || el.type === "button" || el.type === "reset" || el.type === "file") return false;
  const rects = el.getClientRects();
  if (rects.length === 0) return false; // скрытые через display:none/visibility
  return true;
}

function afFindLabelText(el) {
  if (el.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (forLabel) return forLabel.textContent.trim();
  }
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) return wrappingLabel.textContent.trim();

  const ariaLabelledBy = el.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    const refEl = document.getElementById(ariaLabelledBy);
    if (refEl) return refEl.textContent.trim();
  }

  // Пытаемся найти ближайший текстовый узел перед полем (частый паттерн для форм без <label>,
  // а также для длинных вопросов анкеты типа "Why do you want to work here?")
  let prev = el.previousElementSibling;
  let hops = 0;
  while (prev && hops < 3) {
    const text = prev.textContent && prev.textContent.trim();
    if (text && text.length < 300) return text;
    prev = prev.previousElementSibling;
    hops += 1;
  }

  // Если рядом ничего нет, пробуем найти текст в родительском блоке (частый паттерн для
  // вопросов вакансий, обёрнутых в один div вместе с textarea)
  const parent = el.parentElement;
  if (parent) {
    const clone = parent.cloneNode(true);
    clone.querySelectorAll("input, select, textarea, button").forEach((n) => n.remove());
    const parentText = clone.textContent && clone.textContent.trim();
    if (parentText && parentText.length < 300) return parentText;
  }

  return "";
}

// Эвристика: похоже ли поле на "сложный" вопрос анкеты вакансии (эссе-ответ), а не на
// обычное короткое поле профиля. Такие вопросы почти всегда на английском и оформлены как
// textarea с длинным вопросом/просьбой описать что-либо.
const AF_ESSAY_KEYWORDS = [
  "why do you want",
  "why are you interested",
  "why us",
  "why should we",
  "why would you",
  "tell us about",
  "tell us more",
  "describe a time",
  "describe your",
  "most interesting project",
  "most challenging",
  "proudest",
  "greatest achievement",
  "what motivates",
  "what interests you",
  "cover letter",
  "additional information",
  "anything else",
  "what makes you",
  "biggest challenge",
  "favorite project",
];

function afIsEssayQuestion(meta) {
  if (meta.tag !== "textarea") return false;
  const text = [meta.label, meta.placeholder, meta.ariaLabel].filter(Boolean).join(" ").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasQuestionMark = text.endsWith("?");
  const hasKeyword = AF_ESSAY_KEYWORDS.some((kw) => lower.includes(kw));
  const isLongPrompt = text.length > 25;
  return hasQuestionMark || hasKeyword || isLongPrompt;
}

// Эвристика: похоже ли поле загрузки файла на поле для резюме/CV, а не что-то другое
// (фото, сопроводительное письмо отдельным файлом и т.п. тоже подходят под "resume-like").
const AF_RESUME_KEYWORDS = ["resume", "cv", "curriculum vitae", "резюме"];

function afIsResumeUploadField(el) {
  if (el.tagName.toLowerCase() !== "input" || el.type !== "file") return false;
  if (el.disabled) return false;

  const accept = (el.getAttribute("accept") || "").toLowerCase();
  const label = afFindLabelText(el);
  const haystack = [el.name, el.id, label, el.getAttribute("aria-label"), el.getAttribute("placeholder")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const acceptLooksLikeDocs = accept.includes("pdf") || accept.includes("doc") || accept === "";
  const mentionsResume = AF_RESUME_KEYWORDS.some((kw) => haystack.includes(kw));

  return mentionsResume && acceptLooksLikeDocs;
}

function afFindResumeUploadFields() {
  const nodeList = document.querySelectorAll('input[type="file"]');
  const results = [];
  nodeList.forEach((el) => {
    if (!afIsResumeUploadField(el)) return;
    const id = afEnsureFieldId(el);
    results.push({
      afId: id,
      tag: "input",
      type: "file",
      name: el.name || "",
      id: el.id || "",
      label: afFindLabelText(el),
      accept: el.getAttribute("accept") || "",
    });
  });
  return results;
}

function afEnsureFieldId(el) {
  let id = el.getAttribute(AF_FIELD_ATTR);
  if (!id) {
    afFieldCounter += 1;
    id = `af-${Date.now()}-${afFieldCounter}`;
    el.setAttribute(AF_FIELD_ATTR, id);
  }
  return id;
}

function afCollectFields() {
  const nodeList = document.querySelectorAll("input, select, textarea");
  const results = [];
  nodeList.forEach((el) => {
    if (!afIsEligibleField(el)) return;
    const id = afEnsureFieldId(el);
    const label = afFindLabelText(el);
    const meta = {
      afId: id,
      tag: el.tagName.toLowerCase(),
      type: el.type || "text",
      name: el.name || "",
      id: el.id || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      label,
      value: el.value || "",
    };
    const guess = typeof afGuessConcept === "function" ? afGuessConcept(meta) : null;
    meta.guessedConcept = guess ? guess.key : null;
    meta.guessedConfidence = guess ? guess.confidence : 0;
    meta.isEssay = afIsEssayQuestion(meta);
    results.push(meta);
  });
  return { fields: results, resumeUploadFields: afFindResumeUploadFields() };
}

function afApplyValues(mapping) {
  let filledCount = 0;
  Object.entries(mapping).forEach(([afId, value]) => {
    if (value === undefined || value === null || value === "") return;
    const el = document.querySelector(`[${AF_FIELD_ATTR}="${CSS.escape(afId)}"]`);
    if (!el) return;

    if (el.tagName.toLowerCase() === "select") {
      const option = Array.from(el.options).find(
        (opt) => opt.value === value || opt.textContent.trim() === value
      );
      if (option) {
        el.value = option.value;
      } else {
        return;
      }
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    filledCount += 1;
  });
  return filledCount;
}

// Реконструирует File из base64 и подставляет его в input[type=file] через DataTransfer —
// единственный надёжный способ программно "загрузить" файл в файловый инпут в браузере.
function afBase64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i += 1) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

function afPlaceFile(afId, base64, fileName, mimeType) {
  const el = document.querySelector(`[${AF_FIELD_ATTR}="${CSS.escape(afId)}"]`);
  if (!el || el.tagName.toLowerCase() !== "input" || el.type !== "file") return false;

  const blob = afBase64ToBlob(base64, mimeType);
  const file = new File([blob], fileName, { type: mimeType });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  el.files = dataTransfer.files;

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

if (typeof self !== "undefined") {
  self.afCollectFields = afCollectFields;
  self.afApplyValues = afApplyValues;
  self.afIsEssayQuestion = afIsEssayQuestion;
  self.afPlaceFile = afPlaceFile;
}
