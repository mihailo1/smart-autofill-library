// Runs in the content-script context on the actual page. Responsible for:
// 1) Scanning form fields (input/select/textarea, excluding password/hidden/disabled)
// 2) Collecting field metadata (name/id/label/placeholder/autocomplete) + concept guessing
// 3) Applying values (autofill) with input/change event dispatch

const AF_FIELD_ATTR = "data-af-id";
let afFieldCounter = 0;

function afIsEligibleField(el) {
  if (el.disabled || el.readOnly) return false;
  if (el.type === "password" || el.type === "hidden" || el.type === "submit" || el.type === "button" || el.type === "reset" || el.type === "file") return false;
  const rects = el.getClientRects();
  if (rects.length === 0) return false; // hidden via display:none/visibility
  return true;
}

function afNormalizeLabelText(text) {
  if (!text) return "";
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * Collect human-readable label/context for a field.
 * Handles common job-app patterns where <label> is a sibling of a wrapper
 * (not for= linked), e.g.:
 *   <div><label>Resume / Dossier</label><div><input type=file></div></div>
 *
 * Priority: for=/wrapping/aria → explicit <label> near field → short previous sibling
 * → parent container text. Prefer real labels over dropzone chrome ("UPLOAD PDF…").
 */
function afFindLabelText(el) {
  if (el.id) {
    try {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) {
        const t = afNormalizeLabelText(forLabel.textContent);
        if (t) return t;
      }
    } catch (_) {
      /* invalid id for CSS.escape edge cases */
    }
  }
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) {
    const clone = wrappingLabel.cloneNode(true);
    clone.querySelectorAll("input, select, textarea, button").forEach((n) => n.remove());
    const t = afNormalizeLabelText(clone.textContent);
    if (t) return t;
  }

  const ariaLabelledBy = el.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    const parts = ariaLabelledBy.split(/\s+/).map((id) => {
      const refEl = document.getElementById(id);
      return refEl ? afNormalizeLabelText(refEl.textContent) : "";
    });
    const joined = parts.filter(Boolean).join(" ");
    if (joined) return joined;
  }

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return afNormalizeLabelText(ariaLabel);

  let fallback = "";

  // Walk up: prefer real <label> nodes, then short previous siblings, then parent text.
  let node = el;
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const parent = node.parentElement;

    // 1) Previous sibling that is a <label>
    let prev = node.previousElementSibling;
    let hops = 0;
    while (prev && hops < 4) {
      if (prev.tagName && prev.tagName.toLowerCase() === "label") {
        const text = afNormalizeLabelText(prev.textContent);
        if (text && text.length < 300) return text;
      }
      prev = prev.previousElementSibling;
      hops += 1;
    }

    if (parent) {
      // 2) Direct child <label> of the field group (not wrapping the control)
      const childLabels = parent.querySelectorAll(":scope > label");
      for (const childLabel of childLabels) {
        if (childLabel.contains(el)) continue;
        const t = afNormalizeLabelText(childLabel.textContent);
        if (t && t.length < 300) return t;
      }

      // 3) Previous non-label siblings (e.g. <span>Full name</span>) — keep as weak fallback
      prev = node.previousElementSibling;
      hops = 0;
      while (prev && hops < 3) {
        if (prev.matches && prev.matches("span, p, h1, h2, h3, h4, legend, div")) {
          // Skip large wrapper divs that contain the control itself.
          if (!prev.contains(el)) {
            const text = afNormalizeLabelText(prev.textContent);
            if (text && text.length > 0 && text.length < 120 && !fallback) {
              fallback = text;
            }
          }
        }
        prev = prev.previousElementSibling;
        hops += 1;
      }

      // 4) Parent text without controls — only as last-resort fallback
      if (!fallback) {
        const clone = parent.cloneNode(true);
        clone.querySelectorAll("input, select, textarea, button, svg, script, style").forEach((n) => n.remove());
        const parentText = afNormalizeLabelText(clone.textContent);
        if (parentText && parentText.length > 0 && parentText.length < 200) {
          fallback = parentText;
        }
      }
    }

    node = parent;
  }

  return fallback;
}

/**
 * Broader nearby text for heuristics (resume detection), not only the primary label.
 * Includes parent/grandparent text and adjacent labels.
 */
function afCollectNearbyFieldText(el) {
  const chunks = [];
  const push = (t) => {
    const n = afNormalizeLabelText(t);
    if (n) chunks.push(n);
  };

  push(el.name);
  push(el.id);
  push(el.getAttribute("aria-label"));
  push(el.getAttribute("placeholder"));
  push(el.getAttribute("title"));
  push(el.getAttribute("accept"));
  push(afFindLabelText(el));

  let node = el;
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const parent = node.parentElement;
    if (!parent) break;
    // Prefer short label-like children first.
    parent.querySelectorAll(":scope > label, :scope > span, :scope > p").forEach((child) => {
      if (child.contains(el) && child !== el) return;
      push(child.textContent);
    });
    const clone = parent.cloneNode(true);
    clone.querySelectorAll("input, select, textarea, button, svg, script, style").forEach((n) => n.remove());
    push(clone.textContent);
    // Stop early if we already have a clear resume signal.
    const joined = chunks.join(" ").toLowerCase();
    if (/(resume|curriculum|dossier|\bcv\b|резюме)/i.test(joined)) break;
    node = parent;
  }

  return chunks.join(" ");
}

