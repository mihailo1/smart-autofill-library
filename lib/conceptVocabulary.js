// Shared dictionary of field "concepts" — used in content-script (for guessing field concepts
// on the page via rules) and in popup (for matching against library and field labeling).
// Works as a regular script (not ES module), so it just declares global functions/objects.

// priority: higher wins when several keywords match the same field.
// Platform-specific (linkedin/github) must beat generic (portfolio/website).
const AF_CONCEPTS = [
  { key: "email", label: "Email", autocomplete: ["email"], keywords: ["email", "e-mail", "почта", "e mail"], priority: 80 },
  { key: "firstName", label: "First name", autocomplete: ["given-name"], keywords: ["firstname", "first name", "first_name", "fname", "given name", "имя", "givenname"], priority: 70 },
  { key: "lastName", label: "Last name", autocomplete: ["family-name"], keywords: ["lastname", "last name", "last_name", "lname", "surname", "фамилия", "familyname"], priority: 70 },
  { key: "middleName", label: "Middle name", autocomplete: ["additional-name"], keywords: ["middlename", "middle name", "middle_name", "отчество", "patronymic"], priority: 70 },
  { key: "fullName", label: "Full name", autocomplete: ["name"], keywords: ["fullname", "full name", "full_name", "your name", "yourname", "полное имя", "фио"], priority: 65 },
  { key: "phone", label: "Phone", autocomplete: ["tel"], keywords: ["phone", "telephone", "mobile", "телефон", "cell phone", "cellphone"], priority: 80 },
  { key: "company", label: "Company", autocomplete: ["organization"], keywords: ["company", "organization", "org name", "компания", "организация"], priority: 60 },
  { key: "jobTitle", label: "Job title", autocomplete: ["organization-title"], keywords: ["job title", "jobtitle", "position", "должность", "role title"], priority: 60 },
  // Social / links — specific before generic
  { key: "linkedin", label: "LinkedIn", autocomplete: [], keywords: ["linkedin", "linked-in", "linked in"], priority: 100 },
  { key: "github", label: "GitHub", autocomplete: [], keywords: ["github", "git hub", "gitlab"], priority: 100 },
  { key: "twitter", label: "Twitter / X", autocomplete: [], keywords: ["twitter", "x.com", "x handle"], priority: 100 },
  { key: "portfolio", label: "Portfolio", autocomplete: [], keywords: ["portfolio", "personal site", "personal website", "behance", "dribbble"], priority: 55 },
  // Do NOT use bare "url" — it matches inside "portfolio url", "linkedin url", etc.
  { key: "website", label: "Website", autocomplete: ["url"], keywords: ["website", "web site", "homepage", "home page", "сайт", "web page", "webpage"], priority: 40 },
  { key: "username", label: "Username", autocomplete: ["username"], keywords: ["username", "user name", "login", "user_name", "логин", "никнейм", "nickname"], priority: 50 },
  { key: "addressLine1", label: "Address line 1", autocomplete: ["address-line1"], keywords: ["address1", "address line 1", "address_line1", "street", "адрес", "улица"], priority: 60 },
  { key: "addressLine2", label: "Address line 2", autocomplete: ["address-line2"], keywords: ["address2", "address line 2", "address_line2", "apt", "suite", "квартира"], priority: 60 },
  { key: "city", label: "City", autocomplete: ["address-level2"], keywords: ["city", "town", "город"], priority: 60 },
  { key: "state", label: "State / Region", autocomplete: ["address-level1"], keywords: ["state", "region", "province", "область", "регион"], priority: 60 },
  { key: "zip", label: "ZIP / Postal code", autocomplete: ["postal-code"], keywords: ["zip", "postal", "postcode", "postal code", "индекс"], priority: 60 },
  { key: "country", label: "Country", autocomplete: ["country", "country-name"], keywords: ["country", "страна"], priority: 60 },
  { key: "birthDate", label: "Date of birth", autocomplete: ["bday"], keywords: ["birthdate", "birth date", "birthday", "date of birth", "dob", "дата рождения"], priority: 70 },
  { key: "gender", label: "Gender", autocomplete: ["sex"], keywords: ["gender", "sex", "пол"], priority: 70 },
];

// Concepts that are short profile/link fields — never auto-apply these to essay textareas.
const AF_PROFILE_LINK_CONCEPTS = new Set([
  "email",
  "phone",
  "linkedin",
  "github",
  "twitter",
  "portfolio",
  "website",
  "username",
  "firstName",
  "lastName",
  "middleName",
  "fullName",
  "company",
  "jobTitle",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "zip",
  "country",
  "birthDate",
  "gender",
]);

/**
 * Build haystack for concept guessing.
 * Truncate long name/id (Ashby consent checkboxes put a full legal paragraph in name=)
 * so keywords like "state" cannot match inside "stated preferences".
 */
