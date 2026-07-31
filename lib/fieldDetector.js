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

/** Validation / helper copy that must not become the field's primary label. */
function afLooksLikeValidationOrHelperText(text) {
  const t = afNormalizeLabelText(text);
  if (!t) return true;
  // join.com / Chakra: "Please enter the answer", "This field is required", etc.
  if (
    /^(please\s+)?(enter|fill|provide|select|choose)\b/i.test(t) ||
    /\b(required|invalid|must\s+be|cannot\s+be|can'?t\s+be|is\s+required)\b/i.test(t) ||
    /^(error|fehler|обязательн|введите|заполните)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Strip validation / error chrome from a cloned container before reading text.
 * join.com puts "Please enter the answer" next to the control; that must not win over <h2>.
 */
function afStripNonLabelChrome(root) {
  if (!root || !root.querySelectorAll) return;
  root
    .querySelectorAll(
      [
        "input",
        "select",
        "textarea",
        "button",
        "svg",
        "script",
        "style",
        '[data-testid="FormError"]',
        '[data-part="error-text"]',
        '[data-part="helper-text"]',
        ".chakra-field__errorText",
        ".chakra-form__error-message",
        '[role="alert"]',
      ].join(", ")
    )
    .forEach((n) => n.remove());
}

/**
 * Collect human-readable label/context for a field.
 * Handles common job-app patterns where <label> is a sibling of a wrapper
 * (not for= linked), e.g.:
 *   <div><label>Resume / Dossier</label><div><input type=file></div></div>
 * Also join.com screening steps:
 *   <div><h2>LinkedIn Profile URL</h2><div><textarea></textarea><span>Please enter…</span></div></div>
 *
 * Priority: for=/wrapping/aria → explicit <label> near field → heading siblings (h1–h4)
 * → short previous sibling → parent container text (errors stripped).
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

  // Walk up: prefer real <label>/headings, then short previous siblings, then parent text.
  let node = el;
  for (let depth = 0; depth < 5 && node; depth += 1) {
    const parent = node.parentElement;

    // 1) Previous sibling that is a <label> or heading (join.com uses <h2> as the question title)
    let prev = node.previousElementSibling;
    let hops = 0;
    while (prev && hops < 4) {
      const tag = prev.tagName ? prev.tagName.toLowerCase() : "";
      if (tag === "label" || tag === "legend" || /^h[1-4]$/.test(tag)) {
        const text = afNormalizeLabelText(prev.textContent);
        if (text && text.length < 300 && !afLooksLikeValidationOrHelperText(text)) return text;
      }
      prev = prev.previousElementSibling;
      hops += 1;
    }

    if (parent) {
      // 2) Direct child <label> / heading of the field group (not wrapping the control)
      const strongKids = parent.querySelectorAll(":scope > label, :scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4");
      for (const child of strongKids) {
        if (child.contains(el)) continue;
        const t = afNormalizeLabelText(child.textContent);
        if (t && t.length < 300 && !afLooksLikeValidationOrHelperText(t)) return t;
      }

      // 3) Previous non-label siblings (e.g. <span>Full name</span>) — keep as weak fallback
      prev = node.previousElementSibling;
      hops = 0;
      while (prev && hops < 3) {
        if (prev.matches && prev.matches("span, p, div")) {
          // Skip large wrapper divs that contain the control itself.
          if (!prev.contains(el)) {
            const text = afNormalizeLabelText(prev.textContent);
            if (
              text &&
              text.length > 0 &&
              text.length < 120 &&
              !fallback &&
              !afLooksLikeValidationOrHelperText(text)
            ) {
              fallback = text;
            }
          }
        }
        prev = prev.previousElementSibling;
        hops += 1;
      }

      // 4) Parent text without controls / error chrome — only as last-resort fallback
      if (!fallback) {
        const clone = parent.cloneNode(true);
        afStripNonLabelChrome(clone);
        const parentText = afNormalizeLabelText(clone.textContent);
        if (
          parentText &&
          parentText.length > 0 &&
          parentText.length < 200 &&
          !afLooksLikeValidationOrHelperText(parentText)
        ) {
          fallback = parentText;
        }
      }
    }

    node = parent;
  }

  return fallback;
}

/**
 * Local context for resume-upload heuristics — stays on the field's own control group.
 * Do NOT walk the whole form: sibling "Upload CV" + privacy policy text used to make
 * "Additional files" look like a resume field (Teamtailor, etc.).
 */
function afCollectNearbyFieldText(el) {
  const chunks = [];
  const push = (t) => {
    const n = afNormalizeLabelText(t);
    // Cap each chunk so Dropzone translation JSON / huge containers cannot dominate.
    if (n) chunks.push(n.length > 240 ? n.slice(0, 240) : n);
  };

  push(el.name);
  push(el.id);
  push(el.getAttribute("aria-label"));
  push(el.getAttribute("placeholder"));
  push(el.getAttribute("title"));
  push(el.getAttribute("accept"));
  push(afFindLabelText(el));

  let node = el;
  for (let depth = 0; depth < 4 && node; depth += 1) {
    const parent = node.parentElement;
    if (!parent) break;

    // Stop before form / page-wide wrappers so we never inherit sibling upload labels.
    const parentTag = parent.tagName ? parent.tagName.toLowerCase() : "";
    if (parentTag === "form" || parentTag === "body" || parentTag === "main") break;
    if (parent.getAttribute && parent.getAttribute("data-careersite--form-target") === "formContent") break;

    // Direct label-like children only (not full parent subtree — avoids sibling fields).
    parent.querySelectorAll(":scope > label, :scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > span, :scope > p").forEach((child) => {
      if (child.contains(el) && child !== el) return;
      push(child.textContent);
    });

    // Short previous-sibling heading/label (common: <label> then dropzone wrapper).
    let prev = node.previousElementSibling;
    let hops = 0;
    while (prev && hops < 2) {
      const tag = prev.tagName ? prev.tagName.toLowerCase() : "";
      if (tag === "label" || tag === "legend" || /^h[1-4]$/.test(tag) || tag === "span" || tag === "p") {
        push(prev.textContent);
      }
      prev = prev.previousElementSibling;
      hops += 1;
    }

    // Local dropzone chrome only (visible short text on this group), not the entire form.
    if (depth <= 2) {
      const clone = parent.cloneNode(true);
      // Drop nested upload groups / other questions so we stay local.
      clone.querySelectorAll("input, select, textarea, button, svg, script, style, template, dialog").forEach((n) => n.remove());
      const localText = afNormalizeLabelText(clone.textContent);
      if (localText && localText.length < 280) push(localText);
    }

    node = parent;
  }

  return chunks.join(" ");
}

/** Primary identity of a file field (id/name/label) — highest trust for resume vs not. */
function afFileFieldPrimaryText(el) {
  return afNormalizeLabelText(
    [el.name || "", el.id || "", el.getAttribute("aria-label") || "", afFindLabelText(el) || ""].join(" ")
  );
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

// Primary resume/CV wording only — NOT cover letter / additional attachments.
// Note: "cv" is matched as a whole word to avoid false positives (e.g. "canvas").
const AF_RESUME_PHRASES = [
  "resume",
  "curriculum vitae",
  "curriculum",
  "dossier",
  "резюме",
  "lebenslauf",
  "cv upload",
  "upload cv",
  "upload resume",
  "attach resume",
  "attach cv",
  "upload your resume",
  "upload your cv",
  "your resume",
  "your cv",
];

// File fields that must NEVER receive the auto-placed CV (Teamtailor "Additional files", etc.).
const AF_NON_RESUME_FILE_PHRASES = [
  "additional file",
  "additional files",
  "additional document",
  "additional documents",
  "other file",
  "other files",
  "other document",
  "other attachment",
  "other attachments",
  "supporting file",
  "supporting document",
  "supporting documents",
  "supporting material",
  "extra file",
  "extra files",
  "extra document",
  "optional file",
  "optional files",
  "optional document",
  "optional attachment",
  "cover letter",
  "cover note",
  "motivation letter",
  "motivational letter",
  "writing sample",
  "work sample",
  "work samples",
  "portfolio",
  "transcript",
  "certificate",
  "certificates",
  "recommendation",
  "reference letter",
  "references",
  "photo",
  "headshot",
  "portrait",
  "avatar",
  "profile picture",
  "profile photo",
  "logo",
];

function afHaystackMentionsResume(haystack) {
  const lower = (haystack || "").toLowerCase();
  if (!lower) return false;
  if (AF_RESUME_PHRASES.some((kw) => lower.includes(kw))) return true;
  // Whole-word "cv" (label "Resume / CV", "CV*", "Upload CV", id candidate_resume… with nearby CV).
  if (/(^|[^a-z])cv([^a-z]|$)/i.test(lower)) return true;
  // id/name patterns: resume_remote_url, candidate_resume, resumeFile
  if (/(^|[^a-z])resume([^a-z]|$)/i.test(lower)) return true;
  return false;
}

function afHaystackMentionsNonResumeFile(haystack) {
  const lower = (haystack || "").toLowerCase();
  if (!lower) return false;
  if (AF_NON_RESUME_FILE_PHRASES.some((kw) => lower.includes(kw))) return true;
  // id/name: file_remote_url, additional_files, cover_letter_file, attachments
  if (/(additional|other|supporting|optional).{0,12}(file|doc|attach)/i.test(lower)) return true;
  if (/(^|[^a-z])(attachments?|cover_?letter|motivation_?letter)([^a-z]|$)/i.test(lower)) return true;
  // Teamtailor: candidate_file_remote_url (not resume_remote_url)
  if (/file_remote_url|files_remote_url|uploads_attributes/i.test(lower) && !/resume/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * True only for the main resume/CV file input — not "Additional files", cover letter files, etc.
 * Auto-fill places the saved CV only into these fields.
 */
function afIsResumeUploadField(el) {
  if (el.tagName.toLowerCase() !== "input" || el.type !== "file") return false;
  if (el.disabled) return false;

  const accept = (el.getAttribute("accept") || "").toLowerCase();
  // Reject clearly non-document uploads (images/video/audio only).
  if (
    accept &&
    !accept.includes("pdf") &&
    !accept.includes("doc") &&
    !accept.includes("application") &&
    !accept.includes(".pdf") &&
    !accept.includes(".doc") &&
    !accept.includes("*") &&
    !accept.includes("text")
  ) {
    if (/image|video|audio|camera/.test(accept) && !/pdf|doc|msword|officedocument/.test(accept)) {
      return false;
    }
  }

  const primary = afFileFieldPrimaryText(el).toLowerCase();
  const nearby = afCollectNearbyFieldText(el).toLowerCase();

  // Hard reject: labeled/named as additional/cover/portfolio/etc. — never dump CV there.
  if (afHaystackMentionsNonResumeFile(primary)) return false;
  // If primary is empty-ish but nearby label on the same group says "Additional files".
  if (afHaystackMentionsNonResumeFile(nearby) && !afHaystackMentionsResume(primary)) return false;

  // Hard accept: id/name/label clearly resume/CV (e.g. Upload CV, candidate_resume_remote_url).
  if (afHaystackMentionsResume(primary)) return true;

  // Nearby-only resume wording (e.g. unlabeled input under "Resume / Dossier") — still accept,
  // but only if we did not already hard-reject non-resume primary.
  if (afHaystackMentionsResume(nearby)) return true;

  // Unlabeled doc dropzone: only if accept is explicitly document-like AND chrome says upload.
  // Empty accept + generic "Drop your file" is NOT enough (Teamtailor Additional files).
  const acceptLooksLikeDoc =
    accept.includes("pdf") ||
    accept.includes("doc") ||
    accept.includes("msword") ||
    accept.includes("officedocument");
  const looksLikeDocDropzone =
    acceptLooksLikeDoc &&
    (nearby.includes("upload") || nearby.includes("attach") || nearby.includes("drop") || nearby.includes("browse"));
  if (looksLikeDocDropzone && !afHaystackMentionsNonResumeFile(nearby)) return true;

  // Accept alone is too weak when multiple file inputs exist on careers forms.
  // Only treat accept-only as resume if this is the sole file input on the page.
  if (acceptLooksLikeDoc) {
    const allFiles = document.querySelectorAll('input[type="file"]');
    if (allFiles.length === 1) return true;
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
    const primary = afFileFieldPrimaryText(el);
    results.push({
      afId: id,
      tag: "input",
      type: "file",
      name: el.name || "",
      id: el.id || "",
      label,
      accept: el.getAttribute("accept") || "",
      // Strong when id/name/label itself says resume/CV.
      confidence: afHaystackMentionsResume(primary) ? "high" : "medium",
    });
  });

  // If we found at least one high-confidence resume field, drop weaker generic dropzones
  // so CV is not also placed into ambiguous second slots.
  const high = results.filter((r) => r.confidence === "high");
  if (high.length > 0) return high;
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