// Heuristic: does this field look like a "complex" job application question (essay answer),
// not a regular short profile field? Such questions are almost always in English and formatted
// as a textarea with a long prompt asking to describe something.
const AF_ESSAY_KEYWORDS = [
  "why do you want",
  "why are you interested",
  "why are you",
  "why us",
  "why should we",
  "why would you",
  "why this",
  "tell us about",
  "tell us more",
  "tell me about",
  "describe a time",
  "describe your",
  "describe yourself",
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
  "the asset",
  "motivation",
  "cover note",
  "in your own words",
  "how would you",
  "what would you",
];

function afIsEssayQuestion(meta) {
  if (meta.tag !== "textarea") return false;
  const text = [meta.label, meta.placeholder, meta.ariaLabel].filter(Boolean).join(" ").trim();
  if (!text) return false;
  const lower = text.toLowerCase();

  // Never treat URL/social link fields as essays even if they use a textarea (rare).
  if (
    /\b(linkedin|github|portfolio|website|url|http)\b/i.test(lower) &&
    !/\b(why|describe|tell us|motivation|cover letter)\b/i.test(lower)
  ) {
    return false;
  }

  const hasQuestionMark = /\?/.test(text);
  const hasKeyword = AF_ESSAY_KEYWORDS.some((kw) => lower.includes(kw));
  // Long prompt on a textarea → essay, but not if it clearly looks like a short "notes" with URL placeholder.
  const isLongPrompt = text.length > 25;
  return hasQuestionMark || hasKeyword || isLongPrompt;
}

// Heuristic: does this file upload field look like a resume/CV upload, not something else
// (photo, separate cover letter file, etc. also qualify as "resume-like").
// Note: "cv" is matched as a whole word to avoid false positives (e.g. "canvas").
const AF_RESUME_PHRASES = [
  "resume",
  "curriculum vitae",
  "curriculum",
  "dossier",
  "резюме",
  "cover letter",
  "lebenslauf",
  "cv upload",
  "upload cv",
  "upload resume",
  "attach resume",
  "attach cv",
  "upload your",
];

function afHaystackMentionsResume(haystack) {
  const lower = (haystack || "").toLowerCase();
  if (!lower) return false;
  if (AF_RESUME_PHRASES.some((kw) => lower.includes(kw))) return true;
  // Whole-word "cv" (label "Resume / CV", "CV*", etc.)
  if (/(^|[^a-z])cv([^a-z]|$)/i.test(lower)) return true;
  return false;
}

function afIsResumeUploadField(el) {
  if (el.tagName.toLowerCase() !== "input" || el.type !== "file") return false;
  if (el.disabled) return false;

  const accept = (el.getAttribute("accept") || "").toLowerCase();
  // Reject clearly non-document uploads (images/video/audio only).
  if (accept && !accept.includes("pdf") && !accept.includes("doc") && !accept.includes("application") && !accept.includes(".pdf") && !accept.includes(".doc") && !accept.includes("*") && !accept.includes("text")) {
    if (/image|video|audio|camera/.test(accept) && !/pdf|doc|msword|officedocument/.test(accept)) {
      return false;
    }
  }

  const nearby = afCollectNearbyFieldText(el);
  const haystack = nearby.toLowerCase();

  // Explicit resume/CV wording in label or nearby UI (e.g. "Resume / Dossier" + "UPLOAD PDF / DOCX").
  if (afHaystackMentionsResume(haystack)) return true;

  // Careers-style dropzones: no name/id, but UI says upload PDF/DOCX.
  const looksLikeDocDropzone =
    (haystack.includes("pdf") || haystack.includes("docx") || haystack.includes("doc")) &&
    (haystack.includes("upload") || haystack.includes("attach") || haystack.includes("drop") || haystack.includes("browse"));
  if (looksLikeDocDropzone) return true;

  // Accept attribute alone strongly suggests document upload on job forms.
  if (accept.includes("pdf") || accept.includes("doc") || accept.includes("msword") || accept.includes("officedocument")) {
    return true;
  }

  return false;
}

function afFindResumeUploadFields() {
  const nodeList = document.querySelectorAll('input[type="file"]');
  const results = [];
  nodeList.forEach((el) => {
    if (!afIsResumeUploadField(el)) return;
    // Opacity-0 overlay file inputs still have layout boxes; skip truly display:none.
    const rects = el.getClientRects();
    if (rects.length === 0) {
      // Still allow if parent group is visible (common absolute inset-0 overlay pattern).
      const parent = el.parentElement;
      if (!parent || parent.getClientRects().length === 0) return;
    }
    const id = afEnsureFieldId(el);
    const label = afFindLabelText(el) || afCollectNearbyFieldText(el).slice(0, 120);
    results.push({
      afId: id,
      tag: "input",
      type: "file",
      name: el.name || "",
      id: el.id || "",
      label,
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

// Reconstructs a File from base64 and places it into input[type=file] via DataTransfer —
// the only reliable way to programmatically "upload" a file to a file input in the browser.
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