function afFieldHaystackRaw(fieldMeta) {
  const clip = (s, max) => {
    const t = String(s || "").trim();
    if (!t) return "";
    return t.length > max ? t.slice(0, max) : t;
  };
  // Prefer human labels; keep name/id short (real field ids are short; legal text is not).
  return [fieldMeta.label, fieldMeta.ariaLabel, fieldMeta.placeholder, clip(fieldMeta.name, 64), clip(fieldMeta.id, 64)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function afFieldHaystackCompact(raw) {
  return String(raw || "").replace(/[^a-zа-яё0-9]+/gi, "");
}

/**
 * True if keyword appears in field text.
 * Always uses word boundaries on the raw haystack so "state" ≠ "stated",
 * "name" ≠ random prose, "cv" ≠ "canvas".
 * Compact substring match only for short machine-ish ids (no long sentences).
 */
function afKeywordMatches(rawHaystack, compactHaystack, keyword) {
  const kw = String(keyword || "").toLowerCase().trim();
  if (!kw) return false;
  const compactKw = kw.replace(/[^a-zа-яё0-9]+/gi, "");
  if (!compactKw) return false;

  // Multi-word: prefer exact phrase on raw.
  if (kw.includes(" ")) {
    if (rawHaystack.includes(kw)) return true;
    return compactHaystack.includes(compactKw);
  }

  const escaped = compactKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-zа-яё0-9])${escaped}([^a-zа-яё0-9]|$)`, "i");
  if (re.test(rawHaystack)) return true;

  // Compact fallback only for short field names/ids (firstname, systemfield_email).
  // Never on long prose — that caused "state" ⊂ "stated".
  if (rawHaystack.length <= 72 && rawHaystack.split(/\s+/).length <= 6) {
    return compactHaystack.includes(compactKw) && (
      compactHaystack === compactKw ||
      compactHaystack.startsWith(`${compactKw}`) ||
      // snake/camel-ish: allow keyword as a segment via re on spaced form of compact
      re.test(rawHaystack)
    );
  }
  return false;
}

// Match by autocomplete attribute first, then by longest/highest-priority keywords.
// Returns { key, confidence } or null.
function afGuessConcept(fieldMeta) {
  const autocomplete = (fieldMeta.autocomplete || "").toLowerCase().trim();
  if (autocomplete) {
    const lastToken = autocomplete.split(/\s+/).pop();
    const byAutocomplete = AF_CONCEPTS.find((c) => (c.autocomplete || []).includes(lastToken));
    if (byAutocomplete) {
      // Still allow a stronger keyword (e.g. linkedin) to override generic url autocomplete.
      const keywordGuess = afGuessConceptByKeywords(fieldMeta);
      if (keywordGuess && (keywordGuess.priority || 0) > (byAutocomplete.priority || 0)) {
        return { key: keywordGuess.key, confidence: keywordGuess.confidence };
      }
      return { key: byAutocomplete.key, confidence: 0.95 };
    }
  }

  const keywordGuess = afGuessConceptByKeywords(fieldMeta);
  if (keywordGuess) return { key: keywordGuess.key, confidence: keywordGuess.confidence };

  // Weak type-only hints (never beat explicit keywords).
  const type = (fieldMeta.type || "").toLowerCase();
  if (type === "email") return { key: "email", confidence: 0.75 };
  if (type === "tel") return { key: "phone", confidence: 0.75 };
  // type=url alone is too weak — LinkedIn/Portfolio/GitHub fields are often type=url.
  return null;
}

function afGuessConceptByKeywords(fieldMeta) {
  const raw = afFieldHaystackRaw(fieldMeta);
  const compact = afFieldHaystackCompact(raw);
  if (!raw && !compact) return null;

  let best = null;
  for (const concept of AF_CONCEPTS) {
    for (const kw of concept.keywords) {
      if (!afKeywordMatches(raw, compact, kw)) continue;
      const compactKw = kw.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "");
      const score = compactKw.length * 2 + (concept.priority || 0);
      const confidence = Math.min(0.95, 0.55 + compactKw.length / 40 + (concept.priority || 0) / 400);
      if (!best || score > best.score) {
        best = { key: concept.key, confidence, score, priority: concept.priority || 0 };
      }
    }
  }
  return best;
}

function afConceptLabel(key) {
  const found = AF_CONCEPTS.find((c) => c.key === key);
  return found ? found.label : key;
}

function afIsProfileLinkConcept(key) {
  return AF_PROFILE_LINK_CONCEPTS.has(key);
}

/** Library values that look like URLs/handles — must not fill essay textareas. */
function afValueLooksLikeUrlOrHandle(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^(www\.)[\w.-]+\.\w{2,}/i.test(v)) return true;
  if (/^(linkedin\.com|github\.com|gitlab\.com|twitter\.com|x\.com)\//i.test(v)) return true;
  // Single short token that looks like a social path / handle, not a sentence.
  if (v.length < 80 && !/\s/.test(v) && /[\w.-]+\.(com|io|dev|org|net|me|co)\b/i.test(v)) return true;
  return false;
}

// Export to global scope (for content-script) and, if module environment exists,
// also via self/globalThis for background service worker.
if (typeof self !== "undefined") {
  self.AF_CONCEPTS = AF_CONCEPTS;
  self.AF_PROFILE_LINK_CONCEPTS = AF_PROFILE_LINK_CONCEPTS;
  self.afGuessConcept = afGuessConcept;
  self.afConceptLabel = afConceptLabel;
  self.afIsProfileLinkConcept = afIsProfileLinkConcept;
  self.afValueLooksLikeUrlOrHandle = afValueLooksLikeUrlOrHandle;
}
