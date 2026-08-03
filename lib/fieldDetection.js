// Field detection (content-script context). Pure-ish DOM reads + tagging:
// scan fields, labels, essay/resume heuristics. Does NOT apply values or place files
// (see fieldActions.js). Safe to unit-test label/essay/resume helpers with fixtures.

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
  // ATS hooks (Ashby/Greenhouse-style) often put the concept on a wrapper, not the input
  push(el.getAttribute("data-field-path"));
  push(el.getAttribute("data-testid"));
  push(el.getAttribute("data-qa"));

  let node = el;
  for (let depth = 0; depth < 4 && node; depth += 1) {
    const parent = node.parentElement;
    if (!parent) break;

    // Stop before form / page-wide wrappers so we never inherit sibling upload labels.
    const parentTag = parent.tagName ? parent.tagName.toLowerCase() : "";
    if (parentTag === "form" || parentTag === "body" || parentTag === "main") break;
    if (parent.getAttribute && parent.getAttribute("data-careersite--form-target") === "formContent") break;

    push(parent.getAttribute && parent.getAttribute("data-field-path"));
    push(parent.id);
    push(parent.getAttribute && parent.getAttribute("data-testid"));

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
    [
      el.name || "",
      el.id || "",
      el.getAttribute("aria-label") || "",
      el.getAttribute("data-field-path") || "",
      afFindLabelText(el) || "",
    ].join(" ")
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
  // id/name patterns: resume_remote_url, candidate_resume, resumeFile, _systemfield_resume
  if (/(^|[^a-z])resume([^a-z]|$)/i.test(lower)) return true;
  if (/systemfield[_\s-]*resume|resume[_\s-]*remote|resume[_\s-]*upload|resume[_\s-]*file/i.test(lower)) {
    return true;
  }
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
 * File inputs are often sr-only / clip / 1×1 / opacity-0 overlays.
 * Accept if the control OR any ancestor (up to 6) has a layout box.
 */
function afFileInputIsPlausiblyVisible(el) {
  if (!el) return false;
  let node = el;
  for (let i = 0; i < 6 && node; i += 1) {
    try {
      if (node.getClientRects && node.getClientRects().length > 0) return true;
    } catch (_) {
      /* ignore */
    }
    // offsetParent null can mean fixed/body — still check size
    if (node.offsetWidth > 0 || node.offsetHeight > 0) return true;
    node = node.parentElement;
  }
  // Last resort: connected to document and not display:none on self
  try {
    const style = window.getComputedStyle(el);
    if (style && style.display !== "none" && style.visibility !== "hidden") {
      // Hidden 1px inputs used by Ashby/Dropzone still count if in the live document
      return el.isConnected;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

/**
 * True only for the main resume/CV file input — not "Additional files", cover letter files, etc.
 * Auto-fill places the saved CV only into these fields.
 */
function afIsResumeUploadField(el) {
  if (el.tagName.toLowerCase() !== "input" || el.type !== "file") return false;
  // Keep disabled inputs out of auto-place (can't set files), but note: some sites
  // leave the real control enabled while chrome is disabled — only skip true disabled.
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
  const hasResume = afHaystackMentionsResume(primary) || afHaystackMentionsResume(nearby);
  const hasNonResumePrimary = afHaystackMentionsNonResumeFile(primary);
  const hasNonResumeNearby = afHaystackMentionsNonResumeFile(nearby);

  // Resume/CV wording always wins over generic "uploads_attributes" / file_remote_url noise.
  // (Rails/Teamtailor often put uploads_attributes in name even on the real Resume field.)
  if (hasResume) {
    // Explicit "Additional files" / "Cover letter" primary label without resume → still reject.
    if (hasNonResumePrimary && !afHaystackMentionsResume(primary)) return false;
    return true;
  }

  // No resume signal: hard-reject additional/cover/portfolio/etc.
  if (hasNonResumePrimary || hasNonResumeNearby) return false;

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
  if (looksLikeDocDropzone) return true;

  // Accept alone is too weak when multiple file inputs exist on careers forms.
  // Only treat accept-only as resume if this is the sole file input on the page.
  if (acceptLooksLikeDoc) {
    const allFiles = document.querySelectorAll('input[type="file"]');
    if (allFiles.length === 1) return true;
  }

  return false;
}

/**
 * Form.io / Sourceflow and similar: no input[type=file] until user clicks browse.
 * They render a dropzone (ref=fileDrop / .fileSelector) + label "CV/Resume".
 */
function afIsResumeDropzoneRoot(el) {
  if (!el || el.nodeType !== 1) return false;
  // Prefer the component wrapper, not nested children we already covered.
  const cls = String(el.className || "");
  const ref = el.getAttribute("ref") || "";
  const isFileComponent =
    /\bformio-component-file\b|\bformio-component-cv\b/i.test(cls) ||
    ref === "fileDrop" ||
    /\bfileSelector\b/i.test(cls) ||
    el.getAttribute("data-testid") === "file-drop" ||
    el.getAttribute("data-qa") === "file-drop";
  if (!isFileComponent) return false;

  // Skip pure drop-surface if a parent formio file component will be preferred.
  if ((ref === "fileDrop" || /\bfileSelector\b/i.test(cls)) && el.closest(".formio-component-file, .formio-component-cv")) {
    // Use the outer component as the root when available.
    return /\bformio-component-file\b|\bformio-component-cv\b/i.test(cls);
  }

  const blob = [
    el.id,
    el.className,
    el.getAttribute("data-key"),
    el.getAttribute("data-field-path"),
    afFindLabelText(el),
    el.textContent ? el.textContent.slice(0, 200) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (afHaystackMentionsNonResumeFile(blob) && !afHaystackMentionsResume(blob)) return false;
  // formio-component-cv, CV/Resume label, "Browse to attach file for CV/Resume"
  if (afHaystackMentionsResume(blob)) return true;
  if (/\bformio-component-cv\b/i.test(cls)) return true;
  // Generic formio file component with drop/browse chrome is often the resume slot on job forms
  if (/\bformio-component-file\b/i.test(cls) && (blob.includes("drop") || blob.includes("browse") || blob.includes("attach"))) {
    // Only if single file component on page or resume-ish text
    return true;
  }
  return false;
}

function afFindResumeDropzoneRoots() {
  const selectors = [
    ".formio-component-file",
    ".formio-component-cv",
    '[ref="fileDrop"]',
    ".fileSelector",
    '[class*="fileSelector"]',
    '[data-testid*="file-drop" i]',
    '[data-qa*="file-drop" i]',
  ];
  const seen = new Set();
  const roots = [];
  selectors.forEach((sel) => {
    let list;
    try {
      list = document.querySelectorAll(sel);
    } catch (_) {
      return;
    }
    list.forEach((el) => {
      // Prefer outer formio component over inner fileDrop
      let root = el;
      const outer = el.closest(".formio-component-file, .formio-component-cv");
      if (outer) root = outer;
      if (seen.has(root)) return;
      if (!afIsResumeDropzoneRoot(root) && !afIsResumeDropzoneRoot(el)) return;
      // If outer wasn't resume but el is fileDrop with resume text, use outer if present
      if (outer && afHaystackMentionsResume(
        [outer.className, outer.textContent ? outer.textContent.slice(0, 240) : ""].join(" ")
      )) {
        root = outer;
      } else if (!afIsResumeDropzoneRoot(root) && afIsResumeDropzoneRoot(el)) {
        root = el;
      } else if (!afIsResumeDropzoneRoot(root)) {
        return;
      }
      if (seen.has(root)) return;
      seen.add(root);
      roots.push(root);
    });
  });
  return roots;
}

function afFindResumeUploadFields() {
  const results = [];
  const seenEls = new Set();

  // 1) Classic file inputs
  document.querySelectorAll('input[type="file"]').forEach((el) => {
    const idNameBlob = `${el.id || ""} ${el.name || ""} ${el.getAttribute("data-field-path") || ""}`;
    const idNameResume = afHaystackMentionsResume(idNameBlob);

    if (!afIsResumeUploadField(el) && !idNameResume) return;
    const primary = afFileFieldPrimaryText(el);
    if (
      afHaystackMentionsNonResumeFile(primary) &&
      !afHaystackMentionsResume(primary) &&
      !idNameResume
    ) {
      return;
    }
    if (!idNameResume && !afFileInputIsPlausiblyVisible(el)) return;

    seenEls.add(el);
    const id = afEnsureFieldId(el);
    const nearby = afCollectNearbyFieldText(el);
    const label = afFindLabelText(el) || nearby.slice(0, 120);
    const high = idNameResume || afHaystackMentionsResume(primary);
    results.push({
      afId: id,
      tag: "input",
      type: "file",
      kind: "file-input",
      name: el.name || "",
      id: el.id || "",
      label,
      accept: el.getAttribute("accept") || "",
      confidence: high ? "high" : afHaystackMentionsResume(nearby) ? "medium" : "low",
    });
  });

  // 2) Form.io / Sourceflow dropzones without a file input in the DOM
  afFindResumeDropzoneRoots().forEach((root) => {
    if (seenEls.has(root)) return;
    // Skip if this component already contains a detected file input
    const innerFile = root.querySelector('input[type="file"]');
    if (innerFile && seenEls.has(innerFile)) return;

    const blob = [
      root.id,
      root.className,
      root.getAttribute("data-key"),
      afFindLabelText(root),
      root.textContent ? root.textContent.slice(0, 240) : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (afHaystackMentionsNonResumeFile(blob) && !afHaystackMentionsResume(blob)) return;

    // Mark the drop surface (or root) so place can find it
    let target =
      root.querySelector('[ref="fileDrop"], .fileSelector, [class*="fileSelector"]') || root;
    const id = afEnsureFieldId(target);
    // Also stamp root for debugging
    if (target !== root && !root.getAttribute(AF_FIELD_ATTR)) {
      root.setAttribute("data-af-dropzone-for", id);
    }
    target.setAttribute("data-af-kind", "dropzone");

    const label =
      afFindLabelText(root) ||
      afNormalizeLabelText(
        (root.querySelector("label") && root.querySelector("label").textContent) || ""
      ) ||
      blob.slice(0, 80);
    const high = afHaystackMentionsResume(blob) || /\bformio-component-cv\b/i.test(String(root.className));
    results.push({
      afId: id,
      tag: target.tagName.toLowerCase(),
      type: "file",
      kind: "dropzone",
      name: "",
      id: target.id || root.id || "",
      label,
      accept: "",
      confidence: high ? "high" : "medium",
    });
    seenEls.add(root);
    seenEls.add(target);
  });

  const high = results.filter((r) => r.confidence === "high");
  if (high.length > 0) return high;
  const medium = results.filter((r) => r.confidence === "medium");
  if (medium.length > 0) return medium;
  if (results.length === 1) return results;
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

if (typeof self !== "undefined") {
  self.AF_FIELD_ATTR = AF_FIELD_ATTR;
  self.afIsEligibleField = afIsEligibleField;
  self.afNormalizeLabelText = afNormalizeLabelText;
  self.afFindLabelText = afFindLabelText;
  self.afCollectNearbyFieldText = afCollectNearbyFieldText;
  self.afIsEssayQuestion = afIsEssayQuestion;
  self.afIsResumeUploadField = afIsResumeUploadField;
  self.afFindResumeUploadFields = afFindResumeUploadFields;
  self.afEnsureFieldId = afEnsureFieldId;
  self.afCollectFields = afCollectFields;
}
